import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { CreateRunInput, Run, Usage } from "@vuzmi/core";
import {
  GENERATION_QUEUE,
  PostgresRunRepository,
  processRunJob,
  startWorker,
} from "../src/index.js";

const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL;
const brief: CreateRunInput = {
  title: "Prepare the Vuzmi alpha release",
  brief:
    "Draft the release scope, unchecked acceptance criteria, risks, and handoff for Vuzmi.",
  domain: "build",
  mode: "ollama",
  model: "existing-local-fixture:latest",
};
const usage: Usage = { inputTokens: 120, outputTokens: 80, durationMs: 40 };
const draft =
  "# Vuzmi alpha draft\n\n- [ ] Verify the local release.\n\nNo tests or deployment were performed.";

async function harness(t: TestContext) {
  const schema = `vuzmi_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const queueSchema = `${schema}_queue`;
  const options = { connectionString: databaseUrl!, schema, queueSchema };
  const repository = await PostgresRunRepository.connect(options);
  const sql = new Pool({ connectionString: databaseUrl!, max: 2 });
  const repositories = [repository];
  t.after(async () => {
    for (const candidate of repositories) await candidate.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  async function reopen() {
    const reopened = await PostgresRunRepository.connect(options);
    repositories.push(reopened);
    return reopened;
  }
  async function create(input = brief): Promise<Run> {
    return repository.create(input, {
      workspaceId: "local-workspace",
      id: randomUUID(),
      model: input.model,
    });
  }
  return { repository, sql, schema, queueSchema, options, reopen, create };
}

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 12_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > end)
      throw new Error("Timed out waiting for the real PostgreSQL worker.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function payload(run: Run) {
  return {
    workspaceId: run.workspaceId,
    runId: run.id,
    model: run.route.model!,
  };
}

test("PostgreSQL runtime integration", { skip: !databaseUrl }, async (t) => {
  await t.test(
    "creation commits the run, append-only events, and queue job atomically",
    async (t) => {
      const { repository, sql, schema, queueSchema, create } = await harness(t);
      const run = await create();
      assert.equal(run.status, "queued");
      assert.equal(run.proposal, null);
      const jobs = await sql.query(
        `SELECT data FROM "${queueSchema}".job WHERE name = $1 AND data->>'runId' = $2`,
        [GENERATION_QUEUE, run.id],
      );
      assert.equal(jobs.rowCount, 1);
      assert.deepEqual(jobs.rows[0].data, payload(run));
      const events = await sql.query(
        `SELECT event FROM "${schema}".run_events WHERE workspace_id = $1 AND run_id = $2`,
        [run.workspaceId, run.id],
      );
      assert.deepEqual(
        events.rows.map((row) => row.event),
        run.events,
      );
      await assert.rejects(
        sql.query(
          `UPDATE "${schema}".run_events SET event = event WHERE workspace_id = $1 AND run_id = $2`,
          [run.workspaceId, run.id],
        ),
        /append-only/,
      );

      const failingId = randomUUID();
      const originalSend = repository.boss.send;
      repository.boss.send = async () => {
        throw new Error("Queue insert fixture failure");
      };
      try {
        await assert.rejects(
          repository.create(brief, {
            workspaceId: "local-workspace",
            id: failingId,
            model: brief.model,
          }),
          /fixture failure/,
        );
      } finally {
        repository.boss.send = originalSend;
      }
      assert.equal(
        await repository.get("local-workspace", failingId),
        undefined,
      );
      const rolledBack = await sql.query(
        `SELECT count(*)::integer AS count FROM "${schema}".run_events WHERE run_id = $1`,
        [failingId],
      );
      assert.equal(rolledBack.rows[0].count, 0);
    },
  );

  await t.test(
    "ordinary duplicates cannot steal an attempt and obsolete results cannot replace recovery",
    async (t) => {
      const { repository, create } = await harness(t);
      const run = await create();
      const first = await repository.claim(run.workspaceId, run.id, {
        attemptId: "attempt-old",
        model: run.route.model!,
      });
      assert.equal(first?.status, "running");
      assert.equal(
        await repository.claim(run.workspaceId, run.id, {
          attemptId: "duplicate",
        }),
        undefined,
      );
      const recovered = await repository.claim(run.workspaceId, run.id, {
        attemptId: "attempt-new",
        allowRecovery: true,
      });
      assert.ok(recovered);
      assert.equal(
        await repository.complete(run.workspaceId, run.id, {
          attemptId: first!.attemptId!,
          expectedRevision: first!.revision,
          content: "Obsolete output",
          usage,
        }),
        undefined,
      );
      const result = await repository.complete(run.workspaceId, run.id, {
        attemptId: recovered.attemptId!,
        expectedRevision: recovered.revision,
        content: draft,
        usage,
      });
      assert.equal(result?.status, "waiting_approval");
      assert.equal(result?.proposal?.content, draft);
      assert.equal(
        await repository.fail(run.workspaceId, run.id, {
          attemptId: first!.attemptId!,
          expectedRevision: first!.revision,
          willRetry: false,
          error: {
            code: "OLD_FAILURE",
            message: "Obsolete failure",
            retryable: false,
          },
        }),
        undefined,
      );
      assert.equal(
        (await repository.get(run.workspaceId, run.id))?.status,
        "waiting_approval",
      );
    },
  );

  await t.test(
    "concurrent decisions across repository instances create one artifact and one event sequence",
    async (t) => {
      const { repository, sql, schema, create, reopen } = await harness(t);
      const run = await create({ ...brief, mode: "simulation" });
      const other = await reopen();
      const decision = {
        decision: "approve" as const,
        revision: run.revision,
        fingerprint: run.proposal!.fingerprint,
      };
      const results = await Promise.all([
        repository.decide(run.workspaceId, run.id, decision),
        other.decide(run.workspaceId, run.id, decision),
      ]);
      assert.equal(results[0]!.status, "completed");
      assert.deepEqual(results[0], results[1]);
      const artifacts = await sql.query(
        `SELECT content FROM "${schema}".artifacts WHERE workspace_id = $1 AND run_id = $2`,
        [run.workspaceId, run.id],
      );
      assert.equal(artifacts.rowCount, 1);
      assert.equal(artifacts.rows[0].content, run.proposal!.content);
      const events = await sql.query(
        `SELECT sequence FROM "${schema}".run_events WHERE workspace_id = $1 AND run_id = $2 ORDER BY sequence`,
        [run.workspaceId, run.id],
      );
      assert.deepEqual(
        events.rows.map((row) => row.sequence),
        [1, 2, 3, 4, 5],
      );
      await assert.rejects(
        other.decide(run.workspaceId, run.id, {
          ...decision,
          decision: "reject",
        }),
        /already been decided/,
      );
    },
  );

  await t.test(
    "stale decisions and unrelated workspaces cannot change a run",
    async (t) => {
      const { repository, create } = await harness(t);
      const run = await create({ ...brief, mode: "simulation" });
      const decision = {
        decision: "approve" as const,
        revision: run.revision + 1,
        fingerprint: run.proposal!.fingerprint,
      };
      await assert.rejects(
        repository.decide(run.workspaceId, run.id, decision),
        /proposal has changed/,
      );
      assert.equal(
        await repository.get("another-workspace", run.id),
        undefined,
      );
      assert.deepEqual(await repository.list("another-workspace"), []);
      assert.equal(
        await repository.claim("another-workspace", run.id, {
          attemptId: "not-authorized",
        }),
        undefined,
      );
      await assert.rejects(
        repository.decide("another-workspace", run.id, {
          ...decision,
          revision: run.revision,
        }),
        /does not exist/,
      );
      assert.equal(
        (await repository.get(run.workspaceId, run.id))?.status,
        "waiting_approval",
      );
    },
  );

  await t.test(
    "reopening preserves an interrupted run and redelivery recovers a concrete draft",
    async (t) => {
      const { repository, create, reopen } = await harness(t);
      const run = await create();
      await repository.claim(run.workspaceId, run.id, {
        attemptId: "interrupted-attempt",
      });
      await repository.close();
      const recovered = await reopen();
      let calls = 0;
      await processRunJob({
        repository: recovered,
        job: { data: payload(run), retryCount: 1 },
        generate: async () => {
          calls += 1;
          return { content: draft, usage };
        },
      });
      const waiting = await recovered.get(run.workspaceId, run.id);
      assert.equal(waiting?.status, "waiting_approval");
      assert.equal(waiting?.proposal?.content, draft);
      assert.equal(waiting?.route.executed, true);
      await processRunJob({
        repository: recovered,
        job: { data: payload(run), retryCount: 2 },
        generate: async () => {
          calls += 1;
          return { content: "Must not run", usage };
        },
      });
      assert.equal(calls, 1);
      await recovered.close();
      const reopened = await reopen();
      assert.deepEqual(await reopened.get(run.workspaceId, run.id), waiting);
    },
  );

  await t.test(
    "retryable failures are bounded and terminal failure remains inspectable",
    async (t) => {
      const { repository, create } = await harness(t);
      const run = await create();
      const generate = async () => {
        throw Object.assign(
          new Error("Local fixture service is temporarily unavailable."),
          { code: "UNAVAILABLE", retryable: true },
        );
      };
      for (const retryCount of [0, 1]) {
        await assert.rejects(
          processRunJob({
            repository,
            job: { data: payload(run), retryCount },
            generate,
          }),
          /UNAVAILABLE/,
        );
        assert.equal(
          (await repository.get(run.workspaceId, run.id))?.status,
          "queued",
        );
      }
      await processRunJob({
        repository,
        job: { data: payload(run), retryCount: 2 },
        generate,
      });
      const failed = await repository.get(run.workspaceId, run.id);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.error?.code, "UNAVAILABLE");
      assert.equal(
        failed?.events.filter((event) => event.type === "generation.started")
          .length,
        3,
      );
      assert.equal(failed?.proposal, null);
    },
  );

  await t.test(
    "lost queue leases fence ignored-abort output before a replacement attempt runs",
    async (t) => {
      const { repository, create } = await harness(t);
      const run = await create();
      const lease = new AbortController();
      const shutdown = new AbortController();
      let generationStarted!: () => void;
      let releaseObsoleteOutput!: (value: {
        content: string;
        usage: Usage;
      }) => void;
      const started = new Promise<void>((resolve) => {
        generationStarted = resolve;
      });
      const obsoleteOutput = new Promise<{ content: string; usage: Usage }>(
        (resolve) => {
          releaseObsoleteOutput = resolve;
        },
      );
      let observedSignal: AbortSignal | undefined;
      const staleOperation = processRunJob({
        repository,
        job: { data: payload(run), retryCount: 0, signal: lease.signal },
        signal: shutdown.signal,
        generate: async ({ signal }) => {
          observedSignal = signal;
          generationStarted();
          return obsoleteOutput; // Deliberately ignores cancellation to exercise the write boundary.
        },
      });
      const staleRejected = assert.rejects(staleOperation, /QUEUE_LEASE_LOST/);
      await started;
      lease.abort();
      assert.equal(
        observedSignal?.aborted,
        true,
        "the generator receives the queue and shutdown signals combined",
      );
      await until(
        () => repository.get(run.workspaceId, run.id),
        (current) =>
          current?.status === "queued" &&
          current.error?.code === "QUEUE_LEASE_LOST",
      );
      assert.equal(
        (await repository.get(run.workspaceId, run.id))?.proposal,
        null,
      );
      await processRunJob({
        repository,
        job: {
          data: payload(run),
          retryCount: 1,
          signal: new AbortController().signal,
        },
        generate: async () => ({ content: draft, usage }),
      });
      releaseObsoleteOutput({
        content: "OBSOLETE OUTPUT MUST NEVER BECOME A DRAFT",
        usage,
      });
      await staleRejected;
      const recovered = await repository.get(run.workspaceId, run.id);
      assert.equal(recovered?.status, "waiting_approval");
      assert.equal(recovered?.proposal?.content, draft);
      assert.equal(
        recovered?.events.filter(
          (event) => event.type === "generation.completed",
        ).length,
        1,
      );
    },
  );

  await t.test(
    "shutdown abort also fences ignored output and an already lost lease cannot start generation",
    async (t) => {
      const { repository, create } = await harness(t);
      const run = await create();
      const shutdown = new AbortController();
      await assert.rejects(
        processRunJob({
          repository,
          job: {
            data: payload(run),
            retryCount: 0,
            signal: new AbortController().signal,
          },
          signal: shutdown.signal,
          generate: async ({ signal }) => {
            shutdown.abort();
            assert.equal(signal?.aborted, true);
            return { content: "DISCARDED SHUTDOWN OUTPUT", usage };
          },
        }),
        /WORKER_STOPPING/,
      );
      const queued = await repository.get(run.workspaceId, run.id);
      assert.equal(queued?.status, "queued");
      assert.equal(queued?.proposal, null);
      const expired = new AbortController();
      expired.abort();
      let calls = 0;
      await processRunJob({
        repository,
        job: { data: payload(run), retryCount: 1, signal: expired.signal },
        generate: async () => {
          calls += 1;
          return { content: draft, usage };
        },
      });
      assert.equal(calls, 0);
      assert.deepEqual(await repository.get(run.workspaceId, run.id), queued);
    },
  );

  await t.test(
    "a real pg-boss worker consumes duplicate jobs once and publishes a fresh heartbeat",
    async (t) => {
      const { repository, create } = await harness(t);
      const run = await create();
      await repository.boss.send(GENERATION_QUEUE, payload(run), {
        singletonKey: `${run.workspaceId}:${run.id}`,
      });
      let calls = 0;
      assert.equal((await repository.workerHealth()).state, "offline");
      const worker = await startWorker({
        repository,
        generate: async () => {
          calls += 1;
          return { content: draft, usage };
        },
      });
      t.after(async () => worker.stop());
      assert.equal((await repository.workerHealth()).state, "ready");
      await until(
        () => repository.get(run.workspaceId, run.id),
        (current) => current?.status === "waiting_approval",
      );
      await until(
        () => repository.boss.findJobs(GENERATION_QUEUE),
        (jobs) => jobs.filter((job) => job.state === "completed").length === 2,
      );
      assert.equal(calls, 1);
      await worker.stop();
      assert.equal((await repository.workerHealth()).state, "offline");
    },
  );

  await t.test(
    "exhausted abandoned jobs become a visible failure",
    async (t) => {
      const { repository, create, sql, queueSchema } = await harness(t);
      const run = await create();
      const stillQueued = await create();
      await repository.claim(run.workspaceId, run.id, {
        attemptId: "crashed-final-attempt",
      });
      // Simulate pg-boss having exhausted the job lease/retry budget after a process loss.
      await sql.query(
        `UPDATE "${queueSchema}".job SET state = 'failed' WHERE name = $1 AND data->>'runId' = ANY($2::text[])`,
        [GENERATION_QUEUE, [run.id, stillQueued.id]],
      );
      await repository.reconcileExhausted();
      const failed = await repository.get(run.workspaceId, run.id);
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.error?.code, "QUEUE_RETRIES_EXHAUSTED");
      assert.equal(
        (await repository.get(stillQueued.workspaceId, stillQueued.id))?.status,
        "failed",
      );
    },
  );

  await t.test("migration checksum mismatch refuses startup", async (t) => {
    const { repository, sql, schema, options } = await harness(t);
    await repository.close();
    await sql.query(
      `UPDATE "${schema}".schema_migrations SET checksum = $1 WHERE version = $2`,
      ["tampered-fixture-checksum", 1],
    );
    await assert.rejects(
      PostgresRunRepository.connect(options),
      /checksum mismatch/,
    );
  });

  await t.test(
    "persisted proposal corruption fails validation on reads",
    async (t) => {
      const { repository, create, sql, schema } = await harness(t);
      const run = await create({ ...brief, mode: "simulation" });
      await sql.query(
        `UPDATE "${schema}".runs SET aggregate = jsonb_set(aggregate, '{proposal,content}', to_jsonb($3::text)) WHERE workspace_id = $1 AND id = $2`,
        [run.workspaceId, run.id, "Modified without matching fingerprint"],
      );
      await assert.rejects(
        repository.get(run.workspaceId, run.id),
        /fingerprint/,
      );
    },
  );
});
