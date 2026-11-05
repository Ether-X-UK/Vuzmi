import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  DevelopmentApplicationError,
  createDevelopmentApplicationPlan,
  createDevelopmentApplication,
  developmentApplicationInputSchema,
  developmentApplicationRequestFingerprintInput,
  parseDevelopmentApplicationIntegrity,
  withDevelopmentApplicationEvent,
} from "@vuzmi/core";
import type {
  DevelopmentApplication,
  DevelopmentApplicationInput,
  DevelopmentApplicationPlan,
  DevelopmentApplicationPrepared,
  DevelopmentRun,
} from "@vuzmi/core";
import type { DevelopmentGitAdapter } from "./development-git.js";
const workspace = "local-workspace",
  hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const DEVELOPMENT_APPLICATION_QUEUE = "vuzmi-development-application";
export interface ApplicationJobData {
  workspaceId: string;
  applicationId: string;
}
type Transaction = <T>(
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
type Context = { workerId: string; attemptId: string; revision: number };
/** Append-only v5. Existing migration text and approved artifacts are untouched. */
export function developmentApplicationMigration(schema: string): string {
  return `
  ALTER TABLE ${schema}.development_runtime ADD COLUMN profiles jsonb;
  CREATE TABLE ${schema}.development_profiles (workspace_id text NOT NULL,profile_hash text NOT NULL,profile jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,profile_hash));
  CREATE TABLE ${schema}.development_applications (
    workspace_id text NOT NULL,id uuid NOT NULL,run_id uuid NOT NULL,request_id uuid NOT NULL,revision integer NOT NULL,status text NOT NULL,aggregate jsonb NOT NULL,
    worker_id uuid,attempt_id uuid,seen_at timestamptz,
    PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,run_id),UNIQUE(workspace_id,request_id),
    FOREIGN KEY(workspace_id,run_id) REFERENCES ${schema}.development_runs(workspace_id,id),
    CHECK(aggregate->>'workspaceId'=workspace_id),CHECK(aggregate->>'id'=id::text),CHECK(aggregate->>'runId'=run_id::text),CHECK(aggregate->>'status'=status),CHECK((aggregate->>'revision')::integer=revision)
  );
  CREATE TABLE ${schema}.development_application_events (workspace_id text NOT NULL,application_id uuid NOT NULL,sequence integer NOT NULL,event jsonb NOT NULL,PRIMARY KEY(workspace_id,application_id,sequence),FOREIGN KEY(workspace_id,application_id) REFERENCES ${schema}.development_applications(workspace_id,id));
  CREATE TRIGGER immutable_application_events BEFORE UPDATE OR DELETE ON ${schema}.development_application_events FOR EACH ROW EXECUTE FUNCTION ${schema}.protect_run_events();
  CREATE TABLE ${schema}.development_application_runtime (workspace_id text NOT NULL,worker_id uuid NOT NULL,ready boolean NOT NULL,reason text NOT NULL,repository_identity text,seen_at timestamptz NOT NULL,PRIMARY KEY(workspace_id,worker_id));
`;
}
export class DevelopmentApplicationRepository {
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
    },
  ) {}
  private local(value: string) {
    if (value !== workspace)
      throw new DevelopmentApplicationError(
        "APPLICATION_NOT_FOUND",
        "This local application is unavailable.",
        404,
      );
  }
  private async run(workspaceId: string, runId: string) {
    this.local(workspaceId);
    const run = await this.options.getRun(workspaceId, runId);
    if (!run)
      throw new DevelopmentApplicationError(
        "DEVELOPMENT_NOT_FOUND",
        "This development run does not exist.",
        404,
      );
    return run;
  }
  async get(
    workspaceId: string,
    runId: string,
  ): Promise<DevelopmentApplication | undefined> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.options.schema}.development_applications WHERE workspace_id=$1 AND run_id=$2`,
      [workspaceId, runId],
    );
    return result.rows[0]
      ? parseDevelopmentApplicationIntegrity(result.rows[0].aggregate, hash)
      : undefined;
  }
  async byId(
    workspaceId: string,
    id: string,
  ): Promise<DevelopmentApplication | undefined> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.options.schema}.development_applications WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? parseDevelopmentApplicationIntegrity(result.rows[0].aggregate, hash)
      : undefined;
  }
  private async runtime(client: Pool | PoolClient = this.options.pool) {
    const result = await client.query(
      `SELECT ready,reason,repository_identity,seen_at>clock_timestamp()-interval '30 seconds' fresh FROM ${this.options.schema}.development_application_runtime WHERE workspace_id=$1 ORDER BY (ready AND seen_at>clock_timestamp()-interval '30 seconds') DESC,seen_at DESC LIMIT 1`,
      [workspace],
    );
    return result.rows[0];
  }
  async plan(
    workspaceId: string,
    runId: string,
  ): Promise<{
    plan: DevelopmentApplicationPlan;
    available: boolean;
    reason: string | null;
  }> {
    const run = await this.run(workspaceId, runId),
      existing = await this.get(workspaceId, runId),
      runtime = await this.runtime();
    const identity =
      existing?.plan.repositoryIdentity ?? runtime?.repository_identity;
    if (!identity)
      throw new DevelopmentApplicationError(
        "APPLICATION_UNAVAILABLE",
        "The local Git connector has not registered this repository. Start the trusted worker before reviewing an application plan.",
        503,
      );
    const plan = createDevelopmentApplicationPlan(run, identity, hash),
      available = Boolean(
        runtime?.ready &&
        runtime.fresh &&
        runtime.repository_identity === identity,
      );
    return {
      plan,
      available,
      reason: available
        ? null
        : "No fresh matching local Git connector is available. Existing receipts remain readable.",
    };
  }
  async authorize(
    workspaceId: string,
    runId: string,
    input: DevelopmentApplicationInput,
    actor: { id: string; name?: string },
  ): Promise<{ operation: DevelopmentApplication; replayed: boolean }> {
    this.local(workspaceId);
    const value = developmentApplicationInputSchema.parse(input);
    const run = await this.run(workspaceId, runId);
    return this.options.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `vuzmi:application:${workspaceId}`,
      ]);
      const previous = await client.query(
        `SELECT aggregate FROM ${this.options.schema}.development_applications WHERE workspace_id=$1 AND (run_id=$2 OR request_id=$3) FOR UPDATE`,
        [workspaceId, runId, value.requestId],
      );
      if (previous.rows.length) {
        const operation = parseDevelopmentApplicationIntegrity(
          previous.rows[0].aggregate,
          hash,
        );
        if (
          previous.rows.length !== 1 ||
          operation.runId !== runId ||
          operation.requestId !== value.requestId ||
          operation.requestFingerprint !==
            hash(developmentApplicationRequestFingerprintInput(value, actor.id))
        )
          throw new DevelopmentApplicationError(
            "APPLICATION_REQUEST_CONFLICT",
            "An existing application or request UUID has different authorization. Its branch destination was preserved.",
          );
        return { operation, replayed: true };
      }
      const runtime = await this.runtime(client);
      if (!runtime?.ready || !runtime.fresh || !runtime.repository_identity)
        throw new DevelopmentApplicationError(
          "APPLICATION_UNAVAILABLE",
          "A fresh registered local Git connector is required before authorization.",
          503,
        );
      const plan = createDevelopmentApplicationPlan(
        run,
        runtime.repository_identity,
        hash,
      );
      const operation = createDevelopmentApplication(plan, value, {
        id: randomUUID(),
        actor,
        now: this.options.now().toISOString(),
        hash,
      });
      await client.query(
        `INSERT INTO ${this.options.schema}.development_applications(workspace_id,id,run_id,request_id,revision,status,aggregate) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
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
        DEVELOPMENT_APPLICATION_QUEUE,
        { workspaceId, applicationId: operation.id },
        {
          singletonKey: `${workspaceId}:${operation.id}`,
          db: {
            executeSql: (text: string, values: unknown[]) =>
              client.query(text, values),
          },
        },
      );
      if (!job)
        throw new DevelopmentApplicationError(
          "APPLICATION_QUEUE_UNAVAILABLE",
          "Application authorization was rolled back because its durable job could not be queued.",
          503,
        );
      return { operation, replayed: false };
    });
  }
  async heartbeat(
    workerId: string,
    readiness: Awaited<ReturnType<DevelopmentGitAdapter["readiness"]>>,
  ): Promise<void> {
    if (
      readiness.ready &&
      !/^[a-f0-9]{64}$/.test(readiness.repositoryIdentity ?? "")
    )
      throw new Error(
        "A ready Git connector requires an exact registered identity.",
      );
    await this.options.transaction(async (client) => {
      await client.query(
        `UPDATE ${this.options.schema}.development_applications a SET seen_at=clock_timestamp() WHERE workspace_id=$1 AND worker_id=$2 AND status='running' AND seen_at>clock_timestamp()-interval '30 seconds' AND $3::boolean AND a.aggregate->'plan'->>'repositoryIdentity'=$4 AND EXISTS(SELECT 1 FROM ${this.options.schema}.development_application_runtime w WHERE w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id AND w.ready AND w.repository_identity=$4 AND w.seen_at>clock_timestamp()-interval '30 seconds')`,
        [
          workspace,
          workerId,
          readiness.ready,
          readiness.repositoryIdentity ?? null,
        ],
      );
      await client.query(
        `INSERT INTO ${this.options.schema}.development_application_runtime(workspace_id,worker_id,ready,reason,repository_identity,seen_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(workspace_id,worker_id) DO UPDATE SET ready=excluded.ready,reason=excluded.reason,repository_identity=excluded.repository_identity,seen_at=excluded.seen_at`,
        [
          workspace,
          workerId,
          readiness.ready,
          readiness.reason.slice(0, 600),
          readiness.repositoryIdentity ?? null,
        ],
      );
    });
  }
  async removeHeartbeat(workerId: string) {
    await this.options.pool.query(
      `DELETE FROM ${this.options.schema}.development_application_runtime WHERE workspace_id=$1 AND worker_id=$2`,
      [workspace, workerId],
    );
  }
  private async locked(client: PoolClient, id: string) {
    const result = await client.query(
      `SELECT aggregate FROM ${this.options.schema}.development_applications WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspace, id],
    );
    return result.rows[0]
      ? parseDevelopmentApplicationIntegrity(result.rows[0].aggregate, hash)
      : undefined;
  }
  async claim(
    workspaceId: string,
    id: string,
    workerId: string,
    attemptId: string,
  ): Promise<DevelopmentApplication | undefined> {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (!operation || operation.status !== "queued") return undefined;
      const ready = await client.query(
        `SELECT 1 FROM ${this.options.schema}.development_application_runtime WHERE workspace_id=$1 AND worker_id=$2 AND ready AND repository_identity=$3 AND seen_at>clock_timestamp()-interval '30 seconds' FOR SHARE`,
        [workspaceId, workerId, operation.plan.repositoryIdentity],
      );
      if (!ready.rowCount) return undefined;
      const next = withDevelopmentApplicationEvent(
        operation,
        "application.started",
        "The trusted worker claimed this authorized local branch operation.",
        this.options.now().toISOString(),
        { status: "running", workerId, attemptId },
      );
      await this.save(client, operation, next);
      return next;
    });
  }
  private async owns(
    client: PoolClient,
    operation: DevelopmentApplication,
    context: Context,
  ) {
    if (
      operation.status !== "running" ||
      operation.workerId !== context.workerId ||
      operation.attemptId !== context.attemptId ||
      operation.revision !== context.revision
    )
      return false;
    const result = await client.query(
      `SELECT 1 FROM ${this.options.schema}.development_applications a JOIN ${this.options.schema}.development_application_runtime w ON w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.seen_at>clock_timestamp()-interval '30 seconds' AND w.seen_at>clock_timestamp()-interval '30 seconds' AND w.ready AND w.repository_identity=$3 FOR SHARE OF w`,
      [workspace, operation.id, operation.plan.repositoryIdentity],
    );
    return result.rowCount === 1;
  }
  async prepared(
    workspaceId: string,
    id: string,
    context: Context,
    prepared: DevelopmentApplicationPrepared,
    signal?: AbortSignal,
  ) {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (!operation || !(await this.owns(client, operation, context)))
        return undefined;
      const next = withDevelopmentApplicationEvent(
        operation,
        "application.prepared",
        "Exact replacement tree and deterministic commit were retained before branch creation.",
        this.options.now().toISOString(),
        { prepared },
      );
      await this.save(client, operation, next);
      return next;
    }, signal);
  }
  async applied(
    workspaceId: string,
    id: string,
    context: Context,
    signal?: AbortSignal,
  ) {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (
        !operation ||
        !(await this.owns(client, operation, context)) ||
        !operation.prepared
      )
        return undefined;
      return this.complete(client, operation);
    }, signal);
  }
  private async complete(
    client: PoolClient,
    operation: DevelopmentApplication,
  ) {
    const now = this.options.now().toISOString(),
      plan = operation.plan;
    const next = withDevelopmentApplicationEvent(
      operation,
      "application.applied",
      "The exact local work branch and commit were observed and recorded. No checkout or network publication occurred.",
      now,
      {
        status: "applied",
        error: undefined,
        receipt: {
          applicationId: operation.id,
          runId: operation.runId,
          repositoryIdentity: plan.repositoryIdentity,
          packageSha256: plan.packageSha256,
          baseCommit: plan.baseCommit,
          destinationRef: plan.destinationRef,
          ...operation.prepared!,
          actor: operation.actor,
          authorizedAt: operation.authorizedAt,
          appliedAt: now,
        },
      },
    );
    await this.save(client, operation, next);
    return next;
  }
  async fail(
    workspaceId: string,
    id: string,
    context: Context,
    error: { code: string; message: string },
  ) {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const operation = await this.locked(client, id);
      if (!operation || !(await this.owns(client, operation, context)))
        return undefined;
      const status =
        error.code === "APPLICATION_BRANCH_CONFLICT"
          ? "conflict"
          : operation.prepared
            ? "unconfirmed"
            : "unavailable";
      const next = withDevelopmentApplicationEvent(
        operation,
        `application.${status}`,
        error.message,
        this.options.now().toISOString(),
        { status, error },
      );
      await this.save(client, operation, next);
      return next;
    });
  }
  /** Reconciliation may observe a branch; it never creates one or regenerates a patch. */
  async reconcile(connector: DevelopmentGitAdapter): Promise<void> {
    const result = await this.options.pool.query(
      `SELECT id,aggregate FROM ${this.options.schema}.development_applications a WHERE workspace_id=$1 AND ((status='unconfirmed' AND aggregate ? 'prepared' AND COALESCE(aggregate->'error'->>'code','')<>'APPLICATION_RESTORE_QUARANTINED') OR (status='running' AND (seen_at<clock_timestamp()-interval '30 seconds' OR NOT EXISTS(SELECT 1 FROM ${this.options.schema}.development_application_runtime w WHERE w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id AND w.ready AND w.repository_identity=a.aggregate->'plan'->>'repositoryIdentity' AND w.seen_at>clock_timestamp()-interval '30 seconds'))) OR (status='queued' AND NOT EXISTS(SELECT 1 FROM ${this.options.queueSchema}.job j WHERE j.name=$2 AND j.data->>'workspaceId'=a.workspace_id AND j.data->>'applicationId'=a.id::text AND j.state IN ('created','retry','active')))) ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END,seen_at ASC NULLS FIRST,id LIMIT 20`,
      [workspace, DEVELOPMENT_APPLICATION_QUEUE],
    );
    for (const row of result.rows) {
      let operation = await this.options.transaction(async (client) => {
        const value = await this.locked(client, row.id);
        if (
          !value ||
          !["running", "queued", "unconfirmed"].includes(value.status)
        )
          return undefined;
        if (value.status === "running") {
          const fresh = await client.query(
            `SELECT 1 FROM ${this.options.schema}.development_applications a JOIN ${this.options.schema}.development_application_runtime w ON w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id WHERE a.workspace_id=$1 AND a.id=$2 AND a.seen_at>clock_timestamp()-interval '30 seconds' AND w.seen_at>clock_timestamp()-interval '30 seconds' AND w.ready AND w.repository_identity=a.aggregate->'plan'->>'repositoryIdentity'`,
            [workspace, value.id],
          );
          if (fresh.rowCount) return undefined;
        }
        if (value.status === "queued") {
          const job = await client.query(
            `SELECT 1 FROM ${this.options.queueSchema}.job WHERE name=$1 AND data->>'applicationId'=$2 AND data->>'workspaceId'=$3 AND state IN ('created','retry','active')`,
            [DEVELOPMENT_APPLICATION_QUEUE, value.id, workspace],
          );
          if (job.rowCount) return undefined;
        }
        if (value.status === "unconfirmed") {
          if (
            !value.prepared ||
            value.error?.code === "APPLICATION_RESTORE_QUARANTINED"
          )
            return undefined;
          // Inactive seen_at is a fair inspection cursor, never renewed worker authority.
          await client.query(
            `UPDATE ${this.options.schema}.development_applications SET seen_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
            [workspace, value.id],
          );
          return value;
        }
        const next = withDevelopmentApplicationEvent(
          value,
          "application.unconfirmed",
          "The application worker or job is unavailable. Only read-only branch reconciliation is permitted; no action was restarted.",
          this.options.now().toISOString(),
          {
            status: "unconfirmed",
            error: {
              code: "APPLICATION_UNCONFIRMED",
              message:
                "The local branch outcome requires observation; authorization alone is not proof of application.",
            },
          },
        );
        await this.save(client, value, next);
        return next;
      });
      if (
        !operation?.prepared ||
        operation.error?.code === "APPLICATION_RESTORE_QUARANTINED"
      )
        continue;
      let state: "applied" | "absent" | "conflict";
      try {
        state = await connector.inspect(operation);
      } catch {
        continue;
      }
      if (state === "absent") continue;
      await this.options.transaction(async (client) => {
        const current = await this.locked(client, operation!.id);
        if (
          !current ||
          current.status !== "unconfirmed" ||
          current.revision !== operation!.revision
        )
          return;
        if (state === "applied") await this.complete(client, current);
        else
          await this.save(
            client,
            current,
            withDevelopmentApplicationEvent(
              current,
              "application.conflict",
              "The fixed branch contains another object. It was preserved.",
              this.options.now().toISOString(),
              {
                status: "conflict",
                error: {
                  code: "APPLICATION_BRANCH_CONFLICT",
                  message:
                    "The observed branch does not match the authorized deterministic commit.",
                },
              },
            ),
          );
      });
    }
  }
  private async save(
    client: PoolClient,
    previous: DevelopmentApplication,
    next: DevelopmentApplication,
  ) {
    parseDevelopmentApplicationIntegrity(next, hash);
    const result = await client.query(
      `UPDATE ${this.options.schema}.development_applications SET revision=$3,status=$4,aggregate=$5::jsonb,worker_id=$6,attempt_id=$7,seen_at=CASE WHEN $4='running' THEN clock_timestamp() ELSE seen_at END WHERE workspace_id=$1 AND id=$2 AND revision=$8`,
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
      throw new DevelopmentApplicationError(
        "STALE_APPLICATION",
        "This application changed before its result was saved.",
      );
    await this.events(client, previous, next);
  }
  private async events(
    client: PoolClient,
    previous: DevelopmentApplication | undefined,
    next: DevelopmentApplication,
  ) {
    const count = previous?.events.length ?? 0;
    if (
      previous &&
      JSON.stringify(next.events.slice(0, count)) !==
        JSON.stringify(previous.events)
    )
      throw new Error("Existing application events cannot change.");
    for (const event of next.events.slice(count))
      await client.query(
        `INSERT INTO ${this.options.schema}.development_application_events(workspace_id,application_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)`,
        [workspace, next.id, event.sequence, JSON.stringify(event)],
      );
  }
}
