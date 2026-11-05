import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { EmbeddingProfile, Source, Usage } from "@vuzmi/core";
import {
  INDEX_QUEUE,
  PostgresRunRepository,
  processIndexJob,
  processRunJob,
} from "../src/index.js";
import type { KnowledgeEmbedder } from "../src/index.js";

const url = process.env.VUZMI_TEST_DATABASE_URL;
const workspace = "local-workspace";
const profile: EmbeddingProfile = {
  provider: "ollama",
  model: "embeddinggemma:300m",
  digest: "fixture-local-digest",
  dimensions: 768,
  normalization: "l2",
  version: 1,
  promptVersion: "embeddinggemma-retrieval-v1",
};
const usage: Usage = { inputTokens: 100, outputTokens: 50, durationMs: 20 };
const sourceInput = {
  title: "Vuzmi launch policy",
  format: "markdown" as const,
  text: "Vuzmi launch policy requires human approval and a rollback plan.\nEvery deployment handoff must contain a rollback plan.\nRelease notes must identify unfinished work.",
};
const embed: KnowledgeEmbedder = async ({ texts }) => ({
  profile,
  vectors: texts.map((text) => {
    const values = Array<number>(768).fill(0);
    values[
      /vuzmi|launch|release|deployment/iu.test(text)
        ? 0
        : /orchid|greenhouse/iu.test(text)
          ? 1
          : 2
    ] = 1;
    return values;
  }),
});

