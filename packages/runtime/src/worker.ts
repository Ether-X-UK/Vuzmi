import { randomUUID } from "node:crypto";
import type { Domain, Usage, Run, EvidenceSnapshot } from "@vuzmi/core";
import { INDEX_QUEUE, KnowledgeError } from "./knowledge.js";
import type { IndexJobData, KnowledgeEmbedder } from "./knowledge.js";
import { processIndexJob } from "./index-worker.js";
import { GENERATION_QUEUE, GENERATION_RETRY_LIMIT } from "./repository.js";
import type { GenerationJobData, PostgresRunRepository } from "./repository.js";

export type ReleaseGenerator = (input: {
  model: string;
  title: string;
  brief: string;
  domain: Domain;
  signal?: AbortSignal;
  evidence?: EvidenceSnapshot;
}) => Promise<{ content: string; usage: Usage }>;

export interface WorkerOptions {
  repository: PostgresRunRepository;
  generate: ReleaseGenerator;
  embed?: KnowledgeEmbedder;
  onError?: (error: Error) => void;
}

export interface GenerationJob {
  data: GenerationJobData;
  retryCount: number;
  /** pg-boss aborts this when the job times out or loses its queue claim. */
  signal?: AbortSignal;
}

function failure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return {
      code: error.code,
      message: error.message.slice(0, 500),
      retryable: error.retryable,
    };
  }
  return {
    code: "GENERATION_FAILED",
    message:
      "Local generation could not produce a saved draft. Review the local provider and start a new run when it is available.",
    retryable: false,
  };
}

