import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import { Pool } from "pg";
import type { EmbeddingProfile, Run } from "@vuzmi/core";
import { approvedPackageSchema } from "@vuzmi/core";
import {
  PostgresRunRepository,
  processIndexJob,
  processRunJob,
} from "@vuzmi/runtime";
import type { KnowledgeEmbedder } from "@vuzmi/runtime";
import { registerOutboxRoutes } from "../src/outbox.js";
import { HttpError } from "../src/errors.js";

const connectionString = process.env.VUZMI_TEST_DATABASE_URL;
const workspace = "local-workspace";
const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const input = {
  title: "Vuzmi local release",
  brief: "Prepare a reviewed local release readiness artifact.",
  domain: "build" as const,
  mode: "simulation" as const,
};
const owner = { id: "fixture-owner-id", name: "Fixture owner" };
const profile: EmbeddingProfile = {
  provider: "ollama",
  model: "fixture-embedding",
  digest: "fixture-digest",
  dimensions: 768,
  normalization: "l2",
  version: 1,
  promptVersion: "embeddinggemma-retrieval-v1",
};
const embed: KnowledgeEmbedder = async ({ texts }) => ({
  profile,
  vectors: texts.map(() => [1, ...Array<number>(767).fill(0)]),
});

async function fixture(t: TestContext) {
  const schema = `outbox_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const queueSchema = `${schema}_queue`;
  const options = { connectionString: connectionString!, schema, queueSchema };
  let repository = await PostgresRunRepository.connect(options);
  const sql = new Pool({ connectionString, max: 2 });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) =>
    error instanceof HttpError
      ? reply
          .code(error.status)
          .send({ error: { code: error.code, message: error.message } })
      : reply.code(500).send({
          error: {
            code: "TEST_FAILURE",
            message:
              error instanceof Error
                ? error.message
                : "Unknown fixture failure",
          },
        }),
  );
  registerOutboxRoutes(app, {
    listRuns: () => repository.list(workspace),
    getRun: (id) => repository.get(workspace, id),
  });
  t.after(async () => {
    await app.close();
    await repository.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const create = () =>
    repository.create(input, { workspaceId: workspace, id: randomUUID() });
  async function approve(run: Run) {
    return repository.decide(
      workspace,
      run.id,
      {
        decision: "approve",
        fingerprint: run.proposal!.fingerprint,
        revision: run.revision,
      },
      owner,
    );
  }
  async function reconnect() {
    await repository.close();
    repository = await PostgresRunRepository.connect(options);
    return repository;
  }
  return {
    get repository() {
      return repository;
    },
    app,
    sql,
    schema,
    create,
    approve,
    reconnect,
  };
}

test(
  "approved local outbox on isolated PostgreSQL",
  { skip: !connectionString },
  async (t) => {
    await t.test(
      "repeated downloads preserve exact bytes, approval and digest across reconnect without new writes",
      async (t) => {
        const { repository, app, sql, schema, approve, reconnect } =
          await fixture(t);
        const queued = await repository.create(
          { ...input, mode: "ollama" },
          {
            workspaceId: workspace,
            id: randomUUID(),
            model: "fixture-local-model",
          },
        );
        const running = await repository.claim(workspace, queued.id, {
          attemptId: "outbox-attempt",
        });
        assert.ok(running);
        const content =
          "# Vuzmi café 🚀\r\n\r\n- [ ] Exact trailing spaces.  \r\n\n";
        const waiting = await repository.complete(workspace, queued.id, {
          attemptId: running.attemptId!,
          expectedRevision: running.revision,
          content,
          usage: { inputTokens: 5, outputTokens: 12, durationMs: 9 },
        });
        assert.ok(waiting);
        const run = await approve(waiting);
        const first = await app.inject({
          method: "GET",
          url: `/v1/outbox/${run.id}`,
        });
        assert.equal(first.statusCode, 200, first.body);
        const value = approvedPackageSchema.parse(first.json());
        assert.equal(value.documents.length, 1);
        assert.equal(value.documents[0].content, content);
        assert.equal(value.documents[0].sha256, sha(content));
        assert.equal(value.documents[0].byteLength, Buffer.byteLength(content));
        assert.equal(
          value.approval.actionFingerprint,
          waiting.proposal!.fingerprint,
        );
        assert.notEqual(value.approval.actionFingerprint, sha(content));
        assert.equal(value.approval.revision, waiting.revision);
        assert.equal(value.approval.actor, owner.id);
        assert.equal(value.approval.actorName, owner.name);
        assert.equal(value.approval.decidedAt, run.decision!.decidedAt);
        assert.deepEqual(value.usage, run.usage);
        assert.deepEqual(value.route, run.route);
        assert.match(
          first.headers["content-disposition"] as string,
          /^attachment; filename="[a-zA-Z0-9_.-]+\.json"$/,
        );
        assert.match(
          first.headers["content-type"] as string,
          /application\/json/,
        );
        assert.equal(first.headers["cache-control"], "no-store");
        const second = await app.inject({
          method: "GET",
          url: `/v1/outbox/${run.id}`,
        });
        assert.equal(second.body, first.body);
        await reconnect();
        const reloaded = await app.inject({
          method: "GET",
          url: `/v1/outbox/${run.id}`,
        });
        assert.equal(reloaded.body, first.body);
        const summary = await app.inject({ method: "GET", url: "/v1/outbox" });
        assert.equal(summary.statusCode, 200, summary.body);
        assert.equal(summary.json().items.length, 1);
        assert.equal(summary.json().items[0].documentSha256, sha(content));
        assert.equal(
          first.headers["content-disposition"],
          `attachment; filename="${summary.json().items[0].filename}"`,
        );
        const effects = await sql.query(
          `SELECT (SELECT count(*)::integer FROM "${schema}".artifacts WHERE run_id=$1) AS artifacts,(SELECT count(*)::integer FROM "${schema}".run_events WHERE run_id=$1) AS events`,
          [run.id],
        );
        assert.equal(effects.rows[0].artifacts, 1);
        assert.equal(effects.rows[0].events, run.events.length);
        const saved = await sql.query(
          `SELECT content FROM "${schema}".artifacts WHERE workspace_id=$1 AND run_id=$2`,
          [workspace, run.id],
        );
        assert.equal(saved.rows[0].content, content);
      },
    );

    await t.test(
      "pending/rejected/queued/failed/unknown and foreign-workspace runs cannot be exported",
      async (t) => {
        const { repository, app, sql, schema, create, approve } =
          await fixture(t);
        const pending = await create();
        const rejection = await create();
        const rejected = await repository.decide(
          workspace,
          rejection.id,
          {
            decision: "reject",
            fingerprint: rejection.proposal!.fingerprint,
            revision: rejection.revision,
          },
          owner,
        );
        const queued = await repository.create(
          { ...input, mode: "ollama" },
          {
            workspaceId: workspace,
            id: randomUUID(),
            model: "fixture-local-model",
          },
        );
        const running = await repository.claim(workspace, queued.id, {
          attemptId: "failing-attempt",
        });
        assert.ok(running);
        const failed = await repository.fail(workspace, queued.id, {
          attemptId: running.attemptId!,
          expectedRevision: running.revision,
          error: {
            code: "FIXTURE_FAILURE",
            message: "No draft was generated.",
            retryable: false,
          },
          willRetry: false,
        });
        assert.ok(failed);
        const stillQueued = await repository.create(
          { ...input, mode: "ollama" },
          {
            workspaceId: workspace,
            id: randomUUID(),
            model: "fixture-local-model",
          },
        );
        for (const run of [pending, rejected, failed, stillQueued]) {
          const response = await app.inject({
            method: "GET",
            url: `/v1/outbox/${run.id}`,
          });
          assert.equal(response.statusCode, 409, response.body);
          assert.equal(response.json().error.code, "OUTBOX_NOT_APPROVED");
          assert.equal(response.headers["content-disposition"], undefined);
        }
        const local = await approve(await create());
        const foreignId = randomUUID();
        const foreign = {
          ...local,
          id: foreignId,
          workspaceId: "other-workspace",
          title: "FOREIGN WORKSPACE SECRET",
        };
        await sql.query(
          `INSERT INTO "${schema}".runs(workspace_id,id,revision,status,aggregate,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
          [
            foreign.workspaceId,
            foreign.id,
            foreign.revision,
            foreign.status,
            JSON.stringify(foreign),
            foreign.createdAt,
            foreign.updatedAt,
          ],
        );
        for (const path of [
          `/v1/outbox/${randomUUID()}`,
          `/v1/outbox/${foreignId}`,
          `/v1/outbox/${foreignId}?workspaceId=other-workspace`,
          `/v1/outbox/other-workspace/${foreignId}`,
        ]) {
          const response = await app.inject({ method: "GET", url: path });
          assert.equal(response.statusCode, 404, response.body);
          assert.ok(!response.body.includes("FOREIGN WORKSPACE SECRET"));
        }
        const listed = await app.inject({
          method: "GET",
          url: "/v1/outbox?workspaceId=other-workspace",
        });
        assert.deepEqual(
          listed.json().items.map((item: { runId: string }) => item.runId),
          [local.id],
        );
        assert.ok(!listed.body.includes("FOREIGN WORKSPACE SECRET"));
      },
    );

    await t.test(
      "retained approved evidence remains downloadable unchanged after its original source is deleted",
      async (t) => {
        const { repository, app, approve, reconnect } = await fixture(t);
        const source = await repository.knowledge.createSource(workspace, {
          title: "Vuzmi release policy",
          format: "markdown",
          text: "Vuzmi release policy requires owner approval and a rollback plan.",
        });
        await processIndexJob({
          repository,
          embed,
          job: {
            data: {
              workspaceId: workspace,
              sourceId: source.id,
              revision: source.revision,
            },
            retryCount: 0,
          },
        });
        const queued = await repository.create(
          {
            ...input,
            mode: "ollama",
            knowledge: { sourceIds: [source.id], memoryIds: [] },
          },
          {
            workspaceId: workspace,
            id: randomUUID(),
            model: "fixture-local-model",
          },
        );
        await processRunJob({
          repository,
          embed,
          job: {
            data: {
              workspaceId: workspace,
              runId: queued.id,
              model: queued.route.model!,
            },
            retryCount: 0,
          },
          generate: async () => ({
            content:
              "# Vuzmi release\n\nOwner approval and rollback are required [S1].\n",
            usage: { inputTokens: 20, outputTokens: 15, durationMs: 4 },
          }),
        });
        const waiting = await repository.get(workspace, queued.id);
        assert.equal(waiting?.status, "waiting_approval");
        const run = await approve(waiting!);
        const before = await app.inject({
          method: "GET",
          url: `/v1/outbox/${run.id}`,
        });
        assert.equal(before.statusCode, 200, before.body);
        assert.equal(before.json().evidence.items[0].ownerId, source.id);
        await repository.knowledge.deleteSource(workspace, source.id);
        assert.equal(
          await repository.knowledge.getSource(workspace, source.id),
          undefined,
        );
        await reconnect();
        const after = await app.inject({
          method: "GET",
          url: `/v1/outbox/${run.id}`,
        });
        assert.equal(after.body, before.body);
        assert.match(
          after.json().retention.disclosure,
          /retained in run history/,
        );
        assert.match(after.json().retention.disclosure, /changed or deleted/);
        assert.equal(
          after.json().evidence.items[0].contentHash,
          sha(after.json().evidence.items[0].text),
        );
      },
    );
  },
);
