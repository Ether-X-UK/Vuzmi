import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import type { EmbeddingProfile } from "@vuzmi/core";
import {
  GENERATION_QUEUE,
  INDEX_QUEUE,
  PostgresRunRepository,
  processIndexJob,
  processRunJob,
} from "../src/index.js";
import type { IndexClaim, KnowledgeEmbedder } from "../src/index.js";

const url = process.env.VUZMI_TEST_DATABASE_URL;
const workspace = "local-workspace";
const profile: EmbeddingProfile = {
  provider: "ollama",
  model: "embeddinggemma:300m",
  digest: "fixture-local-digest",
  dimensions: 3,
  normalization: "l2",
  version: 1,
  promptVersion: "embeddinggemma-retrieval-v1",
};
const sourceInput = {
  title: "Recovery source",
  format: "text" as const,
  text: "Release preparation requires explicit review.",
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function fixture(t: TestContext) {
  const schema = `recovery_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  async function run() {
    return repository.create(
      {
        title: "Prepare a local release",
        brief: "Prepare reviewed local release readiness documentation.",
        domain: "build",
        mode: "ollama",
      },
      { workspaceId: workspace, id: randomUUID(), model: "local-fixture" },
    );
  }
  async function ageRun(id: string) {
    const updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await sql.query(
      `UPDATE "${schema}".runs SET updated_at=$2,aggregate=jsonb_set(aggregate,'{updatedAt}',$3::jsonb) WHERE id=$1`,
      [id, updatedAt, JSON.stringify(updatedAt)],
    );
  }
  async function ageSource(id: string) {
    const updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await sql.query(
      `UPDATE "${schema}".knowledge_sources SET metadata=jsonb_set(metadata,'{updatedAt}',$2::jsonb) WHERE id=$1`,
      [id, JSON.stringify(updatedAt)],
    );
  }
  return { repository, sql, schema, queueSchema, run, ageRun, ageSource };
}

test("index batches include UTF-8 document prompt overhead, including legacy oversized chunks", async () => {
  const text = "😀".repeat(1200);
  const title = "界".repeat(120);
  const claim = {
    source: { id: randomUUID(), title },
    attemptId: "fixture-attempt",
    text,
    chunks: Array.from({ length: 8 }, (_, index) => ({
      index,
      text,
      lineStart: 1,
      lineEnd: 1,
      contentHash: hash(text),
    })),
  } as IndexClaim;
  const batches: number[] = [];
  let completed = false;
  const repository = {
    knowledge: {
      claimIndex: async () => claim,
      failIndex: async () => {
        assert.fail("Valid bounded chunks must not fail indexing");
      },
      completeIndex: async (
        _claim: IndexClaim,
        _profile: EmbeddingProfile,
        vectors: number[][],
      ) => {
        assert.equal(vectors.length, 8);
        completed = true;
        return true;
      },
    },
  } as unknown as PostgresRunRepository;
  const embed: KnowledgeEmbedder = async ({ texts, title: batchTitle }) => {
    const bytes = texts.reduce(
      (total, item) =>
        total +
        Buffer.byteLength(`title: ${batchTitle} | text: ${item}`, "utf8"),
      0,
    );
    assert.ok(texts.length <= 8 && bytes <= 32768);
    batches.push(texts.length);
    return { profile, vectors: texts.map(() => [1, 0, 0]) };
  };
  await processIndexJob({
    repository,
    embed,
    job: {
      data: { workspaceId: workspace, sourceId: claim.source.id, revision: 1 },
      retryCount: 0,
    },
  });
  assert.deepEqual(batches, [6, 2]);
  assert.equal(completed, true);
});

test(
  "Unicode sources within 64 KiB activate completely with byte-bounded chunks and provenance",
  { skip: !url },
  async (t) => {
    const { repository, sql, schema } = await fixture(t);
    const text = `${"😀".repeat(16_000)}\nRelease review is required.`;
    const source = await repository.knowledge.createSource(workspace, {
      title: "界".repeat(120),
      format: "markdown",
      text,
    });
    assert.ok(Buffer.byteLength(text, "utf8") <= 65536);
    const embed: KnowledgeEmbedder = async ({ texts, title }) => {
      assert.ok(texts.length <= 8);
      assert.ok(
        texts.reduce(
          (total, item) =>
            total +
            Buffer.byteLength(`title: ${title} | text: ${item}`, "utf8"),
          0,
        ) <= 32768,
      );
      assert.ok(texts.every((item) => Buffer.byteLength(item, "utf8") <= 1000));
      return { profile, vectors: texts.map(() => [1, 0, 0]) };
    };
    await processIndexJob({
      repository,
      embed,
      job: {
        data: { workspaceId: workspace, sourceId: source.id, revision: 1 },
        retryCount: 0,
      },
    });
    const ready = (await repository.knowledge.getSource(workspace, source.id))!
      .source;
    assert.equal(ready.status, "ready");
    assert.equal(ready.activeRevision, 1);
    assert.equal(ready.parserVersion, "plain-text-v1");
    assert.equal(ready.chunkerVersion, "utf8-lines-v1");
    const rows = await sql.query<{
      chunk_index: number;
      body: string;
      content_hash: string;
      line_start: number;
      line_end: number;
    }>(
      `SELECT chunk_index,body,content_hash,line_start,line_end FROM "${schema}".source_chunks WHERE source_id=$1 ORDER BY chunk_index`,
      [source.id],
    );
    assert.equal(rows.rows.length, ready.chunkCount);
    for (const [index, row] of rows.rows.entries()) {
      assert.equal(row.chunk_index, index);
      assert.equal(row.content_hash, hash(row.body));
      assert.ok(Buffer.byteLength(row.body, "utf8") <= 1000);
      assert.equal(row.line_start, index < rows.rows.length - 1 ? 1 : 2);
      assert.equal(row.line_end, row.line_start);
    }
    assert.equal(
      rows.rows
        .slice(0, -1)
        .map((row) => row.body)
        .join(""),
      "😀".repeat(16_000),
    );
    const updated = await repository.knowledge.updateSource(
      workspace,
      source.id,
      { ...sourceInput, revision: 1 },
    );
    assert.equal(updated.parserVersion, "plain-text-v1");
    assert.equal(updated.chunkerVersion, "utf8-lines-v1");
  },
);

test(
  "purged jobs terminate stale queued/running work without reinference or failing fresh/live work",
  { skip: !url },
  async (t) => {
    const { repository, sql, schema, queueSchema, run, ageRun, ageSource } =
      await fixture(t);
    const queuedRun = await run();
    const runningRun = await run();
    const liveRun = await run();
    const freshRun = await run();
    await repository.claim(workspace, runningRun.id, {
      attemptId: "lost-run-attempt",
    });
    const queuedSource = await repository.knowledge.createSource(
      workspace,
      sourceInput,
    );
    const runningSource = await repository.knowledge.createSource(
      workspace,
      sourceInput,
    );
    const liveSource = await repository.knowledge.createSource(
      workspace,
      sourceInput,
    );
    const freshSource = await repository.knowledge.createSource(
      workspace,
      sourceInput,
    );
    await repository.knowledge.claimIndex(
      { workspaceId: workspace, sourceId: runningSource.id, revision: 1 },
      "lost-index-attempt",
    );
    for (const item of [queuedRun, runningRun, liveRun]) await ageRun(item.id);
    for (const item of [queuedSource, runningSource, liveSource])
      await ageSource(item.id);
    await sql.query(
      `DELETE FROM "${queueSchema}".job WHERE name=$1 AND data->>'runId'=ANY($2::text[])`,
      [GENERATION_QUEUE, [queuedRun.id, runningRun.id, freshRun.id]],
    );
    await sql.query(
      `DELETE FROM "${queueSchema}".job WHERE name=$1 AND data->>'sourceId'=ANY($2::text[])`,
      [INDEX_QUEUE, [queuedSource.id, runningSource.id, freshSource.id]],
    );
    await repository.reconcileExhausted();
    for (const item of [queuedRun, runningRun]) {
      const failed = (await repository.get(workspace, item.id))!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.error?.code, "QUEUE_JOB_UNAVAILABLE");
      assert.equal(failed.error?.retryable, false);
      assert.equal(failed.proposal, null);
    }
    for (const item of [queuedSource, runningSource]) {
      const failed = (await repository.knowledge.getSource(workspace, item.id))!
        .source;
      assert.equal(failed.status, "failed");
      assert.equal(failed.error?.code, "INDEX_JOB_UNAVAILABLE");
      assert.equal(failed.activeRevision, null);
    }
    assert.equal(
      (await repository.get(workspace, freshRun.id))!.status,
      "queued",
    );
    assert.equal(
      (await repository.knowledge.getSource(workspace, freshSource.id))!.source
        .status,
      "queued",
    );
    for (const state of ["created", "retry", "active"]) {
      await sql.query(
        `UPDATE "${queueSchema}".job SET state=$1,started_on=now() WHERE (name=$2 AND data->>'runId'=$3) OR (name=$4 AND data->>'sourceId'=$5)`,
        [state, GENERATION_QUEUE, liveRun.id, INDEX_QUEUE, liveSource.id],
      );
      await repository.reconcileExhausted();
      assert.equal(
        (await repository.get(workspace, liveRun.id))!.status,
        "queued",
      );
      assert.equal(
        (await repository.knowledge.getSource(workspace, liveSource.id))!.source
          .status,
        "queued",
      );
    }
    const count = await sql.query(
      `SELECT count(*)::int AS count FROM "${queueSchema}".job WHERE name=ANY($1::text[])`,
      [[INDEX_QUEUE, GENERATION_QUEUE]],
    );
    assert.equal(
      count.rows[0].count,
      2,
      "Reconciliation must not create new inference jobs",
    );
    const attempts = await sql.query(
      `SELECT attempt_id,state FROM "${schema}".source_revisions WHERE source_id=$1`,
      [runningSource.id],
    );
    assert.equal(attempts.rows[0].attempt_id, null);
    assert.equal(attempts.rows[0].state, "failed");
  },
);

test(
  "exhausted index jobs fail promptly while failed reindexing keeps the prior active revision",
  { skip: !url },
  async (t) => {
    const { repository, sql, queueSchema } = await fixture(t);
    const source = await repository.knowledge.createSource(
      workspace,
      sourceInput,
    );
    const embed: KnowledgeEmbedder = async ({ texts }) => ({
      profile,
      vectors: texts.map(() => [1, 0, 0]),
    });
    await processIndexJob({
      repository,
      embed,
      job: {
        data: { workspaceId: workspace, sourceId: source.id, revision: 1 },
        retryCount: 0,
      },
    });
    await repository.knowledge.updateSource(workspace, source.id, {
      ...sourceInput,
      revision: 1,
    });
    await sql.query(
      `UPDATE "${queueSchema}".job SET state='failed',completed_on=now() WHERE name=$1 AND data->>'sourceId'=$2 AND data->>'revision'='2'`,
      [INDEX_QUEUE, source.id],
    );
    await repository.reconcileExhausted();
    const failed = (await repository.knowledge.getSource(workspace, source.id))!
      .source;
    assert.equal(failed.status, "failed");
    assert.equal(failed.activeRevision, 1);
    assert.equal(failed.error?.code, "INDEX_RETRIES_EXHAUSTED");
  },
);

test(
  "lease loss while completion waits for a database lock rolls back the draft before publishing",
  { skip: !url },
  async (t) => {
    const { repository, sql, schema, run } = await fixture(t);
    const queued = await run();
    const lease = new AbortController();
    let blocker: PoolClient | undefined;
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const operation = processRunJob({
      repository,
      job: {
        data: {
          workspaceId: workspace,
          runId: queued.id,
          model: queued.route.model!,
        },
        retryCount: 0,
        signal: lease.signal,
      },
      generate: async () => {
        blocker = await sql.connect();
        await blocker.query("BEGIN");
        await blocker.query(
          `SELECT 1 FROM "${schema}".runs WHERE id=$1 FOR UPDATE`,
          [queued.id],
        );
        locked();
        return {
          content: "# Output from the lost lease",
          usage: { inputTokens: null, outputTokens: null, durationMs: null },
        };
      },
    });
    // Observe immediately so the expected retry rejection cannot be unhandled.
    const settled = operation.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      await lockHeld;
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await sql.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE application_name='vuzmi-runtime' AND wait_event_type='Lock' AND query LIKE $1) AS waiting`,
          [`%FROM "${schema}".runs%`],
        );
        if (activity.rows[0]!.waiting) {
          waiting = true;
          break;
        }
        await delay(5);
      }
      assert.equal(
        waiting,
        true,
        "The completion transaction must be waiting before the lease is aborted",
      );
      lease.abort();
      await blocker!.query("COMMIT");
      blocker!.release();
      blocker = undefined;
      const result = await settled;
      assert.ok(
        result.error instanceof Error &&
          result.error.message === "QUEUE_LEASE_LOST",
      );
      const interrupted = (await repository.get(workspace, queued.id))!;
      assert.equal(interrupted.status, "queued");
      assert.equal(interrupted.error?.code, "QUEUE_LEASE_LOST");
      assert.equal(interrupted.proposal, null);
      assert.equal(interrupted.route.executed, false);
      assert.equal(
        interrupted.events.some(
          (event) => event.type === "generation.completed",
        ),
        false,
      );
    } finally {
      lease.abort();
      if (blocker) {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      await settled;
    }
  },
);

