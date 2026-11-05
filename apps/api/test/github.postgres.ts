import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  githubOriginSchema,
  githubPreviewFingerprintInput,
  renderDraftDocument,
} from "@vuzmi/core";
import type { GithubImportInput, GithubPreview } from "@vuzmi/core";
import {
  INDEX_QUEUE,
  KnowledgeError,
  PostgresRunRepository,
  processIndexJob,
  processRunJob,
} from "@vuzmi/runtime";
import type { KnowledgeEmbedder } from "@vuzmi/runtime";

const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL;
const workspace = "local-workspace";
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const embed: KnowledgeEmbedder = async ({ texts }) => ({
  profile: {
    provider: "ollama",
    model: "fixture-embedding",
    digest: "fixture-digest",
    dimensions: 3,
    normalization: "l2",
    version: 1,
    promptVersion: "embeddinggemma-retrieval-v1",
  },
  vectors: texts.map(() => [1, 0, 0]),
});

function preview(): GithubPreview {
  const text =
    "# Vuzmi launch\n\nThe Vuzmi launch requires human review, a rollback plan, and exact retained evidence.";
  const origin = githubOriginSchema.parse({
    kind: "github-public",
    repositoryId: 123456,
    owner: "Ether-X-UK",
    repository: "Vuzmi",
    path: "docs/PRODUCT.md",
    gitHashAlgorithm: "sha1",
    commitOid: "a".repeat(40),
    blobOid: createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0${text}`)
      .digest("hex"),
    rawSha256: sha256(text),
    rawBytes: Buffer.byteLength(text),
    normalizedSha256: sha256(text),
    normalizedBytes: Buffer.byteLength(text),
    normalizationVersion: "plain-text-v1",
    fetchedAt: new Date().toISOString(),
  });
  const value = {
    previewId: randomUUID(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    title: "Reviewed public product brief",
    format: "markdown" as const,
    text,
    origin,
  };
  return {
    ...value,
    fingerprint: sha256(githubPreviewFingerprintInput(value)),
  };
}
function inputFor(value: GithubPreview): GithubImportInput {
  return {
    importId: randomUUID(),
    previewId: value.previewId,
    fingerprint: value.fingerprint,
  };
}
function errorCode(code: string, statusCode = 409) {
  return (error: unknown) =>
    error instanceof KnowledgeError &&
    error.code === code &&
    error.statusCode === statusCode;
}
async function fixture(t: TestContext) {
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `github_test_${suffix}`;
  const queueSchema = `github_queue_${suffix}`;
  const options = { connectionString: databaseUrl!, schema, queueSchema };
  const repositories: PostgresRunRepository[] = [];
  const reconnect = async () => {
    const repository = await PostgresRunRepository.connect(options);
    repositories.push(repository);
    return repository;
  };
  const repository = await reconnect();
  const sql = new Pool({ connectionString: databaseUrl!, max: 2 });
  t.after(async () => {
    for (const value of repositories) await value.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const counts = async () => {
    const result = await sql.query(
      `SELECT
      (SELECT count(*)::integer FROM "${schema}".knowledge_sources) sources,
      (SELECT count(*)::integer FROM "${schema}".source_revisions) revisions,
      (SELECT count(*)::integer FROM "${schema}".github_import_receipts) receipts,
      (SELECT count(*)::integer FROM "${queueSchema}".job WHERE name=$1) jobs`,
      [INDEX_QUEUE],
    );
    return result.rows[0];
  };
  return { repository, reconnect, sql, schema, queueSchema, counts };
}

test(
  "durable public GitHub imports on isolated PostgreSQL",
  { skip: !databaseUrl },
  async (t) => {
    await t.test(
      "v3 upgrades populated v2 without changing either earlier checksum or manual source bytes",
      async (t) => {
        const { repository, reconnect, sql, schema } = await fixture(t);
        const source = await repository.knowledge.createSource(workspace, {
          title: "Legacy manual source",
          format: "text",
          text: "Legacy source bytes survive the append-only migration.",
        });
        const before = await repository.knowledge.getSource(
          workspace,
          source.id,
        );
        const checksums = await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations WHERE version<3 ORDER BY version`,
        );
        await repository.close();
        await sql.query(`DROP TABLE "${schema}".github_import_receipts`);
        await sql.query(
          `ALTER TABLE "${schema}".source_revisions DROP COLUMN origin`,
        );
        await sql.query(
          `DELETE FROM "${schema}".schema_migrations WHERE version=3`,
        );
        const upgraded = await reconnect();
        const after = await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations ORDER BY version`,
        );
        assert.deepEqual(
          after.rows.map((row) => row.version),
          [1, 2, 3, 4, 5],
        );
        assert.deepEqual(after.rows.slice(0, 2), checksums.rows);
        assert.deepEqual(
          await upgraded.knowledge.getSource(workspace, source.id),
          before,
        );
        assert.equal(
          (
            await sql.query(
              `SELECT origin FROM "${schema}".source_revisions WHERE source_id=$1`,
              [source.id],
            )
          ).rows[0].origin,
          null,
        );
      },
    );

    await t.test(
      "concurrent identical import IDs queue one source and durable replay survives restart",
      async (t) => {
        const { repository, reconnect, counts, sql, schema, queueSchema } =
          await fixture(t);
        const value = preview(),
          input = inputFor(value);
        assert.equal(
          await repository.knowledge.getGithubImport(workspace, input),
          undefined,
        );
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            repository.knowledge.importGithubSource(workspace, input, value),
          ),
        );
        assert.equal(
          new Set(results.map((result) => result.source.id)).size,
          1,
        );
        assert.equal(results.filter((result) => !result.replayed).length, 1);
        assert.deepEqual(await counts(), {
          sources: 1,
          revisions: 1,
          receipts: 1,
          jobs: 1,
        });
        const source = results[0]!.source;
        const job = await sql.query(
          `SELECT data FROM "${queueSchema}".job WHERE name=$1`,
          [INDEX_QUEUE],
        );
        assert.deepEqual(job.rows[0].data, {
          workspaceId: workspace,
          sourceId: source.id,
          revision: 1,
        });
        const revision = await sql.query(
          `SELECT body,origin FROM "${schema}".source_revisions WHERE source_id=$1`,
          [source.id],
        );
        assert.equal(revision.rows[0].body, value.text);
        assert.deepEqual(revision.rows[0].origin, value.origin);
        await repository.close();
        const restarted = await reconnect();
        assert.deepEqual(
          await restarted.knowledge.getGithubImport(workspace, input),
          source,
        );
        assert.deepEqual(
          await restarted.knowledge.importGithubSource(workspace, input, {
            ...value,
            expiresAt: "2000-01-01T00:00:00.000Z",
          }),
          { source, replayed: true },
        );
        await assert.rejects(
          restarted.knowledge.getGithubImport(workspace, {
            ...input,
            fingerprint: "f".repeat(64),
          }),
          errorCode("GITHUB_IMPORT_CONFLICT"),
        );
        await assert.rejects(
          restarted.knowledge.importGithubSource(
            workspace,
            { ...input, previewId: randomUUID() },
            value,
          ),
          errorCode("GITHUB_IMPORT_CONFLICT"),
        );
        await assert.rejects(
          restarted.knowledge.getGithubImport("another-workspace", input),
          errorCode("NOT_FOUND", 404),
        );
        const explicitNewImport = await restarted.knowledge.importGithubSource(
          workspace,
          { ...input, importId: randomUUID() },
          value,
        );
        assert.notEqual(explicitNewImport.source.id, source.id);
        assert.equal(explicitNewImport.replayed, false);
      },
    );

    await t.test(
      "mismatched hashes, normalization, format and expiry cannot commit imported text",
      async (t) => {
        const { repository, counts } = await fixture(t);
        const value = preview();
        for (const changed of [
          { ...value, text: `${value.text}\nDifferent bytes.` },
          {
            ...value,
            origin: {
              ...value.origin,
              normalizedBytes: value.origin.normalizedBytes + 1,
            },
          },
          { ...value, text: ` ${value.text}` },
          { ...value, format: "text" as const },
        ]) {
          const adjusted = {
            ...changed,
            fingerprint: sha256(githubPreviewFingerprintInput(changed)),
          };
          await assert.rejects(
            repository.knowledge.importGithubSource(
              workspace,
              inputFor(adjusted),
              adjusted,
            ),
            errorCode("GITHUB_PREVIEW_MISMATCH"),
          );
        }
        await assert.rejects(
          repository.knowledge.importGithubSource(workspace, inputFor(value), {
            ...value,
            fingerprint: "e".repeat(64),
          }),
          errorCode("GITHUB_PREVIEW_MISMATCH"),
        );
        const expired = { ...value, expiresAt: "2000-01-01T00:00:00.000Z" };
        expired.fingerprint = sha256(githubPreviewFingerprintInput(expired));
        await assert.rejects(
          repository.knowledge.importGithubSource(
            workspace,
            inputFor(expired),
            expired,
          ),
          errorCode("GITHUB_PREVIEW_EXPIRED"),
        );
        assert.deepEqual(await counts(), {
          sources: 0,
          revisions: 0,
          receipts: 0,
          jobs: 0,
        });
      },
    );

    await t.test(
      "missing or failed transactional job creation rolls back source, revision and receipt",
      async (t) => {
        const { repository, counts } = await fixture(t);
        const original = repository.boss.send;
        try {
          repository.boss.send = (async () => null) as typeof original;
          const first = preview();
          await assert.rejects(
            repository.knowledge.importGithubSource(
              workspace,
              inputFor(first),
              first,
            ),
            errorCode("INDEX_QUEUE_UNAVAILABLE", 503),
          );
          assert.deepEqual(await counts(), {
            sources: 0,
            revisions: 0,
            receipts: 0,
            jobs: 0,
          });
          repository.boss.send = (async (...args: unknown[]) => {
            await Reflect.apply(original, repository.boss, args);
            throw new Error(
              "Simulated failure after transactional job insertion",
            );
          }) as typeof original;
          const second = preview();
          await assert.rejects(
            repository.knowledge.importGithubSource(
              workspace,
              inputFor(second),
              second,
            ),
            /after transactional job insertion/,
          );
          assert.deepEqual(await counts(), {
            sources: 0,
            revisions: 0,
            receipts: 0,
            jobs: 0,
          });
        } finally {
          repository.boss.send = original;
        }
      },
    );

    await t.test(
      "immutable revision origin enters retained evidence; deletion never resurrects a receipt",
      async (t) => {
        const { repository, reconnect, sql, schema, counts } = await fixture(t);
        const value = preview(),
          input = inputFor(value);
        const { source } = await repository.knowledge.importGithubSource(
          workspace,
          input,
          value,
        );
        await assert.rejects(
          repository.knowledge.updateSource(workspace, source.id, {
            title: source.title,
            format: source.format,
            text: "Do not overwrite the imported source.",
            revision: 1,
          }),
          errorCode("GITHUB_SOURCE_READ_ONLY"),
        );
        await processIndexJob({
          repository,
          embed,
          job: {
            data: { workspaceId: workspace, sourceId: source.id, revision: 1 },
            retryCount: 0,
          },
        });
        const changedMetadataOrigin = {
          ...value.origin,
          path: "docs/UNRELATED.md",
        };
        await sql.query(
          `UPDATE "${schema}".knowledge_sources SET metadata=jsonb_set(metadata,'{origin}',$2::jsonb) WHERE id=$1`,
          [source.id, JSON.stringify(changedMetadataOrigin)],
        );
        const selection = { sourceIds: [source.id], memoryIds: [] };
        const result = await repository.knowledge.search(
          selection,
          "Vuzmi launch human review",
          embed,
        );
        assert.equal(result.status, "matched");
        assert.deepEqual(
          result.items[0]!.origin,
          value.origin,
          "retrieval reads immutable revision provenance, never mutable source metadata",
        );
        assert.deepEqual(
          (await repository.knowledge.getSource(workspace, source.id))!.source
            .origin,
          value.origin,
        );
        const run = await repository.create(
          {
            title: "Prepare Vuzmi launch",
            brief:
              "Prepare the Vuzmi launch from the selected reviewed evidence.",
            domain: "build",
            mode: "ollama",
            knowledge: selection,
          },
          { workspaceId: workspace, id: randomUUID(), model: "fixture-local" },
        );
        await processRunJob({
          repository,
          embed,
          job: {
            data: {
              workspaceId: workspace,
              runId: run.id,
              model: "fixture-local",
            },
            retryCount: 0,
          },
          generate: async ({ evidence }) => ({
            content: renderDraftDocument(
              "# Release draft\n\nRetain reviewed launch evidence [S1].",
              evidence,
            ),
            usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
          }),
        });
        const waiting = (await repository.get(workspace, run.id))!;
        assert.deepEqual(waiting.evidence!.items[0]!.origin, value.origin);
        const approved = await repository.decide(workspace, run.id, {
          decision: "approve",
          revision: waiting.revision,
          fingerprint: waiting.proposal!.fingerprint,
        });
        await repository.knowledge.deleteSource(workspace, source.id);
        assert.equal(
          await repository.knowledge.getSource(workspace, source.id),
          undefined,
        );
        for (const table of ["source_revisions", "source_chunks"])
          assert.equal(
            (
              await sql.query(
                `SELECT count(*)::integer count FROM "${schema}".${table} WHERE source_id=$1`,
                [source.id],
              )
            ).rows[0].count,
            0,
          );
        const receipt = await sql.query(
          `SELECT preview_id,fingerprint,source_id FROM "${schema}".github_import_receipts WHERE import_id=$1`,
          [input.importId],
        );
        assert.equal(receipt.rowCount, 1);
        assert.deepEqual(receipt.rows[0], {
          preview_id: input.previewId,
          fingerprint: input.fingerprint,
          source_id: source.id,
        });
        assert.deepEqual(await repository.get(workspace, run.id), approved);
        await repository.close();
        const restarted = await reconnect();
        await assert.rejects(
          restarted.knowledge.getGithubImport(workspace, input),
          errorCode("GITHUB_IMPORT_DELETED"),
        );
        await assert.rejects(
          restarted.knowledge.importGithubSource(workspace, input, value),
          errorCode("GITHUB_IMPORT_DELETED"),
        );
        assert.equal(
          (await counts()).sources,
          1,
          "the tombstone is retained without source resurrection",
        );
        assert.deepEqual(await restarted.get(workspace, run.id), approved);
        assert.equal(
          (await restarted.get(workspace, run.id))!.artifact!.content,
          approved.proposal!.content,
        );
      },
    );
  },
);