async function fixture(t: TestContext) {
  const schema = `knowledge_test_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
  const queueSchema = `${schema}_queue`;
  const repository = await PostgresRunRepository.connect({
    connectionString: url!,
    schema,
    queueSchema,
  });
  const sql = new Pool({ connectionString: url!, max: 2 });
  t.after(async () => {
    await repository.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  async function index(source: Source, adapter = embed) {
    await processIndexJob({
      repository,
      embed: adapter,
      job: {
        data: {
          workspaceId: workspace,
          sourceId: source.id,
          revision: source.revision,
        },
        retryCount: 0,
      },
    });
    return (await repository.knowledge.getSource(workspace, source.id))?.source;
  }
  async function ready(input = sourceInput) {
    const source = await repository.knowledge.createSource(workspace, input);
    await index(source);
    return (await repository.knowledge.getSource(workspace, source.id))!.source;
  }
  async function mission(
    sourceIds: string[],
    memoryIds: string[] = [],
    overrides: { title?: string; brief?: string } = {},
  ) {
    return repository.create(
      {
        title: "Prepare Vuzmi launch",
        brief:
          "Prepare the Vuzmi release and deployment handoff from selected evidence.",
        domain: "build",
        mode: "ollama",
        knowledge: { sourceIds, memoryIds },
        ...overrides,
      },
      {
        workspaceId: workspace,
        id: randomUUID(),
        model: "local-generation-fixture",
      },
    );
  }
  return { repository, sql, schema, queueSchema, index, ready, mission };
}

test("knowledge PostgreSQL integration", { skip: !url }, async (t) => {
  await t.test(
    "an existing v1 database upgrades without changing its recorded checksum",
    async (t) => {
      const { repository, sql, schema, queueSchema } = await fixture(t);
      const before = await sql.query(
        `SELECT checksum FROM "${schema}".schema_migrations WHERE version=1`,
      );
      await repository.close();
      await sql.query(
        `DROP TABLE "${schema}".development_application_events,"${schema}".development_applications,"${schema}".development_application_runtime,"${schema}".development_profiles,"${schema}".development_artifacts,"${schema}".development_attempts,"${schema}".development_run_events,"${schema}".development_runtime,"${schema}".development_runs,"${schema}".github_import_receipts,"${schema}".run_knowledge,"${schema}".knowledge_memories,"${schema}".source_chunks,"${schema}".source_revisions,"${schema}".knowledge_sources,"${schema}".knowledge_profiles`,
      );
      await sql.query(
        `DELETE FROM "${schema}".schema_migrations WHERE version>=2`,
      );
      const upgraded = await PostgresRunRepository.connect({
        connectionString: url!,
        schema,
        queueSchema,
      });
      try {
        const after = await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations ORDER BY version`,
        );
        assert.deepEqual(
          after.rows.map((row) => row.version),
          [1, 2, 3, 4, 5],
        );
        assert.equal(after.rows[0].checksum, before.rows[0].checksum);
        assert.deepEqual(await upgraded.knowledge.listSources(), []);
      } finally {
        await upgraded.close();
      }
    },
  );
  await t.test(
    "v2 appends a checked migration and source jobs contain references only",
    async (t) => {
      const { repository, sql, schema, queueSchema, index } = await fixture(t);
      const migrations = await sql.query(
        `SELECT version,checksum FROM "${schema}".schema_migrations ORDER BY version`,
      );
      assert.deepEqual(
        migrations.rows.map((row) => row.version),
        [1, 2, 3, 4, 5],
      );
      assert.ok(
        migrations.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)),
      );
      const source = await repository.knowledge.createSource(
        workspace,
        sourceInput,
      );
      assert.equal(source.activeRevision, null);
      const jobs = await sql.query(
        `SELECT data FROM "${queueSchema}".job WHERE name=$1`,
        [INDEX_QUEUE],
      );
      assert.deepEqual(jobs.rows[0].data, {
        workspaceId: workspace,
        sourceId: source.id,
        revision: 1,
      });
      const ready = await index(source);
      assert.equal(ready?.status, "ready");
      assert.equal(ready?.activeRevision, 1);
      assert.equal(ready?.profile?.dimensions, 768);
      const count = await sql.query(
        `SELECT count(*)::integer count,min(public.vector_dims(embedding)) dimensions FROM "${schema}".source_chunks WHERE workspace_id=$1 AND source_id=$2`,
        [workspace, source.id],
      );
      assert.equal(count.rows[0].count, ready?.chunkCount);
      assert.equal(count.rows[0].dimensions, 768);
    },
  );

  await t.test(
    "exact retrieval stays inside selections and excerpt hashes/UTF-8 budget are exact",
    async (t) => {
      const { repository, ready } = await fixture(t);
      const selected = await ready({
        ...sourceInput,
        text: Array.from(
          { length: 16 },
          (_, index) =>
            `Vuzmi launch line ${index}: café planning requires review and a rollback.`,
        ).join("\n"),
      });
      const unselected = await ready({
        ...sourceInput,
        title: "Unselected secrets",
        text: "Vuzmi launch SECRET MUST NOT ENTER THIS SEARCH. The sensitive source is not selected.",
      });
      const result = await repository.knowledge.search(
        { sourceIds: [selected.id], memoryIds: [] },
        "Vuzmi launch",
        embed,
      );
      assert.equal(result.status, "matched");
      assert.ok(result.items.length > 0);
      assert.ok(
        result.items.every(
          (item) =>
            item.ownerId === selected.id && item.ownerId !== unselected.id,
        ),
      );
      assert.ok(
        result.items.reduce(
          (bytes, item) => bytes + Buffer.byteLength(item.text),
          0,
        ) <= 2400,
      );
      for (const item of result.items) {
        assert.equal(
          item.contentHash,
          createHash("sha256").update(item.text).digest("hex"),
        );
        assert.equal(
          item.lineEnd,
          item.lineStart! + item.text.split("\n").length - 1,
        );
        assert.ok(!item.text.includes("SECRET"));
      }
      assert.deepEqual(
        await repository.knowledge.listSources("another-workspace"),
        [],
      );
      assert.equal(
        await repository.knowledge.getSource("another-workspace", selected.id),
        undefined,
      );
    },
  );

  await t.test(
    "superseded or deleted indexing attempts cannot activate a revision",
    async (t) => {
      const { repository, index } = await fixture(t);
      const first = await repository.knowledge.createSource(
        workspace,
        sourceInput,
      );
      const claim = await repository.knowledge.claimIndex(
        { workspaceId: workspace, sourceId: first.id, revision: 1 },
        "old-attempt",
      );
      assert.ok(claim);
      const next = await repository.knowledge.updateSource(
        workspace,
        first.id,
        {
          ...sourceInput,
          text: "Vuzmi launch revision two requires a separate approval.",
          revision: 1,
        },
      );
      assert.equal(
        await repository.knowledge.completeIndex(
          claim,
          profile,
          (
            await embed({
              texts: claim.chunks.map((chunk) => chunk.text),
              kind: "document",
            })
          ).vectors,
        ),
        false,
      );
      assert.equal(
        (await repository.knowledge.getSource(workspace, first.id))?.source
          .activeRevision,
        null,
      );
      await index(next);
      const deleting = await repository.knowledge.updateSource(
        workspace,
        first.id,
        { ...sourceInput, revision: 2 },
      );
      const deletingClaim = await repository.knowledge.claimIndex(
        {
          workspaceId: workspace,
          sourceId: first.id,
          revision: deleting.revision,
        },
        "deleted-attempt",
      );
      assert.ok(deletingClaim);
      await repository.knowledge.deleteSource(workspace, first.id);
      assert.equal(
        await repository.knowledge.completeIndex(
          deletingClaim,
          profile,
          (
            await embed({
              texts: deletingClaim.chunks.map((chunk) => chunk.text),
              kind: "document",
            })
          ).vectors,
        ),
        false,
      );
      assert.equal(
        await repository.knowledge.getSource(workspace, first.id),
        undefined,
      );
    },
  );

  await t.test(
    "an indexing generator that ignores its lost lease cannot activate late vectors",
    async (t) => {
      const { repository } = await fixture(t);
      const source = await repository.knowledge.createSource(
        workspace,
        sourceInput,
      );
      const lease = new AbortController();
      let begin!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const operation = processIndexJob({
        repository,
        job: {
          data: { workspaceId: workspace, sourceId: source.id, revision: 1 },
          retryCount: 0,
          signal: lease.signal,
        },
        embed: async (input) => {
          begin();
          await blocked;
          return embed(input);
        },
      });
      const rejected = assert.rejects(operation, /INDEX_LEASE_LOST/);
      await started;
      lease.abort();
      const deadline = Date.now() + 5000;
      while (
        (await repository.knowledge.getSource(workspace, source.id))?.source
          .status !== "queued"
      ) {
        if (Date.now() > deadline)
          throw new Error(
            "Index cancellation did not fence its active attempt.",
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await processIndexJob({
        repository,
        job: {
          data: { workspaceId: workspace, sourceId: source.id, revision: 1 },
          retryCount: 1,
        },
        embed,
      });
      release();
      await rejected;
      const current = (await repository.knowledge.getSource(
        workspace,
        source.id,
      ))!.source;
      assert.equal(current.status, "ready");
      assert.equal(current.activeRevision, 1);
    },
  );

  await t.test(
    "failed reindex preserves old searchable revision but blocks new required missions",
    async (t) => {
      const { repository, ready, index, mission } = await fixture(t);
      const first = await ready();
      const next = await repository.knowledge.updateSource(
        workspace,
        first.id,
        {
          ...sourceInput,
          text: "Vuzmi launch update has not been indexed successfully.",
          revision: 1,
        },
      );
      await index(next, async () => {
        throw new Error("Embedding fixture failure");
      });
      const failed = (await repository.knowledge.getSource(
        workspace,
        first.id,
      ))!.source;
      assert.equal(failed.status, "failed");
      assert.equal(failed.activeRevision, 1);
      const search = await repository.knowledge.search(
        { sourceIds: [first.id], memoryIds: [] },
        "Vuzmi launch",
        embed,
      );
      assert.equal(search.status, "matched");
      assert.ok(search.items.every((item) => item.revision === 1));
      await assert.rejects(mission([first.id]), /latest source revision/);
    },
  );

  await t.test(
    "profile/dimension mismatch cannot partially activate an index or query it",
    async (t) => {
      const { repository, ready, index, sql, schema } = await fixture(t);
      const first = await ready();
      const other = await repository.knowledge.createSource(workspace, {
        ...sourceInput,
        title: "Other profile source",
      });
      await index(other, async (input) => ({
        ...(await embed(input)),
        profile: { ...profile, digest: "different-model-digest" },
      }));
      assert.equal(
        (await repository.knowledge.getSource(workspace, other.id))?.source
          .status,
        "failed",
      );
      const count = await sql.query(
        `SELECT count(*)::integer count FROM "${schema}".source_chunks WHERE source_id=$1`,
        [other.id],
      );
      assert.equal(count.rows[0].count, 0);
      await assert.rejects(
        repository.knowledge.search(
          { sourceIds: [first.id], memoryIds: [] },
          "Vuzmi launch",
          async (input) => ({
            ...(await embed(input)),
            profile: { ...profile, digest: "different-model-digest" },
          }),
        ),
        /differs from the active index/,
      );
      const invalid = await repository.knowledge.createSource(workspace, {
        ...sourceInput,
        title: "Invalid vector source",
      });
      await index(invalid, async ({ texts }) => ({
        profile,
        vectors: texts.map(() => [1, 0]),
      }));
      assert.equal(
        (await repository.knowledge.getSource(workspace, invalid.id))?.source
          .activeRevision,
        null,
      );
    },
  );

  await t.test(
    "changed selected revision stops processing before the generator is called",
    async (t) => {
      const { repository, ready, mission } = await fixture(t);
      const source = await ready();
      const run = await mission([source.id]);
      await repository.knowledge.updateSource(workspace, source.id, {
        ...sourceInput,
        revision: 1,
      });
      let calls = 0;
      await processRunJob({
        repository,
        embed,
        job: {
          data: {
            workspaceId: workspace,
            runId: run.id,
            model: run.route.model!,
          },
          retryCount: 0,
        },
        generate: async () => {
          calls += 1;
          return { content: "Must not run", usage };
        },
      });
      const failed = await repository.get(workspace, run.id);
      assert.equal(calls, 0);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.error?.code, "SOURCE_CHANGED");
    },
  );

  await t.test(
    "insufficient required evidence is persisted and blocks ungrounded generation",
    async (t) => {
      const { repository, ready, mission } = await fixture(t);
      const source = await ready();
      const run = await mission([source.id], [], {
        title: "Investigate coral reefs",
        brief: "Explain marine coral reef chemistry and tropical fish ecology.",
      });
      let calls = 0;
      await processRunJob({
        repository,
        embed,
        job: {
          data: {
            workspaceId: workspace,
            runId: run.id,
            model: run.route.model!,
          },
          retryCount: 0,
        },
        generate: async () => {
          calls += 1;
          return { content: "Must not run", usage };
        },
      });
      const failed = await repository.get(workspace, run.id);
      assert.equal(calls, 0);
      assert.equal(failed?.evidence?.status, "insufficient");
      assert.deepEqual(failed?.evidence?.items, []);
      assert.equal(failed?.error?.code, "INSUFFICIENT_EVIDENCE");
    },
  );

  await t.test(
    "source change during generation rejects the returned draft at commit",
    async (t) => {
      const { repository, ready, mission } = await fixture(t);
      const source = await ready();
      const run = await mission([source.id]);
      await processRunJob({
        repository,
        embed,
        job: {
          data: {
            workspaceId: workspace,
            runId: run.id,
            model: run.route.model!,
          },
          retryCount: 0,
        },
        generate: async ({ evidence }) => {
          assert.equal(evidence?.status, "matched");
          await repository.knowledge.updateSource(workspace, source.id, {
            ...sourceInput,
            revision: 1,
          });
          return { content: "# Draft from evidence [S1]", usage };
        },
      });
      const failed = await repository.get(workspace, run.id);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.error?.code, "SOURCE_CHANGED");
      assert.equal(failed?.proposal, null);
      assert.equal(failed?.evidence?.status, "matched");
    },
  );

  await t.test(
    "deletion removes originals/vectors/linked memories while disclosing retained run history",
    async (t) => {
      const { repository, ready, mission, sql, schema } = await fixture(t);
      const source = await ready();
      const memory = await repository.knowledge.createMemory(workspace, {
        title: "Vuzmi release approval",
        content: "Vuzmi launch always needs human approval.",
        provenance: { kind: "source", sourceId: source.id, sourceRevision: 1 },
        expiresAt: null,
      });
      const run = await mission([source.id], [memory.id]);
      await processRunJob({
        repository,
        embed,
        job: {
          data: {
            workspaceId: workspace,
            runId: run.id,
            model: run.route.model!,
          },
          retryCount: 0,
        },
        generate: async () => ({
          content: "# Reviewed launch draft [S1]",
          usage,
        }),
      });
      const waiting = (await repository.get(workspace, run.id))!;
      const completed = await repository.decide(workspace, run.id, {
        decision: "approve",
        revision: waiting.revision,
        fingerprint: waiting.proposal!.fingerprint,
      });
      await repository.knowledge.deleteSource(workspace, source.id);
      assert.equal(
        await repository.knowledge.getSource(workspace, source.id),
        undefined,
      );
      assert.deepEqual(await repository.knowledge.listMemories(), []);
      for (const table of ["source_revisions", "source_chunks"]) {
        const result = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}".${table} WHERE source_id=$1`,
          [source.id],
        );
        assert.equal(result.rows[0].count, 0);
      }
      const tombstone = await sql.query(
        `SELECT metadata,deleted_at FROM "${schema}".knowledge_sources WHERE id=$1`,
        [source.id],
      );
      assert.deepEqual(tombstone.rows[0].metadata, {});
      assert.ok(tombstone.rows[0].deleted_at);
      assert.deepEqual(
        await repository.get(workspace, run.id),
        completed,
        "historical evidence and artifacts remain retained under the private-alpha policy",
      );
    },
  );

  await t.test(
    "manual memory is scoped, revision-controlled, expirable, and not silently substituted",
    async (t) => {
      const { repository, mission } = await fixture(t);
      const memory = await repository.knowledge.createMemory(workspace, {
        title: "Vuzmi launch preference",
        content: "Vuzmi launch uses reviewed release notes.",
        provenance: { kind: "operator" },
        expiresAt: null,
      });
      const search = await repository.knowledge.search(
        { sourceIds: [], memoryIds: [memory.id] },
        "Vuzmi launch",
        async () => {
          throw new Error(
            "Memory-only lexical retrieval must not request embeddings.",
          );
        },
      );
      assert.equal(search.items[0]?.kind, "memory");
      assert.equal(search.profile, null);
      const run = await mission([], [memory.id]);
      await repository.knowledge.updateMemory(workspace, memory.id, {
        title: "Edited release policy",
        content: "Vuzmi launch now needs a second review.",
        provenance: memory.provenance,
        expiresAt: null,
        revision: 1,
      });
      await assert.rejects(
        repository.knowledge.updateMemory(workspace, memory.id, {
          title: memory.title,
          content: memory.content,
          provenance: memory.provenance,
          expiresAt: null,
          revision: 1,
        }),
        /memory changed/,
      );
      await processRunJob({
        repository,
        embed,
        job: {
          data: {
            workspaceId: workspace,
            runId: run.id,
            model: run.route.model!,
          },
          retryCount: 0,
        },
        generate: async () => {
          throw new Error("Changed memory must block generation.");
        },
      });
      assert.equal(
        (await repository.get(workspace, run.id))?.error?.code,
        "SOURCE_CHANGED",
      );
      const expired = await repository.knowledge.createMemory(workspace, {
        title: "Expired Vuzmi fact",
        content: "This Vuzmi launch fact is expired.",
        provenance: { kind: "operator" },
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      await assert.rejects(
        mission([], [expired.id]),
        /changed, expired, or was deleted/,
      );
      assert.deepEqual(
        await repository.knowledge.listMemories("another-workspace"),
        [],
      );
    },
  );
});