test(
  "lease loss during the final index update rolls back vectors and activation before commit",
  { skip: !url },
  async (t) => {
    const { repository, sql, schema } = await fixture(t);
    const source = await repository.knowledge.createSource(
      workspace,
      sourceInput,
    );
    // A test-only trigger holds the final UPDATE after all vectors were written.
    await sql.query(`CREATE FUNCTION "${schema}".review_block_activation() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN IF NEW.metadata->>'status'='ready' THEN PERFORM pg_advisory_xact_lock(11766332); END IF; RETURN NEW; END;
    $body$;
    CREATE TRIGGER review_block_activation BEFORE UPDATE ON "${schema}".knowledge_sources
    FOR EACH ROW EXECUTE FUNCTION "${schema}".review_block_activation()`);
    const blocker = await sql.connect();
    await blocker.query("SELECT pg_advisory_lock(11766332)");
    let unlocked = false;
    const lease = new AbortController();
    const embed: KnowledgeEmbedder = async ({ texts }) => ({
      profile,
      vectors: texts.map(() => [1, 0, 0]),
    });
    const operation = processIndexJob({
      repository,
      embed,
      job: {
        data: { workspaceId: workspace, sourceId: source.id, revision: 1 },
        retryCount: 0,
        signal: lease.signal,
      },
    });
    const settled = operation.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await sql.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE application_name='vuzmi-runtime' AND wait_event='advisory' AND query LIKE $1) AS waiting`,
          [`%UPDATE "${schema}".knowledge_sources SET active_revision%`],
        );
        if (activity.rows[0]!.waiting) {
          waiting = true;
          break;
        }
        await delay(5);
      }
      assert.equal(
        waiting,
        true,
        "Index activation must reach its final UPDATE before cancellation",
      );
      lease.abort();
      await blocker.query("SELECT pg_advisory_unlock(11766332)");
      unlocked = true;
      const result = await settled;
      assert.ok(
        result.error instanceof Error &&
          result.error.message === "INDEX_LEASE_LOST",
      );
      const interrupted = (await repository.knowledge.getSource(
        workspace,
        source.id,
      ))!.source;
      assert.equal(interrupted.status, "queued");
      assert.equal(interrupted.activeRevision, null);
      const vectors = await sql.query(
        `SELECT count(*)::int AS count FROM "${schema}".source_chunks WHERE source_id=$1`,
        [source.id],
      );
      assert.equal(vectors.rows[0].count, 0);
    } finally {
      lease.abort();
      if (!unlocked) await blocker.query("SELECT pg_advisory_unlock(11766332)");
      blocker.release();
      await settled;
    }
  },
);
