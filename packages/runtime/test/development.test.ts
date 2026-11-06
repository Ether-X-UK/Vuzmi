import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  DevelopmentError,
  PostgresRunRepository,
  DEVELOPMENT_QUEUE,
  processDevelopmentJob,
} from "../src/index.js";
import type { DevelopmentRunnerAdapter } from "../src/development-worker.js";
import {
  developmentFixtureInput,
  developmentFixturePatch,
  developmentFixtureProfile,
  developmentFixtureReceipt,
  developmentFixtureRunner,
} from "./development-fixtures.js";

const url = process.env.VUZMI_TEST_DATABASE_URL,
  workspace = "local-workspace",
  actor = { id: "fixture-owner", name: "Fixture owner" };
const generated = () => ({
  patch: developmentFixturePatch,
  usage: { inputTokens: 10, outputTokens: 20, durationMs: 1 },
  modelDigest: "synthetic-local-digest",
});
const errorCode = (code: string) => (error: unknown) =>
  error instanceof DevelopmentError && error.code === code;
async function fixture(t: TestContext) {
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `development_test_${suffix}`,
    queueSchema = `development_queue_${suffix}`;
  const options = { connectionString: url!, schema, queueSchema };
  const repositories: PostgresRunRepository[] = [];
  const connect = async () => {
    const value = await PostgresRunRepository.connect(options);
    repositories.push(value);
    return value;
  };
  const repository = await connect(),
    sql = new Pool({ connectionString: url!, max: 3 }),
    workerId = randomUUID();
  await repository.development.heartbeat(workerId, {
    ready: true,
    reason: "Synthetic isolated-test fixture.",
    profile: developmentFixtureProfile,
  });
  t.after(async () => {
    for (const value of repositories) await value.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const create = async () =>
    (
      await repository.development.create(developmentFixtureInput(), {
        id: randomUUID(),
        actor: actor.id,
        profile: developmentFixtureProfile,
      })
    ).run;
  const execute = async (
    runId: string,
    runner = developmentFixtureRunner(),
    generate = async () => generated(),
  ) =>
    processDevelopmentJob({
      repository,
      runner,
      generate,
      workerId,
      job: { data: { workspaceId: workspace, runId } },
    });
  return {
    repository,
    sql,
    schema,
    queueSchema,
    workerId,
    create,
    execute,
    connect,
  };
}
test(
  "development persistence, worker and approval fences on isolated PostgreSQL",
  { skip: !url },
  async (t) => {
    await t.test(
      "migration4 preserves populated v3 and all previous checksums",
      async (t) => {
        const { repository, sql, schema, connect } = await fixture(t);
        const source = await repository.knowledge.createSource(workspace, {
          title: "Predevelopment source",
          format: "text",
          text: "A retained source must survive the additive development migration.",
        });
        const before = await repository.knowledge.getSource(
          workspace,
          source.id,
        );
        const checksums = await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations WHERE version<4 ORDER BY version`,
        );
        const previousMigrations = await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations WHERE version<=5 ORDER BY version`,
        );
        await repository.close();
        await sql.query(
          `DROP TABLE "${schema}".development_delivery_events,"${schema}".development_deliveries,"${schema}".development_delivery_runtime,"${schema}".development_application_events,"${schema}".development_applications,"${schema}".development_application_runtime,"${schema}".development_profiles,"${schema}".development_artifacts,"${schema}".development_attempts,"${schema}".development_run_events,"${schema}".development_runtime,"${schema}".development_runs`,
        );
        await sql.query(
          `DELETE FROM "${schema}".schema_migrations WHERE version>=4`,
        );
        const reopened = await connect();
        const after = await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations ORDER BY version`,
        );
        assert.deepEqual(
          after.rows.map((row) => row.version),
          [1, 2, 3, 4, 5, 6],
        );
        assert.deepEqual(after.rows.slice(0, 3), checksums.rows);
        assert.deepEqual(after.rows.slice(0, 5), previousMigrations.rows);
        assert.deepEqual(
          await reopened.knowledge.getSource(workspace, source.id),
          before,
        );
      },
    );
    await t.test(
      "concurrent request replay creates one aggregate/event/job and survives restart without readiness",
      async (t) => {
        const { repository, sql, schema, queueSchema, connect, workerId } =
          await fixture(t);
        const input = developmentFixtureInput();
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            repository.development.create(input, {
              id: randomUUID(),
              actor: actor.id,
              profile: developmentFixtureProfile,
            }),
          ),
        );
        assert.equal(new Set(results.map((value) => value.run.id)).size, 1);
        assert.equal(results.filter((value) => !value.replayed).length, 1);
        assert.equal(
          (
            await sql.query(
              `SELECT count(*)::integer count FROM "${schema}".development_run_events`,
            )
          ).rows[0].count,
          1,
        );
        assert.equal(
          (
            await sql.query(
              `SELECT count(*)::integer count FROM "${queueSchema}".job WHERE name=$1`,
              [DEVELOPMENT_QUEUE],
            )
          ).rows[0].count,
          1,
        );
        await assert.rejects(
          repository.development.findRequest(
            workspace,
            {
              ...input,
              brief:
                "A different task must not reuse the same request identity.",
            },
            actor.id,
          ),
          errorCode("DEVELOPMENT_REQUEST_CONFLICT"),
        );
        await repository.development.removeHeartbeat(workerId);
        await repository.close();
        const reopened = await connect();
        assert.deepEqual(
          await reopened.development.findRequest(workspace, input, actor.id),
          results[0]!.run,
        );
        assert.equal(
          (
            await reopened.development.create(input, {
              id: randomUUID(),
              actor: actor.id,
              profile: developmentFixtureProfile,
            })
          ).replayed,
          true,
        );
        await assert.rejects(
          reopened.development.get("another-workspace", results[0]!.run.id),
          errorCode("DEVELOPMENT_NOT_FOUND"),
        );
      },
    );
    await t.test(
      "missing indexing-equivalent queue effect rolls back the entire development admission",
      async (t) => {
        const { repository, sql, schema } = await fixture(t),
          send = repository.boss.send;
        try {
          repository.boss.send = (async () => null) as typeof send;
          await assert.rejects(
            repository.development.create(developmentFixtureInput(), {
              id: randomUUID(),
              actor: actor.id,
              profile: developmentFixtureProfile,
            }),
            errorCode("DEVELOPMENT_QUEUE_UNAVAILABLE"),
          );
          assert.equal(
            (
              await sql.query(
                `SELECT count(*)::integer count FROM "${schema}".development_runs`,
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await sql.query(
                `SELECT count(*)::integer count FROM "${schema}".development_run_events`,
              )
            ).rows[0].count,
            0,
          );
        } finally {
          repository.boss.send = send;
        }
      },
    );
    await t.test(
      "one model proposal leads to exact reviewed package; concurrent decisions and downloads are idempotent",
      async (t) => {
        const { repository, create, execute, sql, schema, connect } =
            await fixture(t),
          run = await create();
        let calls = 0;
        await execute(run.id, developmentFixtureRunner(), async () => {
          calls++;
          return generated();
        });
        await execute(run.id, developmentFixtureRunner(), async () => {
          calls++;
          return generated();
        });
        const waiting = (await repository.development.get(workspace, run.id))!;
        assert.equal(waiting.status, "waiting_approval");
        assert.equal(calls, 1);
        assert.equal(
          await repository.get(workspace, run.id),
          undefined,
          "development jobs never become native/founder document approvals",
        );
        await assert.rejects(
          repository.development.decide(
            workspace,
            run.id,
            {
              decision: "approve",
              revision: waiting.revision - 1,
              fingerprint: waiting.reviewFingerprint!,
            },
            actor,
          ),
          errorCode("STALE_APPROVAL"),
        );
        const decision = {
          decision: "approve" as const,
          revision: waiting.revision,
          fingerprint: waiting.reviewFingerprint!,
        };
        const decided = await Promise.all([
          repository.development.decide(workspace, run.id, decision, actor),
          repository.development.decide(workspace, run.id, decision, actor),
        ]);
        assert.deepEqual(decided[0], decided[1]);
        assert.equal(
          (
            await sql.query(
              `SELECT count(*)::integer count FROM "${schema}".development_artifacts`,
            )
          ).rows[0].count,
          1,
        );
        const artifact = await repository.development.package(
          workspace,
          run.id,
        );
        assert.equal(artifact.content, decided[0]!.artifact!.content);
        await repository.close();
        const reopened = await connect();
        assert.deepEqual(
          await reopened.development.package(workspace, run.id),
          artifact,
        );
        assert.deepEqual(
          await reopened.development.decide(workspace, run.id, decision, actor),
          decided[0],
        );
      },
    );
    await t.test(
      "failed baseline/candidate and invalid patches are nonapprovable and never silently fall back",
      async (t) => {
        const { repository, create, execute } = await fixture(t);
        for (const failure of ["baseline", "candidate", "patch"]) {
          const run = await create(),
            runner = developmentFixtureRunner();
          let calls = 0;
          runner.run = async (input) =>
            developmentFixtureReceipt(
              input,
              failure === input.phase
                ? {
                    status: input.phase === "baseline" ? "passed" : "failed",
                    exitCode: input.phase === "baseline" ? 0 : 1,
                    tests:
                      input.phase === "baseline"
                        ? developmentFixtureReceipt(input).tests.map(
                            (test) => ({ ...test, passed: true }),
                          )
                        : developmentFixtureReceipt(input).tests.map(
                            (test, index) => ({ ...test, passed: index !== 0 }),
                          ),
                  }
                : {},
            );
          await execute(run.id, runner, async () => {
            calls++;
            return failure === "patch"
              ? {
                  ...generated(),
                  patch: {
                    ...developmentFixturePatch,
                    files: [
                      {
                        ...developmentFixturePatch.files[0],
                        beforeSha256: "0".repeat(64),
                      },
                    ],
                  },
                }
              : generated();
          });
          const failed = (await repository.development.get(workspace, run.id))!;
          assert.equal(failed.status, "failed");
          assert.equal(failed.artifact, undefined);
          assert.equal(calls, failure === "baseline" ? 0 : 1);
          await assert.rejects(
            repository.development.package(workspace, run.id),
            errorCode("DEVELOPMENT_NOT_APPROVED"),
          );
          await assert.rejects(
            repository.development.decide(
              workspace,
              run.id,
              {
                decision: "approve",
                revision: failed.revision,
                fingerprint: "0".repeat(64),
              },
              actor,
            ),
          );
        }
      },
    );
    await t.test(
      "a schema-valid no-op retains observed generation facts without accepting a patch",
      async (t) => {
        const { repository, create, execute, connect } = await fixture(t);
        const run = await create();
        const observed = generated();
        await execute(run.id, developmentFixtureRunner(), async () => ({
          ...observed,
          patch: {
            ...observed.patch,
            files: [
              {
                ...observed.patch.files[0],
                content: developmentFixtureProfile.files[0].text,
              },
            ],
          },
        }));
        const failed = (await repository.development.get(workspace, run.id))!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.error?.code, "INVALID_PATCH");
        assert.equal(failed.routeExecuted, true);
        assert.equal(failed.modelDigest, observed.modelDigest);
        assert.deepEqual(failed.usage, observed.usage);
        assert.equal(failed.candidate, null);
        assert.equal(failed.checks, null);
        assert.equal(failed.artifact, undefined);
        assert.equal(
          failed.revision,
          5,
          "Recording known usage uses the existing failure transition.",
        );
        await repository.close();
        const reopened = await connect();
        assert.deepEqual(
          await reopened.development.get(workspace, run.id),
          failed,
        );
      },
    );
    await t.test(
      "a provider error does not invent observed generation facts",
      async (t) => {
        const { repository, create, execute } = await fixture(t);
        const run = await create();
        await execute(run.id, developmentFixtureRunner(), async () => {
          throw new Error("Synthetic provider failure before a result.");
        });
        const failed = (await repository.development.get(workspace, run.id))!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.routeExecuted, false);
        assert.equal(failed.modelDigest, null);
        assert.equal(failed.usage, null);
      },
    );
    await t.test(
      "queue abort fences ignored-abort generation and cannot produce a late candidate",
      async (t) => {
        const { repository, create, workerId } = await fixture(t),
          run = await create(),
          lease = new AbortController();
        let started!: () => void,
          release!: (value: ReturnType<typeof generated>) => void;
        const began = new Promise<void>((resolve) => {
          started = resolve;
        });
        const deferred = new Promise<ReturnType<typeof generated>>(
          (resolve) => {
            release = resolve;
          },
        );
        const cleaned: string[] = [];
        const runner = developmentFixtureRunner();
        runner.cleanup = async (id) => {
          cleaned.push(id);
          return true;
        };
        const operation = processDevelopmentJob({
          repository,
          workerId,
          runner,
          generate: async () => {
            started();
            return deferred;
          },
          job: {
            data: { workspaceId: workspace, runId: run.id },
            signal: lease.signal,
          },
        });
        await began;
        lease.abort();
        await operation;
        release(generated());
        await new Promise((resolve) => setImmediate(resolve));
        const failed = (await repository.development.get(workspace, run.id))!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.candidate, null);
        assert.equal(failed.routeExecuted, false);
        assert.equal(failed.modelDigest, null);
        assert.equal(failed.usage, null);
        assert.equal(failed.artifact, undefined);
        assert.equal(cleaned.length, 1);
        assert.ok(cleaned[0]!.endsWith("-baseline"));
      },
    );
    await t.test(
      "stale worker reconciliation fences its reserved execution and ignores a late passed receipt",
      async (t) => {
        const { repository, create, workerId, sql, schema } = await fixture(t),
          run = await create(),
          runner = developmentFixtureRunner();
        let began!: () => void, finish!: () => void;
        const started = new Promise<void>((resolve) => {
            began = resolve;
          }),
          deferred = new Promise<void>((resolve) => {
            finish = resolve;
          });
        runner.run = async (input) => {
          if (input.phase === "candidate") {
            began();
            await deferred;
          }
          return developmentFixtureReceipt(input);
        };
        const operation = processDevelopmentJob({
          repository,
          workerId,
          runner,
          generate: async () => generated(),
          job: { data: { workspaceId: workspace, runId: run.id } },
        });
        await started;
        const replacement = randomUUID(),
          cleaned: string[] = [];
        await repository.development.heartbeat(replacement, {
          ready: true,
          reason: "Replacement fixture.",
          profile: developmentFixtureProfile,
        });
        await repository.development.reconcile(replacement, async (id) => {
          cleaned.push(id);
          return true;
        });
        assert.equal(
          cleaned.length,
          0,
          "fresh worker authority cannot be stolen",
        );
        await sql.query(
          `UPDATE "${schema}".development_runtime SET seen_at=clock_timestamp()-interval '1 minute' WHERE worker_id=$1`,
          [workerId],
        );
        await repository.development.reconcile(replacement, async (id) => {
          cleaned.push(id);
          return true;
        });
        assert.equal(cleaned.length, 2);
        finish();
        await operation;
        const failed = (await repository.development.get(workspace, run.id))!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.checks, null);
        assert.equal(failed.error?.code, "DEVELOPMENT_INTERRUPTED");
        assert.equal(failed.artifact, undefined);
      },
    );
    await t.test(
      "a resumed heartbeat cannot revive an expired execution attempt",
      async (t) => {
        const { repository, create, sql, schema, workerId } = await fixture(t);
        const run = await create();
        const claimed = (await repository.development.claim(
          workspace,
          run.id,
          workerId,
          randomUUID(),
        ))!;
        await sql.query(
          `UPDATE "${schema}".development_attempts SET seen_at=clock_timestamp()-interval '1 minute' WHERE run_id=$1`,
          [run.id],
        );
        await sql.query(
          `UPDATE "${schema}".development_runtime SET seen_at=clock_timestamp()-interval '1 minute' WHERE worker_id=$1`,
          [workerId],
        );
        await repository.development.heartbeat(workerId, {
          ready: true,
          reason: "A resumed fixture worker.",
          profile: developmentFixtureProfile,
        });
        assert.equal(
          await repository.development.reserveExecution(
            workspace,
            run.id,
            {
              workerId,
              attemptId: claimed.attemptId!,
              revision: claimed.revision,
            },
            "baseline",
            `vuzmi-dev-${run.id}-${claimed.attemptId}-baseline`,
          ),
          undefined,
        );
        await repository.development.reconcile(workerId, async () => true);
        assert.equal(
          (await repository.development.get(workspace, run.id))!.status,
          "failed",
        );
      },
    );
    await t.test(
      "exhausted and restored jobs become visible failures without new executions",
      async (t) => {
        const { repository, create, sql, queueSchema, workerId } =
            await fixture(t),
          run = await create();
        await sql.query(
          `UPDATE "${queueSchema}".job SET state='failed' WHERE name=$1 AND data->>'runId'=$2`,
          [DEVELOPMENT_QUEUE, run.id],
        );
        let cleanups = 0;
        await repository.development.reconcile(workerId, async () => {
          cleanups++;
          return true;
        });
        assert.equal(
          (await repository.development.get(workspace, run.id))?.status,
          "failed",
        );
        assert.equal(cleanups, 0);
      },
    );
  },
);
