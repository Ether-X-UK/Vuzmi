import { createHash } from "node:crypto";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import {
  claimGeneration,
  attachEvidence,
  completeGeneration,
  createQueuedRun,
  createRunSchema,
  createSimulationRun,
  decideRun,
  exhaustGeneration,
  failGeneration,
  parseRunIntegrity,
} from "@vuzmi/core";
import type { CreateRunInput, DecisionInput, Run, Usage } from "@vuzmi/core";
import {
  INDEX_QUEUE,
  KnowledgeRepository,
  knowledgeMigration,
} from "./knowledge.js";
import type { KnowledgeEmbedder } from "./knowledge.js";

export const GENERATION_QUEUE = "vuzmi-generate-release";
export const GENERATION_RETRY_LIMIT = 2;
export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export interface GenerationJobData {
  workspaceId: string;
  runId: string;
  model: string;
}
export interface RepositoryOptions {
  connectionString: string;
  schema?: string;
  queueSchema?: string;
  now?: () => Date;
}
export interface ClaimContext {
  attemptId: string;
  allowRecovery?: boolean;
  model?: string;
}
export interface CompleteContext {
  attemptId: string;
  expectedRevision: number;
  content: string;
  usage: Usage;
  signal?: AbortSignal;
}
export interface FailContext {
  attemptId: string;
  expectedRevision: number;
  error: NonNullable<Run["error"]>;
  willRetry: boolean;
}

export class RunNotFoundError extends Error {
  readonly code = "RUN_NOT_FOUND";
  constructor() {
    super("This run does not exist in the local workspace.");
  }
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error(
      "Database schema names must contain lowercase letters, digits, and underscores.",
    );
  return `"${value}"`;
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const client = await pool.connect();
  try {
    signal?.throwIfAborted();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await operation(client);
    signal?.throwIfAborted();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function migrate(pool: Pool, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  const migration = `
    CREATE TABLE ${schema}.runs (
      workspace_id text NOT NULL,
      id text NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      status text NOT NULL CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled')),
      aggregate jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (workspace_id, id),
      CHECK (aggregate->>'workspaceId' = workspace_id),
      CHECK (aggregate->>'id' = id),
      CHECK (aggregate->>'status' = status),
      CHECK ((aggregate->>'revision')::integer = revision)
    );
    CREATE INDEX runs_by_workspace_created ON ${schema}.runs(workspace_id, created_at DESC);
    CREATE TABLE ${schema}.run_events (
      workspace_id text NOT NULL,
      run_id text NOT NULL,
      sequence integer NOT NULL CHECK (sequence > 0),
      event jsonb NOT NULL,
      PRIMARY KEY (workspace_id, run_id, sequence),
      FOREIGN KEY (workspace_id, run_id) REFERENCES ${schema}.runs(workspace_id, id)
    );
    CREATE TABLE ${schema}.artifacts (
      workspace_id text NOT NULL,
      run_id text NOT NULL,
      id text NOT NULL,
      content text NOT NULL,
      saved_at timestamptz NOT NULL,
      PRIMARY KEY (workspace_id, run_id),
      UNIQUE (workspace_id, id),
      FOREIGN KEY (workspace_id, run_id) REFERENCES ${schema}.runs(workspace_id, id)
    );
    CREATE TABLE ${schema}.worker_heartbeats (
      id text PRIMARY KEY,
      seen_at timestamptz NOT NULL
    );
    CREATE FUNCTION ${schema}.protect_run_events() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      RAISE EXCEPTION 'Run events are append-only';
    END;
    $function$;
    CREATE TRIGGER immutable_run_events BEFORE UPDATE OR DELETE ON ${schema}.run_events
      FOR EACH ROW EXECUTE FUNCTION ${schema}.protect_run_events();
  `;
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `vuzmi:migrations:${schemaName}`,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const item of [
      { version: 1, sql: migration },
      { version: 2, sql: knowledgeMigration(schema) },
    ]) {
      const existing = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${schema}.schema_migrations WHERE version=$1`,
        [item.version],
      );
      const checksum = sha256(item.sql);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(
            "Runtime migration checksum mismatch. Refusing to change the database.",
          );
        continue;
      }
      await client.query(item.sql);
      await client.query(
        `INSERT INTO ${schema}.schema_migrations(version,checksum) VALUES($1,$2)`,
        [item.version, checksum],
      );
    }
  });
}

/** Single-organization repository. Tenant-qualified SQL is not a public multi-tenant security claim. */
export class PostgresRunRepository {
  readonly schema: string;
  readonly queueSchema: string;
  readonly knowledge: KnowledgeRepository;
  private closed = false;

  private constructor(
    private readonly pool: Pool,
    readonly boss: PgBoss,
    schema: string,
    queueSchema: string,
    private readonly now: () => Date,
  ) {
    this.schema = identifier(schema);
    this.queueSchema = identifier(queueSchema);
    this.knowledge = new KnowledgeRepository({
      pool,
      boss,
      schema: this.schema,
      queueSchema: this.queueSchema,
      transaction: (operation, signal) => transaction(pool, operation, signal),
      now,
    });
  }

  static async connect(
    options: RepositoryOptions,
  ): Promise<PostgresRunRepository> {
    const schema = options.schema ?? "vuzmi";
    const queueSchema = options.queueSchema ?? "vuzmi_queue";
    identifier(schema);
    identifier(queueSchema);
    if (schema === queueSchema)
      throw new Error("Application and queue schemas must be different.");
    const pool = new Pool({
      connectionString: options.connectionString,
      max: 5,
      application_name: "vuzmi-runtime",
    });
    let boss: PgBoss | undefined;
    try {
      await migrate(pool, schema);
      boss = new PgBoss({
        connectionString: options.connectionString,
        schema: queueSchema,
        max: 4,
      });
      boss.on("error", () =>
        console.error(
          "Vuzmi queue encountered a database error. Check local runtime connectivity.",
        ),
      );
      await boss.start();
      await boss.createQueue(GENERATION_QUEUE, {
        policy: "singleton",
        retryLimit: GENERATION_RETRY_LIMIT,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: 300,
        heartbeatSeconds: 10,
      });
      await boss.createQueue(INDEX_QUEUE, {
        policy: "singleton",
        retryLimit: 2,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: 300,
        heartbeatSeconds: 10,
      });
      return new PostgresRunRepository(
        pool,
        boss,
        schema,
        queueSchema,
        options.now ?? (() => new Date()),
      );
    } catch (error) {
      await boss?.stop().catch(() => undefined);
      await pool.end();
      throw error;
    }
  }

  async list(workspaceId = "local-workspace"): Promise<Run[]> {
    const result = await this.pool.query<{ aggregate: unknown }>(
      `SELECT aggregate FROM ${this.schema}.runs WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
      [workspaceId],
    );
    return result.rows.map((row) => parseRunIntegrity(row.aggregate, sha256));
  }

