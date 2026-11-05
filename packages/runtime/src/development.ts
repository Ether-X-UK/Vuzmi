import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  createDevelopmentRun,
  decideDevelopmentRun,
  developmentInputSchema,
  developmentProfileSchema,
  developmentProfileFingerprintInput,
  developmentCheckSchema,
  developmentBaselineAccepted,
  developmentReviewFingerprint,
  parseDevelopmentIntegrity,
  withDevelopmentEvent,
  DevelopmentError,
  developmentPackageSchema,
} from "@vuzmi/core";
import type {
  DevelopmentRun,
  DevelopmentInput,
  DevelopmentProfile,
  DevelopmentIssue,
  DevelopmentRuntime,
  DevelopmentCheck,
  DevelopmentCandidate,
  DecisionInput,
  Usage,
} from "@vuzmi/core";

export const DEVELOPMENT_QUEUE = "vuzmi-development-patch";
export const DEVELOPMENT_WORKSPACE = "local-workspace";
export const DEVELOPMENT_LEASE_SECONDS = 30;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Transaction = <T>(
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export { DevelopmentError };
export interface DevelopmentAttempt {
  workerId: string;
  attemptId: string;
  revision: number;
}
export interface DevelopmentJobData {
  workspaceId: string;
  runId: string;
}
type Readiness = {
  ready: boolean;
  reason: string;
  profile?: DevelopmentProfile;
  profiles?: DevelopmentProfile[];
};

/** Append-only v4; never revise the earlier migration strings. */
export function developmentMigration(schema: string): string {
  return `
    CREATE TABLE ${schema}.development_runs (
      workspace_id text NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL,
      request_hash text NOT NULL, owner_id text NOT NULL,
      revision integer NOT NULL CHECK(revision>0),
      status text NOT NULL CHECK(status IN ('queued','running','waiting_approval','completed','failed','cancelled')),
      aggregate jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
      PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,request_id),
      CHECK(aggregate->>'workspaceId'=workspace_id), CHECK(aggregate->>'id'=id::text),
      CHECK(aggregate->>'status'=status), CHECK((aggregate->>'revision')::integer=revision)
    );
    CREATE TABLE ${schema}.development_run_events (
      workspace_id text NOT NULL, run_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0),
      event jsonb NOT NULL, PRIMARY KEY(workspace_id,run_id,sequence),
      FOREIGN KEY(workspace_id,run_id) REFERENCES ${schema}.development_runs(workspace_id,id)
    );
    CREATE TRIGGER immutable_development_events BEFORE UPDATE OR DELETE ON ${schema}.development_run_events
      FOR EACH ROW EXECUTE FUNCTION ${schema}.protect_run_events();
    CREATE TABLE ${schema}.development_attempts (
      workspace_id text NOT NULL, run_id uuid NOT NULL, attempt_id uuid NOT NULL, worker_id uuid NOT NULL,
      state text NOT NULL CHECK(state IN ('active','recovering','closed')),
      execution_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL, seen_at timestamptz NOT NULL,
      PRIMARY KEY(workspace_id,attempt_id),
      FOREIGN KEY(workspace_id,run_id) REFERENCES ${schema}.development_runs(workspace_id,id)
    );
    CREATE UNIQUE INDEX development_one_active_attempt ON ${schema}.development_attempts(workspace_id,run_id) WHERE state IN ('active','recovering');
    CREATE TABLE ${schema}.development_runtime (
      workspace_id text NOT NULL, worker_id uuid NOT NULL,
      ready boolean NOT NULL, reason text NOT NULL, profile jsonb,
      seen_at timestamptz NOT NULL, PRIMARY KEY(workspace_id,worker_id)
    );
    CREATE TABLE ${schema}.development_artifacts (
      workspace_id text NOT NULL, run_id uuid NOT NULL, package jsonb NOT NULL, saved_at timestamptz NOT NULL,
      PRIMARY KEY(workspace_id,run_id),
      FOREIGN KEY(workspace_id,run_id) REFERENCES ${schema}.development_runs(workspace_id,id)
    );
  `;
}

export class DevelopmentRepository {
  constructor(
    private readonly options: {
      pool: Pool;
      boss: PgBoss;
      schema: string;
      queueSchema: string;
      transaction: Transaction;
      now: () => Date;
    },
  ) {}
  private get schema() {
    return this.options.schema;
  }
  private local(workspaceId: string) {
    if (workspaceId !== DEVELOPMENT_WORKSPACE)
      throw new DevelopmentError(
        "DEVELOPMENT_NOT_FOUND",
        "This development run is unavailable.",
        404,
      );
  }
  async list(workspaceId = DEVELOPMENT_WORKSPACE): Promise<DevelopmentRun[]> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.schema}.development_runs WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC`,
      [workspaceId],
    );
    return result.rows.map((row) =>
      parseDevelopmentIntegrity(row.aggregate, sha256),
    );
  }
  async get(
    workspaceId: string,
    id: string,
  ): Promise<DevelopmentRun | undefined> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT aggregate FROM ${this.schema}.development_runs WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? parseDevelopmentIntegrity(result.rows[0].aggregate, sha256)
      : undefined;
  }
  private async request(
    client: Pool | PoolClient,
    input: DevelopmentInput,
    actor: string,
  ): Promise<DevelopmentRun | undefined> {
    const value = developmentInputSchema.parse(input);
    const result = await client.query(
      `SELECT aggregate,request_hash,owner_id FROM ${this.schema}.development_runs WHERE workspace_id=$1 AND request_id=$2`,
      [DEVELOPMENT_WORKSPACE, value.requestId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    if (
      row.owner_id !== actor ||
      row.request_hash !== sha256(JSON.stringify(value))
    )
      throw new DevelopmentError(
        "DEVELOPMENT_REQUEST_CONFLICT",
        "This request UUID already identifies a different task or owner.",
      );
    return parseDevelopmentIntegrity(row.aggregate, sha256);
  }
  async findRequest(
    workspaceId: string,
    input: DevelopmentInput,
    actor: string,
  ): Promise<DevelopmentRun | undefined> {
    this.local(workspaceId);
    return this.request(this.options.pool, input, actor);
  }
  async create(
    input: DevelopmentInput,
    context: {
      id: string;
      actor: string;
      profile: DevelopmentProfile;
      issue?: DevelopmentIssue | null;
    },
  ): Promise<{ run: DevelopmentRun; replayed: boolean }> {
    const value = developmentInputSchema.parse(input);
    return this.options.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `vuzmi:development-request:${value.requestId}`,
      ]);
      const previous = await this.request(client, value, context.actor);
      if (previous) return { run: previous, replayed: true };
      if ((value.issueNumber ?? null) !== (context.issue?.number ?? null))
        throw new DevelopmentError(
          "DEVELOPMENT_ISSUE_MISMATCH",
          "The retained issue does not match the requested public issue.",
          400,
        );
      const ready = await client.query(
        `SELECT 1 FROM ${this.schema}.development_runtime WHERE workspace_id=$1 AND ready AND (profile->>'profileHash'=$2 OR profiles @> jsonb_build_array(jsonb_build_object('profileHash',$2::text))) AND seen_at>clock_timestamp()-interval '30 seconds' FOR SHARE`,
        [DEVELOPMENT_WORKSPACE, context.profile.profileHash],
      );
      if (!ready.rowCount)
        throw new DevelopmentError(
          "DEVELOPMENT_UNAVAILABLE",
          "The isolated runner is unavailable or its context changed. Refresh readiness before starting.",
          503,
        );
      const run = createDevelopmentRun(value, context.profile, {
        id: context.id,
        actor: context.actor,
        issue: context.issue,
        now: this.options.now().toISOString(),
        hash: sha256,
      });
      parseDevelopmentIntegrity(run, sha256);
      await client.query(
        `INSERT INTO ${this.schema}.development_runs(workspace_id,id,request_id,request_hash,owner_id,revision,status,aggregate,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [
          run.workspaceId,
          run.id,
          run.requestId,
          run.requestFingerprint,
          context.actor,
          run.revision,
          run.status,
          JSON.stringify(run),
          run.createdAt,
          run.updatedAt,
        ],
      );
      await this.effects(client, undefined, run);
      const job = await this.options.boss.send(
        DEVELOPMENT_QUEUE,
        { workspaceId: run.workspaceId, runId: run.id },
        {
          singletonKey: `${run.workspaceId}:${run.id}`,
          db: {
            executeSql: (text: string, values: unknown[]) =>
              client.query(text, values),
          },
        },
      );
      if (!job)
        throw new DevelopmentError(
          "DEVELOPMENT_QUEUE_UNAVAILABLE",
          "The task was not saved because its development job could not be queued.",
          503,
        );
      return { run, replayed: false };
    });
  }
  async heartbeat(workerId: string, readiness: Readiness): Promise<void> {
    const profile = readiness.profile
      ? developmentProfileSchema.parse(readiness.profile)
      : null;
    if (
      profile &&
      sha256(developmentProfileFingerprintInput(profile)) !==
        profile.profileHash
    )
      throw new DevelopmentError(
        "DEVELOPMENT_INTEGRITY",
        "The runner profile fingerprint is invalid.",
      );
    if (readiness.ready && !profile && !readiness.profiles?.length)
      throw new DevelopmentError(
        "DEVELOPMENT_INTEGRITY",
        "A ready runner requires a verified immutable profile catalog.",
      );
    const profiles = (readiness.profiles ?? (profile ? [profile] : [])).map(
      (value) => developmentProfileSchema.parse(value),
    );
    if (
      profiles.length > 8 ||
      new Set(profiles.map((value) => value.profileHash)).size !==
        profiles.length ||
      profiles.some(
        (value) =>
          sha256(developmentProfileFingerprintInput(value)) !==
          value.profileHash,
      ) ||
      (profile &&
        !profiles.some((value) => value.profileHash === profile.profileHash))
    )
      throw new DevelopmentError(
        "DEVELOPMENT_INTEGRITY",
        "The verified profile catalog is inconsistent.",
      );
    await this.options.transaction(async (client) => {
      for (const item of profiles) {
        const saved = await client.query(
          `INSERT INTO ${this.schema}.development_profiles(workspace_id,profile_hash,profile) VALUES($1,$2,$3::jsonb) ON CONFLICT(workspace_id,profile_hash) DO UPDATE SET profile=excluded.profile WHERE ${this.schema}.development_profiles.profile=excluded.profile RETURNING profile_hash`,
          [DEVELOPMENT_WORKSPACE, item.profileHash, JSON.stringify(item)],
        );
        if (saved.rowCount !== 1)
          throw new DevelopmentError(
            "DEVELOPMENT_INTEGRITY",
            "An immutable retained profile cannot be replaced.",
          );
      }
      await client.query(
        `UPDATE ${this.schema}.development_attempts a SET seen_at=clock_timestamp() WHERE workspace_id=$1 AND worker_id=$2 AND state='active' AND seen_at>clock_timestamp()-interval '30 seconds' AND EXISTS(SELECT 1 FROM ${this.schema}.development_runtime w WHERE w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id AND w.seen_at>clock_timestamp()-interval '30 seconds')`,
        [DEVELOPMENT_WORKSPACE, workerId],
      );
      await client.query(
        `INSERT INTO ${this.schema}.development_runtime(workspace_id,worker_id,ready,reason,profile,profiles,seen_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,clock_timestamp()) ON CONFLICT(workspace_id,worker_id) DO UPDATE SET ready=excluded.ready,reason=excluded.reason,profile=excluded.profile,profiles=excluded.profiles,seen_at=excluded.seen_at`,
        [
          DEVELOPMENT_WORKSPACE,
          workerId,
          readiness.ready,
          readiness.reason.slice(0, 600),
          profile ? JSON.stringify(profile) : null,
          JSON.stringify(profiles),
        ],
      );
    });
  }
  async removeHeartbeat(workerId: string): Promise<void> {
    await this.options.pool.query(
      `DELETE FROM ${this.schema}.development_runtime WHERE workspace_id=$1 AND worker_id=$2`,
      [DEVELOPMENT_WORKSPACE, workerId],
    );
  }
  async runtime(defaultModel = "qwen3.5:4b"): Promise<DevelopmentRuntime> {
    const result = await this.options.pool.query(
      `SELECT ready,reason,profile,profiles,seen_at,seen_at>clock_timestamp()-interval '30 seconds' AS fresh FROM ${this.schema}.development_runtime WHERE workspace_id=$1 ORDER BY (ready AND seen_at>clock_timestamp()-interval '30 seconds') DESC,seen_at DESC LIMIT 1`,
      [DEVELOPMENT_WORKSPACE],
    );
    const row = result.rows[0];
    return {
      ready: Boolean(row?.ready && row.fresh),
      checkedAt: this.options.now().toISOString(),
      reason: row?.fresh
        ? row.reason
        : "No fresh isolated development worker is available. Provision the fixed runner and start the worker.",
      profile: row?.profile
        ? developmentProfileSchema.parse(row.profile)
        : null,
      defaultModel,
      ...(row?.profiles
        ? {
            profiles: row.profiles.map((item: unknown) =>
              developmentProfileSchema.parse(item),
            ),
          }
        : {}),
    };
  }
  private async locked(
    client: PoolClient,
    workspaceId: string,
    id: string,
  ): Promise<DevelopmentRun | undefined> {
    const result = await client.query(
      `SELECT aggregate FROM ${this.schema}.development_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? parseDevelopmentIntegrity(result.rows[0].aggregate, sha256)
      : undefined;
  }
  private async owns(
    client: PoolClient,
    run: DevelopmentRun,
    context: DevelopmentAttempt,
  ): Promise<boolean> {
    if (
      run.status !== "running" ||
      run.attemptId !== context.attemptId ||
      run.workerId !== context.workerId ||
      run.revision !== context.revision
    )
      return false;
    const result = await client.query(
      `SELECT 1 FROM ${this.schema}.development_attempts a JOIN ${this.schema}.development_runtime w ON w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id WHERE a.workspace_id=$1 AND a.run_id=$2 AND a.attempt_id=$3 AND a.worker_id=$4 AND a.state='active' AND a.seen_at>clock_timestamp()-interval '30 seconds' AND w.seen_at>clock_timestamp()-interval '30 seconds' FOR UPDATE OF a FOR SHARE OF w`,
      [run.workspaceId, run.id, context.attemptId, context.workerId],
    );
    return result.rowCount === 1;
  }
  async claim(
    workspaceId: string,
    id: string,
    workerId: string,
    attemptId: string,
  ): Promise<DevelopmentRun | undefined> {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const run = await this.locked(client, workspaceId, id);
      if (!run || run.status !== "queued") return undefined;
      const worker = await client.query(
        `SELECT 1 FROM ${this.schema}.development_runtime WHERE workspace_id=$1 AND worker_id=$2 AND ready AND (profile->>'profileHash'=$3 OR profiles @> jsonb_build_array(jsonb_build_object('profileHash',$3::text))) AND seen_at>clock_timestamp()-interval '30 seconds' FOR SHARE`,
        [workspaceId, workerId, run.profile.profileHash],
      );
      if (!worker.rowCount)
        throw new DevelopmentError(
          "DEVELOPMENT_UNAVAILABLE",
          "The worker no longer has the pinned isolated runner profile.",
          503,
        );
      await client.query(
        `INSERT INTO ${this.schema}.development_attempts(workspace_id,run_id,attempt_id,worker_id,state,created_at,seen_at) VALUES($1,$2,$3,$4,'active',clock_timestamp(),clock_timestamp())`,
        [workspaceId, id, attemptId, workerId],
      );
      const next = withDevelopmentEvent(
        run,
        "development.started",
        "The worker claimed this pinned development task; no check has passed yet.",
        this.options.now().toISOString(),
        { status: "running", attemptId, workerId },
      );
      await this.save(client, run, next);
      return next;
    });
  }
  private async change(
    workspaceId: string,
    id: string,
    context: DevelopmentAttempt,
    update: (
      run: DevelopmentRun,
      client: PoolClient,
    ) => Promise<DevelopmentRun> | DevelopmentRun,
    signal?: AbortSignal,
  ): Promise<DevelopmentRun | undefined> {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const run = await this.locked(client, workspaceId, id);
      if (!run || !(await this.owns(client, run, context))) return undefined;
      signal?.throwIfAborted();
      const next = await update(run, client);
      await this.save(client, run, next);
      if (next.status !== "running")
        await client.query(
          `UPDATE ${this.schema}.development_attempts SET state=$4,seen_at=clock_timestamp() WHERE workspace_id=$1 AND run_id=$2 AND attempt_id=$3`,
          [
            workspaceId,
            id,
            context.attemptId,
            next.status === "failed" ? "recovering" : "closed",
          ],
        );
      return next;
    }, signal);
  }
  async reserveExecution(
    workspaceId: string,
    id: string,
    context: DevelopmentAttempt,
    phase: "baseline" | "candidate",
    executionId: string,
    signal?: AbortSignal,
  ): Promise<DevelopmentRun | undefined> {
    if (
      !/^vuzmi-dev-[a-z0-9-]{1,140}$/.test(executionId) ||
      executionId !== `vuzmi-dev-${id}-${context.attemptId}-${phase}`
    )
      throw new DevelopmentError(
        "INVALID_EXECUTION",
        "The owned execution identity is invalid.",
        400,
      );
    return this.change(
      workspaceId,
      id,
      context,
      async (run, client) => {
        if (
          run.execution ||
          (phase === "baseline"
            ? run.stage !== "baseline"
            : run.stage !== "checking" || !run.candidate)
        )
          throw new DevelopmentError(
            "INVALID_STAGE",
            "An execution cannot replace a previous or unexpected check.",
          );
        await client.query(
          `UPDATE ${this.schema}.development_attempts SET execution_ids=execution_ids||$4::jsonb WHERE workspace_id=$1 AND run_id=$2 AND attempt_id=$3`,
          [workspaceId, id, context.attemptId, JSON.stringify([executionId])],
        );
        return withDevelopmentEvent(
          run,
          "development.check_started",
          `${phase} execution was reserved before invoking the isolated runner.`,
          this.options.now().toISOString(),
          { execution: { id: executionId, phase } },
        );
      },
      signal,
    );
  }
  async baseline(
    workspaceId: string,
    id: string,
    context: DevelopmentAttempt,
    value: DevelopmentCheck,
    signal?: AbortSignal,
  ): Promise<DevelopmentRun | undefined> {
    const receipt = developmentCheckSchema.parse(value);
    return this.change(
      workspaceId,
      id,
      context,
      (run) => {
        if (
          run.execution?.id !== receipt.executionId ||
          run.execution.phase !== "baseline" ||
          receipt.phase !== "baseline"
        )
          throw new DevelopmentError(
            "STALE_EXECUTION",
            "The baseline receipt does not identify the reserved execution.",
          );
        const reproduced = developmentBaselineAccepted(receipt, run.profile);
        return withDevelopmentEvent(
          run,
          "development.baseline_recorded",
          reproduced
            ? run.profile.id === "web-api-status-authority"
              ? "The isolated baseline reproduced the two expected session-expiry failures."
              : "The pinned baseline passed its named regression checks."
            : "The baseline did not satisfy this pinned profile; generation is blocked.",
          this.options.now().toISOString(),
          {
            baseline: receipt,
            execution: undefined,
            stage: reproduced ? "generating" : "finished",
            ...(reproduced
              ? {}
              : {
                  status: "failed",
                  error: {
                    code: "BASELINE_NOT_REPRODUCED",
                    message:
                      "The pinned baseline did not satisfy the immutable check profile.",
                  },
                }),
          },
        );
      },
      signal,
    );
  }
  async candidate(
    workspaceId: string,
    id: string,
    context: DevelopmentAttempt,
    value: {
      candidate: DevelopmentCandidate;
      usage: Usage;
      modelDigest: string;
    },
    signal?: AbortSignal,
  ): Promise<DevelopmentRun | undefined> {
    return this.change(
      workspaceId,
      id,
      context,
      (run) => {
        if (
          run.stage !== "generating" ||
          run.candidate ||
          !run.baseline ||
          !developmentBaselineAccepted(run.baseline, run.profile)
        )
          throw new DevelopmentError(
            "INVALID_STAGE",
            "Only an accepted pinned baseline may receive one local model proposal.",
          );
        return withDevelopmentEvent(
          run,
          "development.patch_validated",
          "The local model returned server-validated permitted replacements. Checks have not passed yet.",
          this.options.now().toISOString(),
          {
            candidate: value.candidate,
            usage: value.usage,
            modelDigest: value.modelDigest,
            routeExecuted: true,
            stage: "checking",
          },
        );
      },
      signal,
    );
  }
  async checks(
    workspaceId: string,
    id: string,
    context: DevelopmentAttempt,
    value: DevelopmentCheck,
    signal?: AbortSignal,
  ): Promise<DevelopmentRun | undefined> {
    const receipt = developmentCheckSchema.parse(value);
    return this.change(
      workspaceId,
      id,
      context,
      (run) => {
        if (
          run.execution?.id !== receipt.executionId ||
          run.execution.phase !== "candidate" ||
          receipt.phase !== "candidate"
        )
          throw new DevelopmentError(
            "STALE_EXECUTION",
            "The candidate receipt does not identify the reserved execution.",
          );
        const passed = receipt.status === "passed";
        const next = withDevelopmentEvent(
          run,
          "development.checks_recorded",
          passed
            ? "The fixed isolated candidate profile passed. Human review is still required."
            : "The isolated candidate checks did not pass; approval is blocked.",
          this.options.now().toISOString(),
          {
            checks: receipt,
            execution: undefined,
            status: passed ? "waiting_approval" : "failed",
            stage: passed ? "review" : "finished",
            ...(passed
              ? {}
              : {
                  error: {
                    code: "DEVELOPMENT_CHECKS_FAILED",
                    message:
                      "The fixed isolated candidate checks did not pass.",
                  },
                }),
          },
        );
        if (passed)
          next.reviewFingerprint = developmentReviewFingerprint(next, sha256);
        return next;
      },
      signal,
    );
  }
  async fail(
    workspaceId: string,
    id: string,
    context: DevelopmentAttempt,
    error: { code: string; message: string },
    observed?: { modelDigest: string; usage: Usage },
  ): Promise<DevelopmentRun | undefined> {
    return this.change(workspaceId, id, context, (run) =>
      withDevelopmentEvent(
        run,
        "development.failed",
        error.message,
        this.options.now().toISOString(),
        {
          status: "failed",
          stage: "finished",
          error,
          ...(observed && run.stage === "generating" && !run.candidate
            ? {
                modelDigest: observed.modelDigest,
                usage: observed.usage,
                routeExecuted: true,
              }
            : {}),
        },
      ),
    );
  }
  async failQueued(
    workspaceId: string,
    id: string,
    error: { code: string; message: string },
  ): Promise<void> {
    this.local(workspaceId);
    await this.options.transaction(async (client) => {
      const run = await this.locked(client, workspaceId, id);
      if (run?.status === "queued")
        await this.save(
          client,
          run,
          withDevelopmentEvent(
            run,
            "development.failed",
            error.message,
            this.options.now().toISOString(),
            { status: "failed", stage: "finished", error },
          ),
        );
    });
  }
  async cleanupAttempt(
    workspaceId: string,
    id: string,
    attemptId: string,
    workerId: string,
    cleanup: (executionId: string) => Promise<boolean>,
  ): Promise<boolean> {
    this.local(workspaceId);
    const result = await this.options.pool.query(
      `SELECT execution_ids FROM ${this.schema}.development_attempts WHERE workspace_id=$1 AND run_id=$2 AND attempt_id=$3 AND worker_id=$4`,
      [workspaceId, id, attemptId, workerId],
    );
    const ids: unknown = result.rows[0]?.execution_ids;
    if (
      !Array.isArray(ids) ||
      ids.length > 2 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (value) =>
          value !== `vuzmi-dev-${id}-${attemptId}-baseline` &&
          value !== `vuzmi-dev-${id}-${attemptId}-candidate`,
      )
    )
      return false;
    let cleaned = true;
    for (const executionId of ids)
      try {
        if (!(await cleanup(executionId))) cleaned = false;
      } catch {
        cleaned = false;
      }
    await this.options.pool.query(
      `UPDATE ${this.schema}.development_attempts SET state=$5,seen_at=clock_timestamp() WHERE workspace_id=$1 AND run_id=$2 AND attempt_id=$3 AND worker_id=$4`,
      [workspaceId, id, attemptId, workerId, cleaned ? "closed" : "recovering"],
    );
    return cleaned;
  }
  async reconcile(
    workerId: string,
    cleanup: (executionId: string) => Promise<boolean>,
  ): Promise<void> {
    const stale = await this.options.pool.query(
      `SELECT a.run_id,a.attempt_id FROM ${this.schema}.development_attempts a LEFT JOIN ${this.schema}.development_runtime w ON w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id WHERE a.workspace_id=$1 AND ((a.state='active' AND (a.seen_at<clock_timestamp()-interval '30 seconds' OR w.seen_at IS NULL OR w.seen_at<clock_timestamp()-interval '30 seconds')) OR (a.state='recovering' AND a.seen_at<clock_timestamp()-interval '30 seconds')) LIMIT 20`,
      [DEVELOPMENT_WORKSPACE],
    );
    for (const row of stale.rows) {
      const reserved = await this.options.transaction(async (client) => {
        const run = await this.locked(
          client,
          DEVELOPMENT_WORKSPACE,
          row.run_id,
        );
        if (!run) return false;
        const attempt = await client.query(
          `SELECT a.state,a.worker_id,a.seen_at>clock_timestamp()-interval '30 seconds' AS fresh FROM ${this.schema}.development_attempts a WHERE a.workspace_id=$1 AND a.attempt_id=$2 AND ((a.state='active' AND (a.seen_at<clock_timestamp()-interval '30 seconds' OR NOT EXISTS(SELECT 1 FROM ${this.schema}.development_runtime w WHERE w.workspace_id=a.workspace_id AND w.worker_id=a.worker_id AND w.seen_at>clock_timestamp()-interval '30 seconds'))) OR (a.state='recovering' AND a.seen_at<clock_timestamp()-interval '30 seconds')) FOR UPDATE`,
          [DEVELOPMENT_WORKSPACE, row.attempt_id],
        );
        if (!attempt.rowCount) return false;
        if (attempt.rows[0].state === "active") {
          // Recheck after acquiring the attempt lock, using a new statement
          // snapshot so a concurrently committed heartbeat cannot be stolen.
          const owner = await client.query(
            `SELECT seen_at>clock_timestamp()-interval '30 seconds' AS fresh FROM ${this.schema}.development_runtime WHERE workspace_id=$1 AND worker_id=$2 FOR SHARE`,
            [DEVELOPMENT_WORKSPACE, attempt.rows[0].worker_id],
          );
          if (owner.rows[0]?.fresh && attempt.rows[0].fresh) return false;
        }
        await client.query(
          `UPDATE ${this.schema}.development_attempts SET state='recovering',worker_id=$3,seen_at=clock_timestamp() WHERE workspace_id=$1 AND attempt_id=$2`,
          [DEVELOPMENT_WORKSPACE, row.attempt_id, workerId],
        );
        if (run.status === "running")
          await this.save(
            client,
            run,
            withDevelopmentEvent(
              run,
              "development.interrupted",
              "Worker ownership expired. The unknown attempt was fenced; no automatic generation or check retry was started.",
              this.options.now().toISOString(),
              {
                status: "failed",
                stage: "finished",
                error: {
                  code: "DEVELOPMENT_INTERRUPTED",
                  message:
                    "The previous worker lost ownership. Any unknown output was discarded; start a new task after reviewing this history.",
                },
              },
            ),
          );
        return true;
      });
      if (reserved)
        await this.cleanupAttempt(
          DEVELOPMENT_WORKSPACE,
          row.run_id,
          row.attempt_id,
          workerId,
          cleanup,
        );
    }
    const orphaned = await this.options.pool.query(
      `SELECT r.id FROM ${this.schema}.development_runs r WHERE r.workspace_id=$1 AND ((r.status='running' AND NOT EXISTS(SELECT 1 FROM ${this.schema}.development_attempts a WHERE a.workspace_id=r.workspace_id AND a.run_id=r.id AND a.state IN ('active','recovering'))) OR (r.status='queued' AND NOT EXISTS(SELECT 1 FROM ${this.options.queueSchema}.job j WHERE j.name=$2 AND j.data->>'workspaceId'=r.workspace_id AND j.data->>'runId'=r.id::text AND j.state IN ('created','retry','active')))) LIMIT 20`,
      [DEVELOPMENT_WORKSPACE, DEVELOPMENT_QUEUE],
    );
    for (const row of orphaned.rows)
      await this.options.transaction(async (client) => {
        const run = await this.locked(client, DEVELOPMENT_WORKSPACE, row.id);
        if (!run || !["queued", "running"].includes(run.status)) return;
        const live = await client.query(
          `SELECT 1 FROM ${this.schema}.development_attempts WHERE workspace_id=$1 AND run_id=$2 AND state IN ('active','recovering') UNION ALL SELECT 1 FROM ${this.options.queueSchema}.job WHERE name=$3 AND data->>'workspaceId'=$1 AND data->>'runId'=$2::text AND state IN ('created','retry','active')`,
          [DEVELOPMENT_WORKSPACE, row.id, DEVELOPMENT_QUEUE],
        );
        if (live.rowCount) return;
        await this.save(
          client,
          run,
          withDevelopmentEvent(
            run,
            "development.unavailable",
            "The queued job or attempt is unavailable or was quarantined during recovery. No execution was restarted.",
            this.options.now().toISOString(),
            {
              status: "failed",
              stage: "finished",
              error: {
                code: "DEVELOPMENT_JOB_UNAVAILABLE",
                message:
                  "No authorized live development job remains. Start a new task deliberately.",
              },
            },
          ),
        );
      });
  }
  async decide(
    workspaceId: string,
    id: string,
    input: DecisionInput,
    actor: { id: string; name?: string },
  ): Promise<DevelopmentRun> {
    this.local(workspaceId);
    return this.options.transaction(async (client) => {
      const run = await this.locked(client, workspaceId, id);
      if (!run)
        throw new DevelopmentError(
          "DEVELOPMENT_NOT_FOUND",
          "This development run does not exist.",
          404,
        );
      const next = decideDevelopmentRun(
        run,
        input,
        this.options.now().toISOString(),
        actor,
        sha256,
      );
      if (next !== run) await this.save(client, run, next);
      return next;
    });
  }
  async package(
    workspaceId: string,
    id: string,
  ): Promise<{ content: string; sha256: string }> {
    const run = await this.get(workspaceId, id);
    if (!run)
      throw new DevelopmentError(
        "DEVELOPMENT_NOT_FOUND",
        "This development run does not exist.",
        404,
      );
    if (run.status !== "completed" || !run.artifact)
      throw new DevelopmentError(
        "DEVELOPMENT_NOT_APPROVED",
        "Only an approved local development package can be downloaded.",
      );
    const row = await this.options.pool.query(
      `SELECT package FROM ${this.schema}.development_artifacts WHERE workspace_id=$1 AND run_id=$2`,
      [workspaceId, id],
    );
    if (
      !row.rows[0] ||
      JSON.stringify(developmentPackageSchema.parse(row.rows[0].package)) !==
        JSON.stringify(
          developmentPackageSchema.parse(JSON.parse(run.artifact.content)),
        )
    )
      throw new DevelopmentError(
        "DEVELOPMENT_INTEGRITY",
        "The durable development artifact differs from its reviewed aggregate.",
      );
    return { content: run.artifact.content, sha256: run.artifact.sha256 };
  }
  private async save(
    client: PoolClient,
    previous: DevelopmentRun,
    next: DevelopmentRun,
  ): Promise<void> {
    parseDevelopmentIntegrity(next, sha256);
    const result = await client.query(
      `UPDATE ${this.schema}.development_runs SET revision=$3,status=$4,aggregate=$5::jsonb,updated_at=$6 WHERE workspace_id=$1 AND id=$2 AND revision=$7`,
      [
        next.workspaceId,
        next.id,
        next.revision,
        next.status,
        JSON.stringify(next),
        next.updatedAt,
        previous.revision,
      ],
    );
    if (result.rowCount !== 1)
      throw new DevelopmentError(
        "STALE_DEVELOPMENT",
        "The development task changed before saving.",
      );
    await this.effects(client, previous, next);
  }
  private async effects(
    client: PoolClient,
    previous: DevelopmentRun | undefined,
    next: DevelopmentRun,
  ): Promise<void> {
    const count = previous?.events.length ?? 0;
    if (
      previous &&
      JSON.stringify(next.events.slice(0, count)) !==
        JSON.stringify(previous.events)
    )
      throw new DevelopmentError(
        "DEVELOPMENT_INTEGRITY",
        "Existing development events cannot change.",
      );
    for (const event of next.events.slice(count))
      await client.query(
        `INSERT INTO ${this.schema}.development_run_events(workspace_id,run_id,sequence,event) VALUES($1,$2,$3,$4::jsonb)`,
        [next.workspaceId, next.id, event.sequence, JSON.stringify(event)],
      );
    if (next.artifact && !previous?.artifact)
      await client.query(
        `INSERT INTO ${this.schema}.development_artifacts(workspace_id,run_id,package,saved_at) VALUES($1,$2,$3::jsonb,$4)`,
        [
          next.workspaceId,
          next.id,
          next.artifact.content,
          next.artifact.savedAt,
        ],
      );
  }
}
