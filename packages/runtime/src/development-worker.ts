import { randomUUID } from "node:crypto";
import {
  DevelopmentError,
  developmentRunSchema,
  validateDevelopmentCandidate,
} from "@vuzmi/core";
import type {
  DevelopmentCheck,
  DevelopmentCandidate,
  DevelopmentProfile,
  DevelopmentIssue,
  DevelopmentPatchInput,
  DevelopmentRun,
  Usage,
} from "@vuzmi/core";
import { DEVELOPMENT_QUEUE } from "./development.js";
import type { DevelopmentJobData } from "./development.js";
import { sha256 } from "./repository.js";
import type { PostgresRunRepository } from "./repository.js";

export interface DevelopmentRunnerAdapter {
  readiness(): Promise<{
    ready: boolean;
    reason: string;
    profile?: DevelopmentProfile;
  }>;
  run(input: {
    runId: string;
    attemptId: string;
    phase: "baseline" | "candidate";
    executionId: string;
    candidate?: DevelopmentCandidate;
    signal?: AbortSignal;
  }): Promise<DevelopmentCheck>;
  cleanup(executionId: string): Promise<boolean>;
}
export type DevelopmentGenerator = (input: {
  model: string;
  title: string;
  brief: string;
  profile: DevelopmentProfile;
  issue?: DevelopmentIssue;
  signal?: AbortSignal;
}) => Promise<{
  patch: DevelopmentPatchInput;
  usage: Usage;
  modelDigest: string;
}>;
interface Options {
  repository: PostgresRunRepository;
  runner: DevelopmentRunnerAdapter;
  generate: DevelopmentGenerator;
  onError?: (error: Error) => void;
}
type Job = { data: DevelopmentJobData; signal?: AbortSignal };
function detail(error: unknown): { code: string; message: string } {
  if (error instanceof DevelopmentError)
    return { code: error.code, message: error.message.slice(0, 600) };
  if (
    error instanceof Error &&
    error.name === "ProviderError" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return { code: error.code, message: error.message.slice(0, 600) };
  return {
    code: "DEVELOPMENT_FAILED",
    message:
      "The bounded development workflow could not complete. Inspect its recorded context and runner readiness before starting a new task.",
  };
}
async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let listener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () =>
      reject(
        new DevelopmentError(
          "DEVELOPMENT_CANCELLED",
          "Worker shutdown or queue lease loss discarded this attempt's output.",
        ),
      );
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export async function processDevelopmentJob(
  options: Options & { workerId: string; job: Job; signal?: AbortSignal },
): Promise<void> {
  const { repository, runner, generate, job, workerId } = options;
  if (
    job.data?.workspaceId !== "local-workspace" ||
    typeof job.data.runId !== "string"
  )
    throw new Error("Invalid development job reference.");
  const controller = new AbortController();
  const signals = [controller.signal, job.signal, options.signal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  const signal = AbortSignal.any(signals);
  if (signal.aborted) return;
  let run: DevelopmentRun | undefined;
  try {
    run = await repository.development.claim(
      job.data.workspaceId,
      job.data.runId,
      workerId,
      randomUUID(),
    );
  } catch (error) {
    await repository.development.failQueued(
      job.data.workspaceId,
      job.data.runId,
      detail(error),
    );
    return;
  }
  if (!run) return;
  const attemptId = run.attemptId!;
  let observed: { modelDigest: string; usage: Usage } | undefined;
  const context = () => ({ workerId, attemptId, revision: run!.revision });
  const fence = () =>
    repository.development.fail(
      job.data.workspaceId,
      job.data.runId,
      context(),
      {
        code: "DEVELOPMENT_CANCELLED",
        message:
          "Worker shutdown or queue lease loss discarded this attempt's output. No automatic retry was started.",
      },
      observed,
    );
  const onAbort = () => {
    void fence().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    run = await repository.development.reserveExecution(
      run.workspaceId,
      run.id,
      context(),
      "baseline",
      `vuzmi-dev-${run.id}-${attemptId}-baseline`,
      signal,
    );
    if (!run) return;
    const baseline = await abortable(
      runner.run({
        runId: run.id,
        attemptId,
        phase: "baseline",
        executionId: run.execution!.id,
        signal,
      }),
      signal,
    );
    signal.throwIfAborted();
    run = await repository.development.baseline(
      run.workspaceId,
      run.id,
      context(),
      baseline,
      signal,
    );
    if (!run || run.status !== "running") return;
    const generated = await abortable(
      generate({
        model: run.model,
        title: run.title,
        brief: run.brief,
        profile: run.profile,
        ...(run.issue ? { issue: run.issue } : {}),
        signal,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!generated.modelDigest.trim() || generated.modelDigest.length > 128)
      throw new DevelopmentError(
        "INVALID_MODEL_IDENTITY",
        "The local model identity could not be recorded.",
      );
    const usage = developmentRunSchema.shape.usage.safeParse(generated.usage);
    if (!usage.success || usage.data === null)
      throw new DevelopmentError(
        "INVALID_MODEL_USAGE",
        "The observed local model usage could not be verified.",
      );
    observed = { modelDigest: generated.modelDigest, usage: usage.data };
    const candidate = validateDevelopmentCandidate(
      generated.patch,
      run.profile,
      sha256,
    );
    run = await repository.development.candidate(
      run.workspaceId,
      run.id,
      context(),
      { candidate, usage: generated.usage, modelDigest: generated.modelDigest },
      signal,
    );
    if (!run) return;
    run = await repository.development.reserveExecution(
      run.workspaceId,
      run.id,
      context(),
      "candidate",
      `vuzmi-dev-${run.id}-${attemptId}-candidate`,
      signal,
    );
    if (!run) return;
    const receipt = await abortable(
      runner.run({
        runId: run.id,
        attemptId,
        phase: "candidate",
        executionId: run.execution!.id,
        candidate: run.candidate!,
        signal,
      }),
      signal,
    );
    signal.throwIfAborted();
    run = await repository.development.checks(
      run.workspaceId,
      run.id,
      context(),
      receipt,
      signal,
    );
  } catch (error) {
    const current = await repository.development.get(
      job.data.workspaceId,
      job.data.runId,
    );
    if (
      current?.attemptId === attemptId &&
      current.workerId === workerId &&
      current.status === "running"
    ) {
      run = current;
      await repository.development.fail(
        current.workspaceId,
        current.id,
        context(),
        signal.aborted
          ? {
              code: "DEVELOPMENT_CANCELLED",
              message:
                "Worker shutdown or queue lease loss discarded this attempt's output. No automatic retry was started.",
            }
          : detail(error),
        observed,
      );
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await repository.development.cleanupAttempt(
      job.data.workspaceId,
      job.data.runId,
      attemptId,
      workerId,
      (id) => runner.cleanup(id),
    );
  }
}

export async function startDevelopmentWorker(
  options: Options,
): Promise<{ stop(): Promise<void> }> {
  const workerId = randomUUID(),
    controller = new AbortController();
  const operations = new Set<Promise<void>>();
  let stopping = false,
    ticking = false,
    tickPromise: Promise<void> | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(
        error instanceof Error
          ? error
          : new Error("Development worker operation failed."),
      );
    } catch {}
  };
  const tick = async () => {
    let readiness: Awaited<ReturnType<DevelopmentRunnerAdapter["readiness"]>>;
    try {
      readiness = await options.runner.readiness();
    } catch {
      readiness = {
        ready: false,
        reason:
          "The isolated development runner could not be inspected. No host execution fallback is available.",
      };
    }
    await options.repository.development.heartbeat(workerId, readiness);
    await options.repository.development.reconcile(workerId, (id) =>
      options.runner.cleanup(id),
    );
  };
  await tick();
  const timer = setInterval(() => {
    if (stopping || ticking) return;
    ticking = true;
    tickPromise = tick()
      .catch(report)
      .finally(() => {
        ticking = false;
      });
  }, 5000);
  timer.unref();
  try {
    await options.repository.boss.work<DevelopmentJobData>(
      DEVELOPMENT_QUEUE,
      { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          if (stopping) throw new Error("Development worker is shutting down.");
          const operation = processDevelopmentJob({
            ...options,
            workerId,
            job,
            signal: controller.signal,
          });
          operations.add(operation);
          try {
            await operation;
          } finally {
            operations.delete(operation);
          }
        }
      },
    );
  } catch (error) {
    clearInterval(timer);
    await options.repository.development.removeHeartbeat(workerId);
    throw error;
  }
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      controller.abort();
      await options.repository.boss.offWork(DEVELOPMENT_QUEUE, { wait: true });
      await Promise.allSettled([...operations]);
      await tickPromise;
      await options.repository.development.removeHeartbeat(workerId);
    },
  };
}