export async function processRunJob(
  options: WorkerOptions & { job: GenerationJob; signal?: AbortSignal },
): Promise<void> {
  const { repository, generate, job } = options;
  const signals = [job.signal, options.signal].filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const data = job.data;
  if (
    data?.workspaceId !== "local-workspace" ||
    typeof data.runId !== "string" ||
    typeof data.model !== "string" ||
    !data.model
  ) {
    throw new Error("Invalid local generation job payload.");
  }
  if (signal?.aborted) return;
  const claimed = await repository.claim(data.workspaceId, data.runId, {
    attemptId: randomUUID(),
    allowRecovery: job.retryCount > 0,
    model: data.model,
  });
  if (!claimed) return;
  let run: Run = claimed;
  const cancellation = (): {
    code: string;
    message: string;
    retryable: boolean;
  } =>
    job.signal?.aborted
      ? {
          code: "QUEUE_LEASE_LOST",
          message:
            "The local generation job lost its queue claim. Its output was discarded; only a bounded fresh attempt may produce a draft.",
          retryable: true,
        }
      : {
          code: "WORKER_STOPPING",
          message:
            "The local worker stopped before saving a draft. A bounded local retry is required.",
          retryable: true,
        };
  let abortedAttempt:
    | Promise<Awaited<ReturnType<PostgresRunRepository["fail"]>>>
    | undefined;
  let abortedRevision: number | undefined;
  const fenceAbortedAttempt = (): Promise<
    Awaited<ReturnType<PostgresRunRepository["fail"]>>
  > => {
    if (!abortedAttempt || abortedRevision !== run.revision) {
      abortedRevision = run.revision;
      abortedAttempt = repository.fail(data.workspaceId, data.runId, {
        attemptId: run.attemptId!,
        expectedRevision: run.revision,
        error: cancellation(),
        willRetry: job.retryCount < GENERATION_RETRY_LIMIT,
      });
    }
    return abortedAttempt;
  };
  const onAbort = (): void => {
    // Fence immediately even if a broken generator ignores AbortSignal and keeps running.
    void fenceAbortedAttempt().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    if (run.knowledge) {
      if (!options.embed)
        throw new KnowledgeError(
          "EMBEDDING_NOT_CONFIGURED",
          "Required knowledge cannot be retrieved without the local embedding adapter.",
          503,
        );
      const prepared = await repository.prepareEvidence(
        data.workspaceId,
        data.runId,
        { attemptId: run.attemptId!, expectedRevision: run.revision },
        options.embed,
        signal,
      );
      if (!prepared) return;
      run = prepared;
      signal?.throwIfAborted();
      if (run.evidence?.status !== "matched")
        throw new KnowledgeError(
          "INSUFFICIENT_EVIDENCE",
          "No relevant passages were found in the selected evidence. Generation was blocked.",
        );
    }
    const result = await generate({
      model: data.model,
      title: run.title,
      brief: run.brief,
      domain: run.domain,
      signal,
      evidence: run.evidence,
    });
    signal?.throwIfAborted();
    await repository.complete(data.workspaceId, data.runId, {
      attemptId: run.attemptId!,
      expectedRevision: run.revision,
      content: result.content,
      usage: result.usage,
      signal,
    });
  } catch (error) {
    const detail = signal?.aborted ? cancellation() : failure(error);
    const willRetry =
      detail.retryable && job.retryCount < GENERATION_RETRY_LIMIT;
    const failed = signal?.aborted
      ? await fenceAbortedAttempt()
      : await repository.fail(data.workspaceId, data.runId, {
          attemptId: run.attemptId!,
          expectedRevision: run.revision,
          error: detail,
          willRetry,
        });
    options.onError?.(
      error instanceof Error ? error : new Error("Local generation failed."),
    );
    if (failed && willRetry) throw new Error(detail.code);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function startWorker(
  options: WorkerOptions,
): Promise<{ stop(): Promise<void> }> {
  const { repository } = options;
  const heartbeatId = randomUUID();
  const controllers = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  let ticking = false;
  let tickPromise: Promise<void> | undefined;
  const report = (error: unknown): void => {
    try {
      options.onError?.(
        error instanceof Error
          ? error
          : new Error("Local worker operation failed."),
      );
    } catch {
      /* Error reporting must not break recovery. */
    }
  };
  await repository.reconcileExhausted();
  await repository.heartbeat(heartbeatId);
  const timer = setInterval(() => {
    if (ticking || stopping) return;
    ticking = true;
    tickPromise = (async () => {
      await repository.heartbeat(heartbeatId);
      await repository.reconcileExhausted();
    })()
      .catch(report)
      .finally(() => {
        ticking = false;
      });
  }, 5_000);
  timer.unref();
  try {
    if (options.embed)
      await repository.boss.work<IndexJobData>(
        INDEX_QUEUE,
        { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 1 },
        async (jobs) => {
          for (const job of jobs) {
            if (stopping) throw new Error("Worker is shutting down.");
            const controller = new AbortController();
            controllers.add(controller);
            const operation = processIndexJob({
              repository,
              embed: options.embed!,
              job,
              signal: controller.signal,
            });
            inFlight.add(operation);
            try {
              await operation;
            } finally {
              controllers.delete(controller);
              inFlight.delete(operation);
            }
          }
        },
      );
    await repository.boss.work<GenerationJobData>(
      GENERATION_QUEUE,
      { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          if (stopping) throw new Error("Worker is shutting down.");
          const controller = new AbortController();
          controllers.add(controller);
          const operation = processRunJob({
            ...options,
            job,
            signal: controller.signal,
          });
          inFlight.add(operation);
          try {
            await operation;
          } finally {
            controllers.delete(controller);
            inFlight.delete(operation);
          }
        }
      },
    );
  } catch (error) {
    clearInterval(timer);
    await repository.removeHeartbeat(heartbeatId);
    throw error;
  }
  return {
    async stop(): Promise<void> {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      controllers.forEach((controller) => controller.abort());
      await repository.boss.offWork(GENERATION_QUEUE, { wait: true });
      if (options.embed)
        await repository.boss.offWork(INDEX_QUEUE, { wait: true });
      await Promise.allSettled([...inFlight]);
      await tickPromise;
      await repository.removeHeartbeat(heartbeatId);
    },
  };
}
