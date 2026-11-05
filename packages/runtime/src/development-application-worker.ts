import { randomUUID } from "node:crypto";
import { DevelopmentApplicationError } from "@vuzmi/core";
import type { DevelopmentApplication } from "@vuzmi/core";
import { DEVELOPMENT_APPLICATION_QUEUE } from "./development-application.js";
import type { ApplicationJobData } from "./development-application.js";
import type { DevelopmentGitAdapter } from "./development-git.js";
import type { PostgresRunRepository } from "./repository.js";
interface Options {
  repository: PostgresRunRepository;
  connector: DevelopmentGitAdapter;
  onError?: (error: Error) => void;
}
export async function processDevelopmentApplicationJob(
  options: Options & {
    workerId: string;
    job: { data: ApplicationJobData; signal?: AbortSignal };
    signal?: AbortSignal;
  },
): Promise<void> {
  const { repository, connector, workerId, job } = options;
  if (
    job.data?.workspaceId !== "local-workspace" ||
    typeof job.data.applicationId !== "string"
  )
    throw new Error("Invalid application job reference.");
  const signal = AbortSignal.any(
    [job.signal, options.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );
  if (signal.aborted) return;
  let operation: DevelopmentApplication | undefined =
    await repository.applications.claim(
      job.data.workspaceId,
      job.data.applicationId,
      workerId,
      randomUUID(),
    );
  if (!operation) return;
  const context = () => ({
    workerId,
    attemptId: operation!.attemptId!,
    revision: operation!.revision,
  });
  try {
    const run = await repository.development.get(
      operation.workspaceId,
      operation.runId,
    );
    if (!run)
      throw new DevelopmentApplicationError(
        "DEVELOPMENT_NOT_FOUND",
        "The approved development package is unavailable.",
      );
    const prepared = await connector.prepare(operation, run, signal);
    signal.throwIfAborted();
    operation = await repository.applications.prepared(
      operation.workspaceId,
      operation.id,
      context(),
      prepared,
      signal,
    );
    if (!operation) return;
    signal.throwIfAborted();
    await connector.apply(operation, signal);
    signal.throwIfAborted();
    await repository.applications.applied(
      operation.workspaceId,
      operation.id,
      context(),
      signal,
    );
  } catch (error) {
    if (!operation) return;
    await repository.applications.fail(
      operation.workspaceId,
      operation.id,
      context(),
      error instanceof DevelopmentApplicationError
        ? { code: error.code, message: error.message.slice(0, 600) }
        : {
            code: "APPLICATION_UNCONFIRMED",
            message:
              "The local application did not confirm completion. Read-only reconciliation will inspect its exact reserved branch; no action is retried automatically.",
          },
    );
  }
}
export async function startDevelopmentApplicationWorker(
  options: Options,
): Promise<{ stop(): Promise<void> }> {
  const workerId = randomUUID(),
    controller = new AbortController(),
    operations = new Set<Promise<void>>();
  let stopping = false,
    ticking = false,
    tickPromise: Promise<void> | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(
        error instanceof Error
          ? error
          : new Error("Application worker operation failed."),
      );
    } catch {}
  };
  const tick = async () => {
    let readiness: Awaited<ReturnType<DevelopmentGitAdapter["readiness"]>>;
    try {
      readiness = await options.connector.readiness();
    } catch {
      readiness = {
        ready: false,
        reason:
          "Local Git connector inspection failed. Existing receipts remain readable.",
      };
    }
    await options.repository.applications.heartbeat(workerId, readiness);
    await options.repository.applications.reconcile(options.connector);
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
    await options.repository.boss.work<ApplicationJobData>(
      DEVELOPMENT_APPLICATION_QUEUE,
      { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          if (stopping) throw new Error("Application worker is stopping.");
          const operation = processDevelopmentApplicationJob({
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
    await options.repository.applications.removeHeartbeat(workerId);
    throw error;
  }
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      controller.abort();
      await options.repository.boss.offWork(DEVELOPMENT_APPLICATION_QUEUE, {
        wait: true,
      });
      await Promise.allSettled([...operations]);
      await tickPromise;
      await options.repository.applications.removeHeartbeat(workerId);
    },
  };
}
