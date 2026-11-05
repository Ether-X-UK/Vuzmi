import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import type { DevelopmentApplication } from "@vuzmi/core";
import { Pool } from "pg";
import {
  developmentApplicationInputSchema,
  createDevelopmentApplicationPlan,
  createDevelopmentApplication,
  withDevelopmentApplicationEvent,
} from "@vuzmi/core";
import {
  PostgresRunRepository,
  processDevelopmentJob,
  processDevelopmentApplicationJob,
  createDevelopmentGitConnector,
  DEVELOPMENT_APPLICATION_QUEUE,
} from "../src/index.js";
import {
  applicationGitFixture,
  applicationActor,
  approvedApplicationFixture,
} from "./application-fixtures.js";
import {
  developmentFixtureInput,
  developmentFixturePatch,
  developmentFixtureReceipt,
  digest,
} from "./development-fixtures.js";
const url = process.env.VUZMI_TEST_DATABASE_URL,
  workspace = "local-workspace";
async function fixture(t: TestContext) {
  const git = await applicationGitFixture();
  t.after(git.cleanup);
  const suffix = randomUUID().replaceAll("-", ""),
    schema = `application_test_${suffix}`,
    queueSchema = `application_queue_${suffix}`,
    options = { connectionString: url!, schema, queueSchema },
    connections: PostgresRunRepository[] = [];
  const connect = async () => {
    const value = await PostgresRunRepository.connect(options);
    connections.push(value);
    return value;
  };
  const repository = await connect(),
    sql = new Pool({ connectionString: url!, max: 3 }),
    workerId = randomUUID(),
    connector = createDevelopmentGitConnector({
      repositoryPath: git.directory,
    });
  await repository.development.heartbeat(workerId, {
    ready: true,
    reason: "Synthetic fixture profile.",
    profile: git.profile,
  });
  await repository.applications.heartbeat(
    workerId,
    await connector.readiness(),
  );
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const input = {
    ...developmentFixtureInput(),
    profileHash: git.profile.profileHash,
  };
  const run = (
    await repository.development.create(input, {
      id: randomUUID(),
      actor: applicationActor.id,
      profile: git.profile,
    })
  ).run;
  await processDevelopmentJob({
    repository,
    workerId,
    runner: {
      readiness: async () => ({
        ready: true,
        reason: "Synthetic fixture",
        profile: git.profile,
      }),
      run: async (input) =>
        developmentFixtureReceipt(input, {
          profileHash: git.profile.profileHash,
          baseImageId: git.profile.baseImage,
          imageId: git.profile.baseImage,
        }),
      cleanup: async () => true,
    },
    generate: async () => ({
      patch: developmentFixturePatch,
      usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      modelDigest: "synthetic-digest",
    }),
    job: { data: { workspaceId: workspace, runId: run.id } },
  });
  const waiting = (await repository.development.get(workspace, run.id))!;
  assert.equal(waiting.status, "waiting_approval");
  const approved = await repository.development.decide(
    workspace,
    run.id,
    {
      decision: "approve",
      revision: waiting.revision,
      fingerprint: waiting.reviewFingerprint!,
    },
    applicationActor,
  );
  const plan = (await repository.applications.plan(workspace, run.id)).plan;
  const request = {
    requestId: randomUUID(),
    packageSha256: plan.packageSha256,
    planFingerprint: plan.fingerprint,
  };
  return {
    git,
    repository,
    sql,
    schema,
    queueSchema,
    connect,
    workerId,
    connector,
    approved,
    plan,
    request,
  };
}
test(
  "durable separately authorized application on isolated PostgreSQL",
  { skip: !url },
  async (t) => {
    await t.test(
      "concurrent exact request creates one job and survives restart, approval/package stay immutable",
      async (t) => {
        const f = await fixture(t),
          before = JSON.parse(JSON.stringify(f.approved));
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            f.repository.applications.authorize(
              workspace,
              f.approved.id,
              f.request,
              applicationActor,
            ),
          ),
        );
        assert.equal(
          new Set(results.map((value) => value.operation.id)).size,
          1,
        );
        assert.equal(results.filter((value) => !value.replayed).length, 1);
        assert.equal(
          (
            await f.sql.query(
              `SELECT count(*)::int count FROM "${f.queueSchema}".job WHERE name=$1`,
              [DEVELOPMENT_APPLICATION_QUEUE],
            )
          ).rows[0].count,
          1,
        );
        await assert.rejects(
          f.repository.applications.authorize(
            workspace,
            f.approved.id,
            { ...f.request, planFingerprint: "0".repeat(64) },
            applicationActor,
          ),
          { code: "APPLICATION_REQUEST_CONFLICT" },
        );
        await assert.rejects(
          f.repository.applications.authorize(
            workspace,
            f.approved.id,
            f.request,
            { id: "another-owner" },
          ),
          { code: "APPLICATION_REQUEST_CONFLICT" },
        );
        await f.repository.close();
        const reopened = await f.connect();
        assert.deepEqual(
          await reopened.applications.get(workspace, f.approved.id),
          results[0].operation,
        );
        assert.equal(
          (
            await reopened.applications.authorize(
              workspace,
              f.approved.id,
              f.request,
              applicationActor,
            )
          ).replayed,
          true,
        );
        assert.deepEqual(
          JSON.parse(
            JSON.stringify(
              await reopened.development.get(workspace, f.approved.id),
            ),
          ),
          before,
        );
      },
    );
    await t.test(
      "missing queue effect rolls back authorization and event; stale plan cannot enqueue",
      async (t) => {
        const f = await fixture(t),
          send = f.repository.boss.send;
        await assert.rejects(
          f.repository.applications.authorize(
            workspace,
            f.approved.id,
            { ...f.request, packageSha256: "0".repeat(64) },
            applicationActor,
          ),
          { code: "STALE_APPLICATION_PLAN" },
        );
        f.repository.boss.send = (async () => null) as typeof send;
        try {
          await assert.rejects(
            f.repository.applications.authorize(
              workspace,
              f.approved.id,
              f.request,
              applicationActor,
            ),
            { code: "APPLICATION_QUEUE_UNAVAILABLE" },
          );
          assert.equal(
            await f.repository.applications.get(workspace, f.approved.id),
            undefined,
          );
          assert.equal(
            (
              await f.sql.query(
                `SELECT count(*)::int count FROM "${f.schema}".development_application_events`,
              )
            ).rows[0].count,
            0,
          );
        } finally {
          f.repository.boss.send = send;
        }
      },
    );
    await t.test(
      "worker writes one real branch and durable receipt without changing checkout or approved package",
      async (t) => {
        const f = await fixture(t),
          before = await f.git.snapshot(),
          artifact = f.approved.artifact!.content;
        const { operation } = await f.repository.applications.authorize(
          workspace,
          f.approved.id,
          f.request,
          applicationActor,
        );
        const job = {
          data: { workspaceId: workspace, applicationId: operation.id },
        };
        await processDevelopmentApplicationJob({
          repository: f.repository,
          connector: f.connector,
          workerId: f.workerId,
          job,
        });
        await processDevelopmentApplicationJob({
          repository: f.repository,
          connector: f.connector,
          workerId: f.workerId,
          job,
        });
        const applied = (await f.repository.applications.get(
          workspace,
          f.approved.id,
        ))!;
        assert.equal(applied.status, "applied");
        assert.equal(applied.receipt!.packageSha256, f.plan.packageSha256);
        assert.equal(
          applied.events.filter((event) => event.type === "application.applied")
            .length,
          1,
        );
        assert.deepEqual(await f.git.snapshot(), before);
        assert.equal(
          (await f.repository.development.package(workspace, f.approved.id))
            .content,
          artifact,
        );
        await f.repository.close();
        const reopened = await f.connect();
        assert.deepEqual(
          await reopened.applications.get(workspace, f.approved.id),
          applied,
        );
        await reopened.applications.removeHeartbeat(f.workerId);
        assert.deepEqual(
          await reopened.applications.get(workspace, f.approved.id),
          applied,
        );
      },
    );
    await t.test(
      "crash after ref creation reconciles exact commit without replaying Git effects; stale attempts cannot publish receipts",
      async (t) => {
        const f = await fixture(t),
          authorized = await f.repository.applications.authorize(
            workspace,
            f.approved.id,
            f.request,
            applicationActor,
          ),
          attemptId = randomUUID();
        let operation = (await f.repository.applications.claim(
          workspace,
          authorized.operation.id,
          f.workerId,
          attemptId,
        ))!;
        const context = () => ({
          workerId: f.workerId,
          attemptId,
          revision: operation.revision,
        });
        const prepared = await f.connector.prepare(operation, f.approved);
        operation = (await f.repository.applications.prepared(
          workspace,
          operation.id,
          context(),
          prepared,
        ))!;
        await f.connector.apply(operation);
        await f.sql.query(
          `UPDATE "${f.schema}".development_applications SET seen_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
          [operation.id],
        );
        assert.equal(
          await f.repository.applications.applied(
            workspace,
            operation.id,
            context(),
          ),
          undefined,
        );
        await f.repository.applications.reconcile(f.connector);
        const reconciled = (await f.repository.applications.get(
          workspace,
          f.approved.id,
        ))!;
        assert.equal(reconciled.status, "applied");
        assert.equal(reconciled.receipt!.commitOid, prepared.commitOid);
        assert.equal(
          reconciled.events.filter(
            (event) => event.type === "application.applied",
          ).length,
          1,
        );
      },
    );
    await t.test(
      "aborted queue signal, lost jobs and restore quarantine never create a branch",
      async (t) => {
        const f = await fixture(t),
          { operation } = await f.repository.applications.authorize(
            workspace,
            f.approved.id,
            f.request,
            applicationActor,
          ),
          controller = new AbortController();
        controller.abort();
        await processDevelopmentApplicationJob({
          repository: f.repository,
          connector: f.connector,
          workerId: f.workerId,
          job: {
            data: { workspaceId: workspace, applicationId: operation.id },
            signal: controller.signal,
          },
        });
        assert.equal(
          (await f.repository.applications.get(workspace, f.approved.id))!
            .status,
          "queued",
        );
        await f.sql.query(
          `UPDATE "${f.queueSchema}".job SET state='cancelled',completed_on=now() WHERE name=$1`,
          [DEVELOPMENT_APPLICATION_QUEUE],
        );
        await f.repository.applications.reconcile(f.connector);
        const unknown = (await f.repository.applications.get(
          workspace,
          f.approved.id,
        ))!;
        assert.equal(unknown.status, "unconfirmed");
        assert.equal(await f.connector.inspect(unknown), "absent");
        assert.equal(unknown.receipt, undefined);
        await assert.rejects(
          f.repository.applications.get("foreign-workspace", f.approved.id),
          { code: "APPLICATION_NOT_FOUND" },
        );
        assert.equal(
          developmentApplicationInputSchema.safeParse({
            ...f.request,
            destinationRef: "refs/heads/main",
          }).success,
          false,
        );
      },
    );
    await t.test(
      "mid-generation lease loss and queue abort cannot reach branch effects",
      async (t) => {
        const f = await fixture(t),
          { operation } = await f.repository.applications.authorize(
            workspace,
            f.approved.id,
            f.request,
            applicationActor,
          ),
          controller = new AbortController();
        let applyCalls = 0;
        let entered!: () => void, release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
        const pending = processDevelopmentApplicationJob({
          repository: f.repository,
          workerId: f.workerId,
          connector: {
            ...f.connector,
            prepare: async (op, run) => {
              entered();
              await gate;
              return f.connector.prepare(op, run);
            },
            apply: async () => {
              applyCalls++;
            },
          },
          job: {
            data: { workspaceId: workspace, applicationId: operation.id },
            signal: controller.signal,
          },
        });
        await enteredPromise;
        controller.abort();
        release();
        await pending;
        assert.equal(applyCalls, 0);
        const interrupted = (await f.repository.applications.get(
          workspace,
          f.approved.id,
        ))!;
        assert.equal(interrupted.status, "unavailable");
        assert.equal(await f.connector.inspect(interrupted), "absent");
        assert.equal(interrupted.receipt, undefined);
      },
    );
    await t.test(
      "readiness or registration loss fences late output and cannot leave a fresh running lease",
      async (t) => {
        for (const readiness of [
          { ready: false, reason: "Synthetic connector outage" },
          {
            ready: true,
            reason: "Synthetic changed registration",
            repositoryIdentity: "9".repeat(64),
          },
        ]) {
          const f = await fixture(t),
            { operation } = await f.repository.applications.authorize(
              workspace,
              f.approved.id,
              f.request,
              applicationActor,
            );
          let entered!: () => void, release!: () => void;
          const enteredPromise = new Promise<void>((resolve) => {
              entered = resolve;
            }),
            gate = new Promise<void>((resolve) => {
              release = resolve;
            });
          let effects = 0;
          const pending = processDevelopmentApplicationJob({
            repository: f.repository,
            workerId: f.workerId,
            connector: {
              ...f.connector,
              prepare: async (op, run) => {
                entered();
                await gate;
                return f.connector.prepare(op, run);
              },
              apply: async () => {
                effects++;
              },
            },
            job: {
              data: { workspaceId: workspace, applicationId: operation.id },
            },
          });
          await enteredPromise;
          await f.repository.applications.heartbeat(f.workerId, readiness);
          release();
          await pending;
          await f.repository.applications.reconcile(f.connector);
          const observed = (await f.repository.applications.get(
            workspace,
            f.approved.id,
          ))!;
          assert.equal(observed.status, "unconfirmed");
          assert.equal(effects, 0);
          assert.equal(await f.connector.inspect(observed), "absent");
        }
      },
    );
    await t.test(
      "bounded reconciliation fairly reaches later applied branches past permanent unknown/quarantined rows",
      async (t) => {
        const f = await fixture(t),
          { operation } = await f.repository.applications.authorize(
            workspace,
            f.approved.id,
            f.request,
            applicationActor,
          ),
          attemptId = randomUUID();
        let target = (await f.repository.applications.claim(
          workspace,
          operation.id,
          f.workerId,
          attemptId,
        ))!;
        const context = () => ({
          workerId: f.workerId,
          attemptId,
          revision: target.revision,
        });
        const prepared = await f.connector.prepare(target, f.approved);
        target = (await f.repository.applications.prepared(
          workspace,
          target.id,
          context(),
          prepared,
        ))!;
        await f.connector.apply(target);
        target = (await f.repository.applications.fail(
          workspace,
          target.id,
          context(),
          {
            code: "APPLICATION_UNCONFIRMED",
            message: "Synthetic crash gap after ref creation.",
          },
        ))!;
        const ignored = new Set<string>();
        let unknownInspections = 0;
        for (let index = 0; index < 35; index++) {
          const run = approvedApplicationFixture(f.git.profile),
            plan = createDevelopmentApplicationPlan(
              run,
              f.plan.repositoryIdentity,
              digest,
            );
          let seeded = createDevelopmentApplication(
            plan,
            {
              requestId: randomUUID(),
              packageSha256: plan.packageSha256,
              planFingerprint: plan.fingerprint,
            },
            {
              id: randomUUID(),
              actor: applicationActor,
              now: "2026-11-05T20:00:00.000Z",
              hash: digest,
            },
          );
          const unobservable = index >= 25,
            quarantined = index >= 25 && index < 30;
          seeded = withDevelopmentApplicationEvent(
            seeded,
            "application.unconfirmed",
            "Synthetic persisted unknown outcome for fair-recovery test.",
            seeded.authorizedAt,
            {
              status: "unconfirmed",
              ...(index < 30
                ? {
                    prepared: {
                      treeOid: "a".repeat(40),
                      commitOid: "b".repeat(40),
                      files: plan.files.map((file) => ({
                        ...file,
                        mode: "100644" as const,
                      })),
                    },
                  }
                : {}),
              ...(quarantined
                ? {
                    error: {
                      code: "APPLICATION_RESTORE_QUARANTINED",
                      message: "Synthetic restore quarantine",
                    },
                  }
                : {}),
            },
          );
          if (unobservable) ignored.add(seeded.id);
          await f.sql.query(
            `INSERT INTO "${f.schema}".development_runs(workspace_id,id,request_id,request_hash,owner_id,revision,status,aggregate,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
            [
              workspace,
              run.id,
              run.requestId,
              run.requestFingerprint,
              run.createdBy,
              run.revision,
              run.status,
              JSON.stringify(run),
              run.createdAt,
              run.updatedAt,
            ],
          );
          await f.sql.query(
            `INSERT INTO "${f.schema}".development_applications(workspace_id,id,run_id,request_id,revision,status,aggregate) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
              workspace,
              seeded.id,
              run.id,
              seeded.requestId,
              seeded.revision,
              seeded.status,
              JSON.stringify(seeded),
            ],
          );
        }
        const connector = {
          ...f.connector,
          inspect: async (value: DevelopmentApplication) => {
            assert.equal(ignored.has(value.id), false);
            if (value.id === target.id) return f.connector.inspect(value);
            unknownInspections++;
            return "absent" as const;
          },
        };
        await f.repository.applications.reconcile(connector);
        await f.repository.applications.reconcile(connector);
        assert.equal(
          (await f.repository.applications.get(workspace, f.approved.id))!
            .status,
          "applied",
        );
        assert.ok(unknownInspections >= 25);
      },
    );
  },
);
