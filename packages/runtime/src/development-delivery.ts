import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  DevelopmentDeliveryError,
  createDevelopmentDeliveryPlan,
  createDevelopmentDelivery,
  developmentDeliveryInputSchema,
  developmentDeliveryRequestFingerprintInput,
  developmentDeliveryTargetSchema,
  parseDevelopmentDeliveryIntegrity,
  withDevelopmentDeliveryEvent,
} from "@vuzmi/core";
import type {
  DevelopmentApplication,
  DevelopmentDelivery,
  DevelopmentDeliveryCi,
  DevelopmentDeliveryInput,
  DevelopmentDeliveryPhase,
  DevelopmentDeliveryPlan,
  DevelopmentDeliveryReceipt,
  DevelopmentDeliveryTarget,
  DevelopmentDeliveryText,
  DevelopmentRun,
} from "@vuzmi/core";

export interface DevelopmentDeliveryReadiness {
  ready: boolean;
  reason: string;
  authorityIdentity?: string;
  target?: DevelopmentDeliveryTarget;
}
export type DevelopmentDeliveryInspection =
  | { status: "published"; receipt: DevelopmentDeliveryReceipt }
  | { status: "partial" | "absent" | "conflict"; reason: string };
/** Trusted worker effect boundary. Public-only instances implement bounded GETs but fail publication closed. */
export interface DevelopmentGitHubAdapter {
  observeTarget(signal?: AbortSignal): Promise<DevelopmentDeliveryTarget>;
  readiness(signal?: AbortSignal): Promise<DevelopmentDeliveryReadiness>;
  publish(
    operation: DevelopmentDelivery,
    run: DevelopmentRun,
    application: DevelopmentApplication,
    beforeWrite: (
      phase: Exclude<DevelopmentDeliveryPhase, "reserved">,
    ) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<DevelopmentDeliveryReceipt>;
  inspect(
    operation: DevelopmentDelivery,
    signal?: AbortSignal,
  ): Promise<DevelopmentDeliveryInspection>;
  observeCi(
    operation: DevelopmentDelivery,
    signal?: AbortSignal,
  ): Promise<DevelopmentDeliveryCi>;
}
const workspace = "local-workspace",
  hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const DEVELOPMENT_DELIVERY_QUEUE = "vuzmi-development-delivery";
export interface DeliveryJobData {
  workspaceId: string;
  deliveryId: string;
}
type Transaction = <T>(
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
export type DevelopmentDeliveryContext = {
  workerId: string;
  attemptId: string;
  revision: number;
};
export function developmentDeliveryMigration(schema: string): string {
  return `
 CREATE TABLE ${schema}.development_deliveries(workspace_id text NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,request_id uuid NOT NULL,revision integer NOT NULL,status text NOT NULL,aggregate jsonb NOT NULL,worker_id uuid,attempt_id uuid,seen_at timestamptz,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,run_id),UNIQUE(workspace_id,request_id),FOREIGN KEY(workspace_id,run_id) REFERENCES ${schema}.development_runs(workspace_id,id),CHECK(aggregate->>'workspaceId'=workspace_id),CHECK(aggregate->>'id'=id::text),CHECK(aggregate->>'runId'=run_id::text),CHECK(aggregate->>'status'=status),CHECK((aggregate->>'revision')::integer=revision));
 CREATE TABLE ${schema}.development_delivery_events(workspace_id text NOT NULL,delivery_id uuid NOT NULL,sequence integer NOT NULL,event jsonb NOT NULL,PRIMARY KEY(workspace_id,delivery_id,sequence),FOREIGN KEY(workspace_id,delivery_id) REFERENCES ${schema}.development_deliveries(workspace_id,id));
 CREATE TRIGGER immutable_delivery_events BEFORE UPDATE OR DELETE ON ${schema}.development_delivery_events FOR EACH ROW EXECUTE FUNCTION ${schema}.protect_run_events();
 CREATE TABLE ${schema}.development_delivery_runtime(workspace_id text NOT NULL,worker_id uuid NOT NULL,ready boolean NOT NULL,reason text NOT NULL,authority_identity text,target jsonb,seen_at timestamptz NOT NULL,PRIMARY KEY(workspace_id,worker_id));
 `;
}
export class DevelopmentDeliveryRepository {
  constructor(
    private readonly options: {
      pool: Pool;
      boss: PgBoss;
      schema: string;
      queueSchema: string;
      transaction: Transaction;
      now: () => Date;
      getRun: (
        workspaceId: string,
        id: string,
      ) => Promise<DevelopmentRun | undefined>;
      getApplication: (
        workspaceId: string,
        runId: string,
      ) => Promise<DevelopmentApplication | undefined>;
    },
  ) {}
  private local(value: string) {
    if (value !== workspace)
      throw new DevelopmentDeliveryError(
        "DELIVERY_NOT_FOUND",
        "This delivery is unavailable.",
        404,
      );
  }
  private async source(workspaceId: string, runId: string) {
    this.local(workspaceId);
    const run = await this.options.getRun(workspaceId, runId);
    if (!run)
      throw new DevelopmentDeliveryError(
        "DEVELOPMENT_NOT_FOUND",
        "This development run does not exist.",
        404,
      );
    const application = await this.options.getApplication(workspaceId, runId);
    if (!application)
      throw new DevelopmentDeliveryError(
        "DELIVERY_NOT_APPLIED",
        "A verified local application receipt is required before preparing publication.",
      );
    return { run, application };
  }
  async get(
    workspaceId: string,
    runId: string,
  ): Promise<DevelopmentDelivery | undefined> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.options.schema}.development_deliveries WHERE workspace_id=$1 AND run_id=$2`,
      [workspaceId, runId],
    );
    return result.rows[0]
      ? parseDevelopmentDeliveryIntegrity(result.rows[0].aggregate, hash)
      : undefined;
  }
  async byId(
    workspaceId: string,
    id: string,
  ): Promise<DevelopmentDelivery | undefined> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.options.schema}.development_deliveries WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? parseDevelopmentDeliveryIntegrity(result.rows[0].aggregate, hash)
      : undefined;
  }
  private async runtime(client: Pool | PoolClient = this.options.pool) {
    const result = await client.query(
      `SELECT ready,reason,authority_identity,target,seen_at>clock_timestamp()-interval '30 seconds' fresh FROM ${this.options.schema}.development_delivery_runtime WHERE workspace_id=$1 ORDER BY (ready AND seen_at>clock_timestamp()-interval '30 seconds') DESC,seen_at DESC LIMIT 1`,
      [workspace],
    );
    return result.rows[0];
  }
  async readiness(): Promise<{
    available: boolean;
    reason: string | null;
    checkedAt: string;
    authorityIdentity: string | null;
  }> {
    const runtime = await this.runtime(),
      available = Boolean(
        runtime?.ready && runtime.fresh && runtime.authority_identity,
      );
    return {
      available,
      reason: available
        ? null
        : "No fresh trusted GitHub publication worker is connected. Existing plans and receipts remain readable.",
      checkedAt: this.options.now().toISOString(),
      authorityIdentity: available ? runtime.authority_identity : null,
    };
  }
  async findRequest(
    workspaceId: string,
    runId: string,
    input: DevelopmentDeliveryInput,
    actor: string,
  ): Promise<DevelopmentDelivery | undefined> {
    this.local(workspaceId);
    const value = developmentDeliveryInputSchema.parse(input);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.options.schema}.development_deliveries WHERE workspace_id=$1 AND (run_id=$2 OR request_id=$3)`,
      [workspaceId, runId, value.requestId],
    );
    if (!result.rows.length) return undefined;
    const operation = parseDevelopmentDeliveryIntegrity(
      result.rows[0].aggregate,
      hash,
    );
    if (
      result.rows.length !== 1 ||
      operation.runId !== runId ||
      operation.requestId !== value.requestId ||
      operation.requestFingerprint !==
        hash(developmentDeliveryRequestFingerprintInput(value, actor))
    )
      throw new DevelopmentDeliveryError(
        "DELIVERY_REQUEST_CONFLICT",
        "This run or request UUID already has a different immutable publication authorization.",
      );
    return operation;
  }
  async plan(
    workspaceId: string,
    runId: string,
    input: DevelopmentDeliveryText,
    targetValue: DevelopmentDeliveryTarget,
  ): Promise<{
    plan: DevelopmentDeliveryPlan;
    available: boolean;
    reason: string | null;
  }> {
    const { run, application } = await this.source(workspaceId, runId),
      target = developmentDeliveryTargetSchema.parse(targetValue),
      runtime = await this.runtime();
    const matching = Boolean(
      runtime?.ready &&
      runtime.fresh &&
      runtime.authority_identity &&
      runtime.target?.repositoryId === target.repositoryId,
    );
    return {
      plan: createDevelopmentDeliveryPlan(
        run,
        application,
        input,
        target,
        matching ? runtime.authority_identity : null,
        hash,
      ),
      available: matching,
      reason: matching
        ? null
        : "No fresh matching GitHub publication worker is connected. Review preparation makes no external writes; prepare again after connection before authorizing.",
    };
  }
  async authorize(
    workspaceId: string,
    runId: string,
    input: DevelopmentDeliveryInput,
    actor: { id: string; name?: string },
    targetValue: DevelopmentDeliveryTarget,
  ): Promise<{ operation: DevelopmentDelivery; replayed: boolean }> {
    this.local(workspaceId);
    const value = developmentDeliveryInputSchema.parse(input),
      target = developmentDeliveryTargetSchema.parse(targetValue),
      { run, application } = await this.source(workspaceId, runId);
    return this.options.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `vuzmi:delivery:${workspaceId}`,
      ]);
      const previous = await client.query(
        `SELECT aggregate FROM ${this.options.schema}.development_deliveries WHERE workspace_id=$1 AND (run_id=$2 OR request_id=$3) FOR UPDATE`,
        [workspaceId, runId, value.requestId],
      );
      if (previous.rows.length) {
        const operation = parseDevelopmentDeliveryIntegrity(
          previous.rows[0].aggregate,
          hash,
        );
        if (
          previous.rows.length !== 1 ||
          operation.runId !== runId ||
          operation.requestId !== value.requestId ||
          operation.requestFingerprint !==
            hash(developmentDeliveryRequestFingerprintInput(value, actor.id))
        )
          throw new DevelopmentDeliveryError(
            "DELIVERY_REQUEST_CONFLICT",
            "This run or request UUID already has a different immutable publication authorization.",
          );
        return { operation, replayed: true };
      }
      const runtime = await this.runtime(client);
      if (
        !runtime?.ready ||
        !runtime.fresh ||
        !runtime.authority_identity ||
        runtime.target?.repositoryId !== target.repositoryId
      )
        throw new DevelopmentDeliveryError(
          "DELIVERY_UNAVAILABLE",
          "A fresh matching trusted GitHub publication worker is required before authorization.",
          503,
        );
      const plan = createDevelopmentDeliveryPlan(
          run,
          application,
          { title: value.title, body: value.body },
          target,
          runtime.authority_identity,
          hash,
        ),
        operation = createDevelopmentDelivery(plan, value, {
          id: randomUUID(),
          actor,
          now: this.options.now().toISOString(),
          hash,
        });
      await client.query(
        `INSERT INTO ${this.options.schema}.development_deliveries(workspace_id,id,run_id,request_id,revision,status,aggregate) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          workspaceId,
          operation.id,
          runId,
          operation.requestId,
          operation.revision,
          operation.status,
          JSON.stringify(operation),
        ],
      );
      await this.events(client, undefined, operation);
      const job = await this.options.boss.send(
        DEVELOPMENT_DELIVERY_QUEUE,
        { workspaceId, deliveryId: operation.id },
        {
          singletonKey: `${workspaceId}:${operation.id}`,
          db: {
            executeSql: (text: string, values: unknown[]) =>
              client.query(text, values),
          },
        },
      );
      if (!job)
        throw new DevelopmentDeliveryError(
          "DELIVERY_QUEUE_UNAVAILABLE",
          "Authorization was rolled back because its durable delivery job could not be queued.",
          503,
        );
      return { operation, replayed: false };
    });
  }
  async heartbeat(
    workerId: string,
    readiness: DevelopmentDeliveryReadiness,
  ): Promise<void> {
    if (
      readiness.ready &&
      (!/^[a-f0-9]{64}$/.test(readiness.authorityIdentity ?? "") ||
        !readiness.target)
    )
      throw new Error(
        "A ready GitHub worker requires an exact authority and public repository observation.",
      );
    const target = readiness.target
      ? developmentDeliveryTargetSchema.parse(readiness.target)
      : null;
    await this.options.transaction(async (client) => {
      await client.query(
        `UPDATE ${this.options.schema}.development_deliveries a SET seen_at=clock_timestamp() WHERE workspace_id=$1 AND worker_id=$2 AND status='running' AND seen_at>clock_timestamp()-interval '30 seconds' AND $3::boolean AND a.aggregate->'plan'->>'authorityIdentity'=$4 AND (a.aggregate->'plan'->>'repositoryId')::bigint=$5 AND EXISTS(SELECT 1 FROM ${this.options.schema}.development_delivery_runtime w WHERE w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id AND w.ready AND w.authority_identity=$4 AND w.seen_at>clock_timestamp()-interval '30 seconds')`,
        [
          workspace,
          workerId,
          readiness.ready,
          readiness.authorityIdentity ?? null,
          target?.repositoryId ?? null,
        ],
      );
      await client.query(
        `INSERT INTO ${this.options.schema}.development_delivery_runtime(workspace_id,worker_id,ready,reason,authority_identity,target,seen_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp()) ON CONFLICT(workspace_id,worker_id) DO UPDATE SET ready=excluded.ready,reason=excluded.reason,authority_identity=excluded.authority_identity,target=excluded.target,seen_at=excluded.seen_at`,
        [
          workspace,
          workerId,
          readiness.ready,
          readiness.reason.slice(0, 600),
          readiness.authorityIdentity ?? null,
          target ? JSON.stringify(target) : null,
        ],
      );
    });
  }
  async removeHeartbeat(workerId: string) {
    await this.options.pool.query(
      `DELETE FROM ${this.options.schema}.development_delivery_runtime WHERE workspace_id=$1 AND worker_id=$2`,
      [workspace, workerId],
    );
  }
  private async locked(client: PoolClient, id: string) {
    const result = await client.query(
      `SELECT aggregate FROM ${this.options.schema}.development_deliveries WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspace, id],
    );
    return result.rows[0]
      ? parseDevelopmentDeliveryIntegrity(result.rows[0].aggregate, hash)
      : undefined;
  }
  async claim(
    workspaceId: string,
    id: string,
    workerId: string,
    attemptId: string,
  ): Promise<DevelopmentDelivery | undefined> {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (!operation || operation.status !== "queued") return undefined;
      const ready = await client.query(
        `SELECT 1 FROM ${this.options.schema}.development_delivery_runtime WHERE workspace_id=$1 AND worker_id=$2 AND ready AND authority_identity=$3 AND (target->>'repositoryId')::bigint=$4 AND seen_at>clock_timestamp()-interval '30 seconds' FOR SHARE`,
        [
          workspaceId,
          workerId,
          operation.plan.authorityIdentity,
          operation.plan.repositoryId,
        ],
      );
      if (!ready.rowCount) return undefined;
      const next = withDevelopmentDeliveryEvent(
        operation,
        "delivery.reserved",
        "A single publication attempt was durably reserved before any remote write.",
        this.options.now().toISOString(),
        { status: "running", workerId, attemptId, phase: "reserved" },
      );
      await this.save(client, operation, next);
      return next;
    });
  }
  private async owns(
    client: PoolClient,
    operation: DevelopmentDelivery,
    context: DevelopmentDeliveryContext,
  ) {
    if (
      operation.status !== "running" ||
      operation.workerId !== context.workerId ||
      operation.attemptId !== context.attemptId ||
      operation.revision !== context.revision
    )
      return false;
    const result = await client.query(
      `SELECT 1 FROM ${this.options.schema}.development_deliveries a JOIN ${this.options.schema}.development_delivery_runtime w ON w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.seen_at>clock_timestamp()-interval '30 seconds' AND w.seen_at>clock_timestamp()-interval '30 seconds' AND w.ready AND w.authority_identity=$3 AND (w.target->>'repositoryId')::bigint=$4 FOR SHARE OF w`,
      [
        workspace,
        operation.id,
        operation.plan.authorityIdentity,
        operation.plan.repositoryId,
      ],
    );
    return result.rowCount === 1;
  }
  async checkpoint(
    workspaceId: string,
    id: string,
    context: DevelopmentDeliveryContext,
    phase: Exclude<DevelopmentDeliveryPhase, "reserved">,
    signal?: AbortSignal,
  ) {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (!operation || !(await this.owns(client, operation, context)))
        return undefined;
      const next = withDevelopmentDeliveryEvent(
        operation,
        "delivery.write_reserved",
        `The ${phase} write was checkpointed under the current owner authorization and worker lease.`,
        this.options.now().toISOString(),
        { phase },
      );
      await this.save(client, operation, next);
      return next;
    }, signal);
  }
  async published(
    workspaceId: string,
    id: string,
    context: DevelopmentDeliveryContext,
    receipt: DevelopmentDeliveryReceipt,
    signal?: AbortSignal,
  ) {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (!operation || !(await this.owns(client, operation, context)))
        return undefined;
      return this.complete(client, operation, receipt);
    }, signal);
  }
  private async complete(
    client: PoolClient,
    operation: DevelopmentDelivery,
    receipt: DevelopmentDeliveryReceipt,
  ) {
    const next = withDevelopmentDeliveryEvent(
      operation,
      "delivery.published",
      "The exact public branch and draft pull request were observed. CI is recorded separately; no merge or deployment was performed.",
      receipt.publishedAt,
      { status: "published", receipt, error: undefined },
    );
    await this.save(client, operation, next);
    return next;
  }
  async fail(
    workspaceId: string,
    id: string,
    context: DevelopmentDeliveryContext,
    error: { code: string; message: string },
  ) {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (
        !operation ||
        operation.status !== "running" ||
        operation.workerId !== context.workerId ||
        operation.attemptId !== context.attemptId ||
        operation.revision !== context.revision
      )
        return undefined;
      const status = [
        "DELIVERY_CONFLICT",
        "DELIVERY_BRANCH_CONFLICT",
        "DELIVERY_PULL_REQUEST_CONFLICT",
        "DELIVERY_GITHUB_CONFLICT",
      ].includes(error.code)
        ? "conflict"
        : "unconfirmed";
      const next = withDevelopmentDeliveryEvent(
        operation,
        `delivery.${status}`,
        error.message,
        this.options.now().toISOString(),
        { status, error },
      );
      await this.save(client, operation, next);
      return next;
    });
  }
  private async observe(
    operation: DevelopmentDelivery,
    connector: DevelopmentGitHubAdapter,
  ): Promise<DevelopmentDelivery> {
    if (
      operation.status !== "unconfirmed" ||
      operation.error?.code === "DELIVERY_RESTORE_QUARANTINED"
    )
      return operation;
    const state = await connector.inspect(operation);
    return this.options.transaction(async (client) => {
      const current = await this.locked(client, operation.id);
      if (
        !current ||
        current.status !== "unconfirmed" ||
        current.revision !== operation.revision
      )
        return current ?? operation;
      if (state.status === "published")
        return this.complete(client, current, state.receipt);
      if (state.status === "conflict") {
        const next = withDevelopmentDeliveryEvent(
          current,
          "delivery.conflict",
          state.reason.slice(0, 600),
          this.options.now().toISOString(),
          {
            status: "conflict",
            error: {
              code: "DELIVERY_CONFLICT",
              message: state.reason.slice(0, 600),
            },
          },
        );
        await this.save(client, current, next);
        return next;
      }
      return current;
    });
  }
  async refresh(
    workspaceId: string,
    runId: string,
    connector: DevelopmentGitHubAdapter,
  ): Promise<DevelopmentDelivery | undefined> {
    this.local(workspaceId);
    let operation = await this.get(workspaceId, runId);
    if (!operation) return undefined;
    operation = await this.observe(operation, connector);
    if (operation.status !== "published") return operation;
    const ci = await connector.observeCi(operation);
    return this.options.transaction(async (client) => {
      const current = await this.locked(client, operation!.id);
      if (
        !current ||
        current.status !== "published" ||
        current.revision !== operation!.revision
      )
        return current;
      const next = withDevelopmentDeliveryEvent(
        current,
        "delivery.ci_observed",
        "A bounded read-only GitHub Actions snapshot was retained for the exact published head. This does not authorize reruns, merge or deployment.",
        this.options.now().toISOString(),
        { ci },
      );
      await this.save(client, current, next);
      return next;
    });
  }
  /** Recovery only observes reserved refs/PRs. A missing remote result never triggers another write. */
  async reconcile(connector: DevelopmentGitHubAdapter): Promise<void> {
    const result = await this.options.pool.query(
      `SELECT id FROM ${this.options.schema}.development_deliveries a WHERE workspace_id=$1 AND ((status='unconfirmed' AND (seen_at IS NULL OR seen_at<clock_timestamp()-interval '60 seconds') AND COALESCE(aggregate->'error'->>'code','')<>'DELIVERY_RESTORE_QUARANTINED') OR (status='running' AND (seen_at<clock_timestamp()-interval '30 seconds' OR NOT EXISTS(SELECT 1 FROM ${this.options.schema}.development_delivery_runtime w WHERE w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id AND w.ready AND w.authority_identity=a.aggregate->'plan'->>'authorityIdentity' AND w.seen_at>clock_timestamp()-interval '30 seconds'))) OR (status='queued' AND NOT EXISTS(SELECT 1 FROM ${this.options.queueSchema}.job j WHERE j.name=$2 AND j.data->>'workspaceId'=a.workspace_id AND j.data->>'deliveryId'=a.id::text AND j.state IN ('created','retry','active')))) ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END,seen_at ASC NULLS FIRST,id LIMIT 20`,
      [workspace, DEVELOPMENT_DELIVERY_QUEUE],
    );
    for (const row of result.rows) {
      const operation = await this.options.transaction(async (client) => {
        const value = await this.locked(client, row.id);
        if (
          !value ||
          !["queued", "running", "unconfirmed"].includes(value.status) ||
          value.error?.code === "DELIVERY_RESTORE_QUARANTINED"
        )
          return undefined;
        if (value.status === "running") {
          const fresh = await client.query(
            `SELECT 1 FROM ${this.options.schema}.development_deliveries a JOIN ${this.options.schema}.development_delivery_runtime w ON w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.seen_at>clock_timestamp()-interval '30 seconds' AND w.ready AND w.seen_at>clock_timestamp()-interval '30 seconds' AND w.authority_identity=a.aggregate->'plan'->>'authorityIdentity'`,
            [workspace, value.id],
          );
          if (fresh.rowCount) return undefined;
        }
        if (value.status === "queued") {
          const job = await client.query(
            `SELECT 1 FROM ${this.options.queueSchema}.job WHERE name=$1 AND data->>'workspaceId'=$2 AND data->>'deliveryId'=$3 AND state IN ('created','retry','active')`,
            [DEVELOPMENT_DELIVERY_QUEUE, workspace, value.id],
          );
          if (job.rowCount) return undefined;
        }
        if (value.status === "unconfirmed") {
          await client.query(
            `UPDATE ${this.options.schema}.development_deliveries SET seen_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
            [workspace, value.id],
          );
          return value;
        }
        const next = withDevelopmentDeliveryEvent(
          value,
          "delivery.unconfirmed",
          "The reserved worker or durable job is unavailable. Only read-only reconciliation is permitted; publication will not be retried.",
          this.options.now().toISOString(),
          {
            status: "unconfirmed",
            error: {
              code: "DELIVERY_UNCONFIRMED",
              message:
                "Publication outcome is unconfirmed; absence is not proof that a remote write failed.",
            },
          },
        );
        await this.save(client, value, next);
        return next;
      });
      if (operation)
        try {
          await this.observe(operation, connector);
        } catch {
          /* Upstream failures retain existing evidence; no effect is retried. */
        }
    }
  }
  private async save(
    client: PoolClient,
    previous: DevelopmentDelivery,
    next: DevelopmentDelivery,
  ) {
    parseDevelopmentDeliveryIntegrity(next, hash);
    const result = await client.query(
      `UPDATE ${this.options.schema}.development_deliveries SET revision=$3,status=$4,aggregate=$5::jsonb,worker_id=$6,attempt_id=$7,seen_at=CASE WHEN $4='running' THEN clock_timestamp() ELSE seen_at END WHERE workspace_id=$1 AND id=$2 AND revision=$8`,
      [
        next.workspaceId,
        next.id,
        next.revision,
        next.status,
        JSON.stringify(next),
        next.workerId ?? null,
        next.attemptId ?? null,
        previous.revision,
      ],
    );
    if (result.rowCount !== 1)
      throw new DevelopmentDeliveryError(
        "STALE_DELIVERY",
        "The delivery changed before this result could be saved.",
      );
    await this.events(client, previous, next);
  }
  private async events(
    client: PoolClient,
    previous: DevelopmentDelivery | undefined,
    next: DevelopmentDelivery,
  ) {
    const count = previous?.events.length ?? 0;
    if (
      previous &&
      JSON.stringify(next.events.slice(0, count)) !==
        JSON.stringify(previous.events)
    )
      throw new Error("Existing delivery events cannot change.");
    for (const event of next.events.slice(count))
      await client.query(
        `INSERT INTO ${this.options.schema}.development_delivery_events(workspace_id,delivery_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)`,
        [workspace, next.id, event.sequence, JSON.stringify(event)],
      );
  }
}
