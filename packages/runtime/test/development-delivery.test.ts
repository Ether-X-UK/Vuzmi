import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { withDevelopmentDeliveryEvent } from "@vuzmi/core";
import type { DevelopmentDelivery } from "@vuzmi/core";
import { PostgresRunRepository } from "../src/repository.js";
import { DEVELOPMENT_DELIVERY_QUEUE } from "../src/development-delivery.js";
import type { DevelopmentGitHubAdapter } from "../src/development-delivery.js";
import { processDevelopmentDeliveryJob } from "../src/development-delivery-worker.js";
import { approvedDeliveryFixture } from "./delivery-fixtures.js";
import { applicationActor } from "./application-fixtures.js";
const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL,
  workspace = "local-workspace";
async function fixture(t: TestContext) {
  const source = approvedDeliveryFixture(),
    suffix = randomUUID().replaceAll("-", ""),
    schema = `delivery_test_${suffix}`,
    queueSchema = `delivery_queue_${suffix}`,
    sql = new Pool({ connectionString: databaseUrl!, max: 3 }),
    options = { connectionString: databaseUrl!, schema, queueSchema },
    connections: PostgresRunRepository[] = [];
  const connect = async () => {
      const value = await PostgresRunRepository.connect(options);
      connections.push(value);
      return value;
    },
    repository = await connect(),
    workerId = randomUUID();
  t.after(async () => {
    for (const value of connections) await value.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const run = source.run,
    application = source.application;
  await sql.query(
    `INSERT INTO "${schema}".development_runs(workspace_id,id,request_id,request_hash,owner_id,revision,status,aggregate,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [
      workspace,
      run.id,
      run.requestId,
      run.requestFingerprint,
      applicationActor.id,
      run.revision,
      run.status,
      JSON.stringify(run),
      run.createdAt,
      run.updatedAt,
    ],
  );
  for (const event of run.events)
    await sql.query(
      `INSERT INTO "${schema}".development_run_events(workspace_id,run_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)`,
      [workspace, run.id, event.sequence, JSON.stringify(event)],
    );
  await sql.query(
    `INSERT INTO "${schema}".development_artifacts(workspace_id,run_id,package,saved_at) VALUES($1,$2,$3::jsonb,$4)`,
    [workspace, run.id, run.artifact!.content, run.artifact!.savedAt],
  );
  await sql.query(
    `INSERT INTO "${schema}".development_applications(workspace_id,id,run_id,request_id,revision,status,aggregate) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      workspace,
      application.id,
      run.id,
      application.requestId,
      application.revision,
      application.status,
      JSON.stringify(application),
    ],
  );
  for (const event of application.events)
    await sql.query(
      `INSERT INTO "${schema}".development_application_events(workspace_id,application_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)`,
      [workspace, application.id, event.sequence, JSON.stringify(event)],
    );
  let publishCalls = 0,
    inspectCalls = 0,
    ciCalls = 0;
  const connector: DevelopmentGitHubAdapter = {
    observeTarget: async () => source.target,
    readiness: async () => ({
      ready: true,
      reason: "Synthetic injected transport; no GitHub request.",
      authorityIdentity: source.authorityIdentity,
      target: source.target,
    }),
    publish: async (_operation, _run, _application, beforeWrite) => {
      publishCalls++;
      for (const phase of [
        "blob",
        "tree",
        "commit",
        "branch",
        "pull_request",
      ] as const)
        await beforeWrite(phase);
      return source.receipt;
    },
    inspect: async () => {
      inspectCalls++;
      return { status: "published", receipt: source.receipt };
    },
    observeCi: async () => {
      ciCalls++;
      return {
        observedAt: source.target.observedAt,
        headSha: source.plan.commitOid,
        currentHeadSha: source.plan.commitOid,
        currentBaseSha: source.plan.targetSha,
        targetDrift: false,
        state: "waiting",
        truncated: false,
        reason: "No matching runs yet; absence is not a pass.",
        runs: [],
      };
    },
  };
  const ready = () =>
    repository.deliveries.heartbeat(workerId, {
      ready: true,
      reason: "Synthetic fixture authority.",
      authorityIdentity: source.authorityIdentity,
      target: source.target,
    });
  await ready();
  const authorize = () =>
    repository.deliveries.authorize(
      workspace,
      run.id,
      source.input,
      applicationActor,
      source.target,
    );
  const execute = (deliveryId: string, adapter = connector) =>
    processDevelopmentDeliveryJob({
      repository,
      connector: adapter,
      workerId,
      job: { data: { workspaceId: workspace, deliveryId } },
    });
  return {
    ...source,
    repository,
    sql,
    schema,
    queueSchema,
    workerId,
    connector,
    connect,
    ready,
    authorize,
    execute,
    counts: () => ({ publishCalls, inspectCalls, ciCalls }),
  };
}
test(
  "durable separately reviewed GitHub publication on isolated PostgreSQL",
  { skip: !databaseUrl },
  async (t) => {
    await t.test(
      "disconnected preparation is read-only; changed target or authority invalidates review",
      async (t) => {
        const f = await fixture(t);
        await f.repository.deliveries.removeHeartbeat(f.workerId);
        const disconnected = await f.repository.deliveries.plan(
          workspace,
          f.run.id,
          f.text,
          f.target,
        );
        assert.equal(disconnected.available, false);
        assert.equal(disconnected.plan.authorityIdentity, null);
        await assert.rejects(f.authorize(), { code: "DELIVERY_UNAVAILABLE" });
        assert.equal(
          await f.repository.deliveries.get(workspace, f.run.id),
          undefined,
        );
        await f.ready();
        for (const target of [
          { ...f.target, targetSha: "9".repeat(40) },
          { ...f.target, repositoryId: 456 },
        ])
          await assert.rejects(
            f.repository.deliveries.authorize(
              workspace,
              f.run.id,
              f.input,
              applicationActor,
              target,
            ),
          );
        await f.repository.deliveries.heartbeat(f.workerId, {
          ready: true,
          reason: "Changed credential identity.",
          authorityIdentity: "6".repeat(64),
          target: f.target,
        });
        await assert.rejects(f.authorize(), { code: "STALE_DELIVERY_PLAN" });
        assert.deepEqual(f.counts(), {
          publishCalls: 0,
          inspectCalls: 0,
          ciCalls: 0,
        });
      },
    );
    await t.test(
      "concurrent exact replay reserves one job; source history survives restart unchanged",
      async (t) => {
        const f = await fixture(t),
          beforeRun = await f.repository.development.get(workspace, f.run.id),
          beforeApplication = await f.repository.applications.get(
            workspace,
            f.run.id,
          );
        const results = await Promise.all(
          Array.from({ length: 5 }, () => f.authorize()),
        );
        assert.equal(results.filter((result) => !result.replayed).length, 1);
        assert.equal(
          new Set(results.map((result) => result.operation.id)).size,
          1,
        );
        assert.equal(
          (
            await f.sql.query(
              `SELECT count(*)::int count FROM "${f.queueSchema}".job WHERE name=$1`,
              [DEVELOPMENT_DELIVERY_QUEUE],
            )
          ).rows[0].count,
          1,
        );
        await f.repository.deliveries.removeHeartbeat(f.workerId);
        assert.equal((await f.authorize()).replayed, true);
        await assert.rejects(
          f.repository.deliveries.findRequest(
            workspace,
            f.run.id,
            { ...f.input, body: "Conflicting retry" },
            applicationActor.id,
          ),
          { code: "DELIVERY_REQUEST_CONFLICT" },
        );
        await assert.rejects(
          f.repository.deliveries.findRequest(
            workspace,
            f.run.id,
            f.input,
            "foreign-owner",
          ),
          { code: "DELIVERY_REQUEST_CONFLICT" },
        );
        await f.repository.close();
        const reopened = await f.connect();
        assert.deepEqual(
          await reopened.deliveries.get(workspace, f.run.id),
          results[0].operation,
        );
        assert.deepEqual(
          await reopened.development.get(workspace, f.run.id),
          beforeRun,
        );
        assert.deepEqual(
          await reopened.applications.get(workspace, f.run.id),
          beforeApplication,
        );
      },
    );
    await t.test(
      "queue failure rolls back every authorization/event; old checkpoints cannot authorize writes",
      async (t) => {
        const f = await fixture(t),
          send = f.repository.boss.send;
        f.repository.boss.send = (async () => null) as typeof send;
        try {
          await assert.rejects(f.authorize(), {
            code: "DELIVERY_QUEUE_UNAVAILABLE",
          });
          assert.equal(
            await f.repository.deliveries.get(workspace, f.run.id),
            undefined,
          );
          assert.equal(
            (
              await f.sql.query(
                `SELECT count(*)::int count FROM "${f.schema}".development_delivery_events`,
              )
            ).rows[0].count,
            0,
          );
        } finally {
          f.repository.boss.send = send;
        }
        const { operation } = await f.authorize(),
          attemptId = randomUUID(),
          claimed = (await f.repository.deliveries.claim(
            workspace,
            operation.id,
            f.workerId,
            attemptId,
          ))!;
        assert.equal(
          await f.repository.deliveries.checkpoint(
            workspace,
            operation.id,
            {
              workerId: f.workerId,
              attemptId: randomUUID(),
              revision: claimed.revision,
            },
            "blob",
          ),
          undefined,
        );
        const saved = (await f.repository.deliveries.checkpoint(
          workspace,
          operation.id,
          { workerId: f.workerId, attemptId, revision: claimed.revision },
          "blob",
        ))!;
        assert.equal(saved.phase, "blob");
        assert.equal(
          await f.repository.deliveries.checkpoint(
            workspace,
            operation.id,
            { workerId: f.workerId, attemptId, revision: claimed.revision },
            "tree",
          ),
          undefined,
        );
        await assert.rejects(
          f.sql.query(
            `UPDATE "${f.schema}".development_delivery_events SET event='{}'::jsonb`,
          ),
        );
      },
    );
    await t.test(
      "worker checkpoints each remote stage once; duplicate job cannot publish again and CI remains separate",
      async (t) => {
        const f = await fixture(t),
          { operation } = await f.authorize(),
          before = await f.repository.development.get(workspace, f.run.id);
        await f.execute(operation.id);
        await f.execute(operation.id);
        const published = (await f.repository.deliveries.get(
          workspace,
          f.run.id,
        ))!;
        assert.equal(published.status, "published");
        assert.equal(
          published.events.filter(
            (event) => event.type === "delivery.write_reserved",
          ).length,
          5,
        );
        assert.equal(published.ci, undefined);
        assert.equal(f.counts().publishCalls, 1);
        const observed = (await f.repository.deliveries.refresh(
          workspace,
          f.run.id,
          f.connector,
        ))!;
        assert.equal(observed.ci!.state, "waiting");
        assert.equal(observed.ci!.runs.length, 0);
        assert.deepEqual(observed.receipt, published.receipt);
        assert.equal(f.counts().publishCalls, 1);
        assert.deepEqual(
          await f.repository.development.get(workspace, f.run.id),
          before,
        );
        await assert.rejects(
          f.repository.deliveries.get("foreign-workspace", f.run.id),
          { code: "DELIVERY_NOT_FOUND" },
        );
      },
    );
    await t.test(
      "mid-publication credential loss stops the next write and a timeout never causes automatic retry",
      async (t) => {
        const f = await fixture(t),
          { operation } = await f.authorize();
        let writes = 0;
        await f.execute(operation.id, {
          ...f.connector,
          publish: async (_op, _run, _app, beforeWrite) => {
            await beforeWrite("blob");
            writes++;
            await f.sql.query(
              `UPDATE "${f.schema}".development_deliveries SET seen_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
              [operation.id],
            );
            await beforeWrite("tree");
            writes++;
            throw new Error("Must not get here.");
          },
          inspect: async () => ({
            status: "absent",
            reason:
              "No branch or PR is currently visible; unknown earlier object writes.",
          }),
        });
        assert.equal(writes, 1);
        await f.repository.deliveries.reconcile({
          ...f.connector,
          inspect: async () => ({
            status: "absent",
            reason: "Not proof of failure.",
          }),
        });
        const unknown = (await f.repository.deliveries.get(
          workspace,
          f.run.id,
        ))!;
        assert.equal(unknown.status, "unconfirmed");
        assert.equal(
          await f.repository.deliveries.claim(
            workspace,
            operation.id,
            f.workerId,
            randomUUID(),
          ),
          undefined,
        );
        await f.execute(operation.id);
        assert.equal(writes, 1);
        assert.equal(unknown.receipt, undefined);
      },
    );
    await t.test(
      "crash after publication reconciles by reads; restored unfinished operations stay quarantined",
      async (t) => {
        const f = await fixture(t),
          { operation } = await f.authorize(),
          claimed = (await f.repository.deliveries.claim(
            workspace,
            operation.id,
            f.workerId,
            randomUUID(),
          ))!;
        await f.sql.query(
          `UPDATE "${f.schema}".development_deliveries SET seen_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
          [operation.id],
        );
        await f.repository.deliveries.reconcile(f.connector);
        const observed = (await f.repository.deliveries.get(
          workspace,
          f.run.id,
        ))!;
        assert.equal(observed.status, "published");
        assert.equal(f.counts().publishCalls, 0);
        assert.equal(f.counts().inspectCalls, 1);
        assert.equal(claimed.phase, "reserved");
        const other = approvedDeliveryFixture();
        await f.sql.query(
          `INSERT INTO "${f.schema}".development_runs(workspace_id,id,request_id,request_hash,owner_id,revision,status,aggregate,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
          [
            workspace,
            other.run.id,
            other.run.requestId,
            other.run.requestFingerprint,
            applicationActor.id,
            other.run.revision,
            other.run.status,
            JSON.stringify(other.run),
            other.run.createdAt,
            other.run.updatedAt,
          ],
        );
        const quarantined: DevelopmentDelivery = withDevelopmentDeliveryEvent(
          other.operation,
          "delivery.restore_quarantined",
          "Restored operations cannot replay publication.",
          other.target.observedAt,
          {
            status: "unconfirmed",
            error: {
              code: "DELIVERY_RESTORE_QUARANTINED",
              message:
                "Explicit operator inspection is required after restore.",
            },
          },
        );
        await f.sql.query(
          `INSERT INTO "${f.schema}".development_deliveries(workspace_id,id,run_id,request_id,revision,status,aggregate) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            workspace,
            quarantined.id,
            quarantined.runId,
            quarantined.requestId,
            quarantined.revision,
            quarantined.status,
            JSON.stringify(quarantined),
          ],
        );
        await f.repository.deliveries.reconcile(f.connector);
        await f.repository.deliveries.refresh(
          workspace,
          quarantined.runId,
          f.connector,
        );
        assert.equal(f.counts().inspectCalls, 1);
        assert.equal(
          (await f.repository.deliveries.get(workspace, quarantined.runId))!
            .status,
          "unconfirmed",
        );
        assert.equal(
          await f.repository.deliveries.claim(
            workspace,
            quarantined.id,
            f.workerId,
            randomUUID(),
          ),
          undefined,
        );
      },
    );
  },
);

test("a worker disconnected at startup does not consume publication jobs or poll GitHub reconciliation", async () => {
  let workCalls = 0,
    offWorkCalls = 0,
    inspections = 0,
    reconcileCalls = 0;
  const heartbeats: { ready: boolean }[] = [];
  const repository = {
    deliveries: {
      heartbeat: async (_id: string, value: { ready: boolean }) => {
        heartbeats.push(value);
      },
      reconcile: async () => {
        reconcileCalls++;
      },
      removeHeartbeat: async () => {},
    },
    boss: {
      work: async () => {
        workCalls++;
      },
      offWork: async () => {
        offWorkCalls++;
      },
    },
  } as unknown as PostgresRunRepository;
  const connector = {
    readiness: async () => {
      inspections++;
      return {
        ready: false,
        reason: "Explicit GitHub publication credential is not configured.",
      };
    },
  } as unknown as DevelopmentGitHubAdapter;
  const { startDevelopmentDeliveryWorker } =
    await import("../src/development-delivery-worker.js");
  const worker = await startDevelopmentDeliveryWorker({
    repository,
    connector,
  });
  await worker.stop();
  assert.equal(workCalls, 0);
  assert.equal(offWorkCalls, 0);
  assert.equal(reconcileCalls, 0);
  assert.equal(inspections, 1);
  assert.equal(heartbeats[0].ready, false);
});