  async get(workspaceId: string, id: string): Promise<Run | undefined> {
    const result = await this.pool.query<{ aggregate: unknown }>(
      `SELECT aggregate FROM ${this.schema}.runs WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? parseRunIntegrity(result.rows[0].aggregate, sha256)
      : undefined;
  }

  async create(
    input: CreateRunInput,
    context: { workspaceId: string; id: string; model?: string },
  ): Promise<Run> {
    if (context.workspaceId !== "local-workspace")
      throw new Error(
        "This private runtime supports the local workspace only.",
      );
    const parsed = createRunSchema.parse(input);
    const now = this.now().toISOString();
    const model = context.model ?? parsed.model;
    if (parsed.mode === "ollama" && !model)
      throw new Error("A configured local Ollama model is required.");
    const run =
      parsed.mode === "ollama"
        ? createQueuedRun(parsed, { id: context.id, now, model: model! })
        : createSimulationRun(parsed, {
            id: context.id,
            now,
            fingerprint: sha256,
          });
    parseRunIntegrity(run, sha256);
    await transaction(this.pool, async (client) => {
      const pins = parsed.knowledge
        ? await this.knowledge.pinSelection(client, parsed.knowledge)
        : undefined;
      await client.query(
        `INSERT INTO ${this.schema}.runs
        (workspace_id, id, revision, status, aggregate, created_at, updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [
          run.workspaceId,
          run.id,
          run.revision,
          run.status,
          JSON.stringify(run),
          run.createdAt,
          run.updatedAt,
        ],
      );
      await this.appendEffects(client, undefined, run);
      if (pins) await this.knowledge.savePins(client, run.id, pins);
      if (run.mode === "ollama") {
        const data: GenerationJobData = {
          workspaceId: run.workspaceId,
          runId: run.id,
          model: run.route.model!,
        };
        const jobId = await this.boss.send(GENERATION_QUEUE, data, {
          singletonKey: `${run.workspaceId}:${run.id}`,
          db: {
            executeSql: (text: string, values: unknown[]) =>
              client.query(text, values),
          },
        });
        if (!jobId)
          throw new Error(
            "The local generation job was not queued; the run was not saved.",
          );
      }
    });
    return run;
  }

  async decide(
    workspaceId: string,
    id: string,
    input: DecisionInput,
    actor?: { id: string; name: string },
  ): Promise<Run> {
    const result = await this.change(workspaceId, id, (run) =>
      decideRun(run, input, this.now().toISOString(), actor),
    );
    if (!result) throw new RunNotFoundError();
    return result;
  }

  async claim(
    workspaceId: string,
    id: string,
    context: ClaimContext,
  ): Promise<Run | undefined> {
    return this.change(workspaceId, id, (run) => {
      if (context.model !== undefined && context.model !== run.route.model)
        return undefined;
      return claimGeneration(run, {
        ...context,
        now: this.now().toISOString(),
      });
    });
  }

  async complete(
    workspaceId: string,
    id: string,
    context: CompleteContext,
  ): Promise<Run | undefined> {
    return this.change(
      workspaceId,
      id,
      async (run, client) => {
        const next = completeGeneration(run, {
          ...context,
          now: this.now().toISOString(),
          fingerprint: sha256,
        });
        if (next?.knowledge)
          await this.knowledge.assertRunPins(workspaceId, id, client);
        return next;
      },
      context.signal,
    );
  }

  async prepareEvidence(
    workspaceId: string,
    id: string,
    context: { attemptId: string; expectedRevision: number },
    embed: KnowledgeEmbedder,
    signal?: AbortSignal,
  ): Promise<Run | undefined> {
    const current = await this.get(workspaceId, id);
    if (
      !current ||
      current.status !== "running" ||
      current.attemptId !== context.attemptId ||
      current.revision !== context.expectedRevision
    )
      return undefined;
    if (!current.knowledge) return current;
    const pins = await this.knowledge.runPins(workspaceId, id);
    if (!pins) throw new Error("Required evidence pins are missing.");
    const evidence =
      current.evidence ??
      (await this.knowledge.searchPinned(
        pins,
        `${current.title}\n${current.brief}`.slice(0, 1000),
        embed,
        signal,
      ));
    signal?.throwIfAborted();
    return this.change(workspaceId, id, async (run, client) => {
      await this.knowledge.assertRunPins(workspaceId, id, client);
      return attachEvidence(run, {
        ...context,
        evidence,
        now: this.now().toISOString(),
      });
    });
  }

  async fail(
    workspaceId: string,
    id: string,
    context: FailContext,
  ): Promise<Run | undefined> {
    return this.change(workspaceId, id, (run) =>
      failGeneration(run, { ...context, now: this.now().toISOString() }),
    );
  }

  async heartbeat(id: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.worker_heartbeats(id, seen_at) VALUES ($1, now())
      ON CONFLICT (id) DO UPDATE SET seen_at = excluded.seen_at`,
      [id],
    );
  }

  async removeHeartbeat(id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.schema}.worker_heartbeats WHERE id = $1`,
      [id],
    );
  }

  async workerHealth(): Promise<{
    state: "ready" | "offline";
    lastSeenAt: string | null;
  }> {
    const result = await this.pool.query<{
      last_seen_at: Date | null;
      ready: boolean;
    }>(
      `SELECT max(seen_at) AS last_seen_at, coalesce(max(seen_at) > now() - interval '30 seconds', false) AS ready
       FROM ${this.schema}.worker_heartbeats`,
    );
    return {
      state: result.rows[0]!.ready ? "ready" : "offline",
      lastSeenAt: result.rows[0]!.last_seen_at?.toISOString() ?? null,
    };
  }

  async reconcileExhausted(): Promise<void> {
    const result = await this.pool.query<{ data: GenerationJobData }>(
      `SELECT job.data FROM ${this.queueSchema}.job AS job
       JOIN ${this.schema}.runs AS run ON run.workspace_id = job.data->>'workspaceId' AND run.id = job.data->>'runId'
       WHERE job.name = $1 AND job.state = 'failed' AND run.status IN ('queued', 'running') LIMIT 50`,
      [GENERATION_QUEUE],
    );
    for (const { data } of result.rows) {
      if (
        data?.workspaceId !== "local-workspace" ||
        typeof data.runId !== "string"
      )
        continue;
      await this.change(data.workspaceId, data.runId, (run) => {
        return exhaustGeneration(run, {
          now: this.now().toISOString(),
          error: {
            code: "QUEUE_RETRIES_EXHAUSTED",
            message:
              "The worker job exhausted its bounded retries before a result was saved. Review this failed run before starting a new one.",
            retryable: false,
          },
        });
      });
    }
    const orphans = await this.pool.query<{ workspace_id: string; id: string }>(
      `SELECT run.workspace_id,run.id FROM ${this.schema}.runs AS run
       WHERE run.status IN ('queued','running') AND run.updated_at < now() - interval '10 minutes'
       AND NOT EXISTS (SELECT 1 FROM ${this.queueSchema}.job AS job WHERE job.name=$1
         AND job.data->>'workspaceId'=run.workspace_id AND job.data->>'runId'=run.id
         AND job.state IN ('created','retry','active')) LIMIT 50`,
      [GENERATION_QUEUE],
    );
    for (const row of orphans.rows) {
      if (row.workspace_id !== "local-workspace") continue;
      await this.change(row.workspace_id, row.id, async (run, client) => {
        if (!["queued", "running"].includes(run.status)) return undefined;
        // Recheck age and queue state after locking the run; a delayed sweep
        // must not fail newly active work observed by an earlier candidate read.
        const stale = await client.query(
          `SELECT 1 FROM ${this.schema}.runs AS run WHERE run.workspace_id=$1 AND run.id=$2
           AND run.updated_at < now() - interval '10 minutes'
           AND NOT EXISTS (SELECT 1 FROM ${this.queueSchema}.job AS job WHERE job.name=$3
             AND job.data->>'workspaceId'=run.workspace_id AND job.data->>'runId'=run.id
             AND job.state IN ('created','retry','active'))`,
          [row.workspace_id, row.id, GENERATION_QUEUE],
        );
        if (!stale.rowCount) return undefined;
        return exhaustGeneration(run, {
          now: this.now().toISOString(),
          error: {
            code: "QUEUE_JOB_UNAVAILABLE",
            message:
              "No live generation job remains for this interrupted run. Start a new mission after review; no automatic inference was started.",
            retryable: false,
          },
        });
      });
    }
    await this.knowledge.reconcileExhausted();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.boss.stop();
    } finally {
      await this.pool.end();
    }
  }

  private async change(
    workspaceId: string,
    id: string,
    update: (
      run: Run,
      client: PoolClient,
    ) => Run | undefined | Promise<Run | undefined>,
    signal?: AbortSignal,
  ): Promise<Run | undefined> {
    return transaction(
      this.pool,
      async (client) => {
        const result = await client.query<{ aggregate: unknown }>(
          `SELECT aggregate FROM ${this.schema}.runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        );
        signal?.throwIfAborted();
        if (!result.rows[0]) return undefined;
        const current = parseRunIntegrity(result.rows[0].aggregate, sha256);
        const next = await update(current, client);
        signal?.throwIfAborted();
        if (!next) return undefined;
        if (next === current) return current;
        parseRunIntegrity(next, sha256);
        const saved = await client.query(
          `UPDATE ${this.schema}.runs
        SET revision = $3, status = $4, aggregate = $5::jsonb, updated_at = $6
        WHERE workspace_id = $1 AND id = $2 AND revision = $7`,
          [
            workspaceId,
            id,
            next.revision,
            next.status,
            JSON.stringify(next),
            next.updatedAt,
            current.revision,
          ],
        );
        if (saved.rowCount !== 1)
          throw new Error(
            "The run changed before the transition could be saved.",
          );
        await this.appendEffects(client, current, next);
        return next;
      },
      signal,
    );
  }

  private async appendEffects(
    client: PoolClient,
    previous: Run | undefined,
    next: Run,
  ): Promise<void> {
    const previousEvents = previous?.events ?? [];
    if (
      JSON.stringify(next.events.slice(0, previousEvents.length)) !==
      JSON.stringify(previousEvents)
    ) {
      throw new Error("Existing run events cannot be rewritten.");
    }
    for (const event of next.events.slice(previousEvents.length)) {
      await client.query(
        `INSERT INTO ${this.schema}.run_events(workspace_id, run_id, sequence, event) VALUES ($1,$2,$3,$4::jsonb)`,
        [next.workspaceId, next.id, event.sequence, JSON.stringify(event)],
      );
    }
    if (next.artifact && !previous?.artifact) {
      await client.query(
        `INSERT INTO ${this.schema}.artifacts(workspace_id, run_id, id, content, saved_at) VALUES ($1,$2,$3,$4,$5)`,
        [
          next.workspaceId,
          next.id,
          next.artifact.id,
          next.artifact.content,
          next.artifact.savedAt,
        ],
      );
    }
  }
}
