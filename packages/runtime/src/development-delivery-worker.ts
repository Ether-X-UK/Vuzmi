import { randomUUID } from "node:crypto";
import { DevelopmentDeliveryError } from "@vuzmi/core";
import type { DevelopmentDelivery } from "@vuzmi/core";
import { DEVELOPMENT_DELIVERY_QUEUE } from "./development-delivery.js";
import type { DeliveryJobData } from "./development-delivery.js";
import type { DevelopmentGitHubAdapter } from "./development-delivery.js";
import type { PostgresRunRepository } from "./repository.js";
interface Options {
  repository: PostgresRunRepository;
  connector: DevelopmentGitHubAdapter;
  onError?: (error: Error) => void;
}
export async function processDevelopmentDeliveryJob(
  options: Options & {
    workerId: string;
    job: { data: DeliveryJobData; signal?: AbortSignal };
    signal?: AbortSignal;
  },
): Promise<void> {
  const { repository, connector, workerId, job } = options;
  if (
    job.data?.workspaceId !== "local-workspace" ||
    typeof job.data.deliveryId !== "string"
  )
    throw new Error("Invalid delivery job reference.");
  const signal = AbortSignal.any(
    [job.signal, options.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );
  if (signal.aborted) return;
  let operation: DevelopmentDelivery | undefined =
    await repository.deliveries.claim(
      job.data.workspaceId,
      job.data.deliveryId,
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
      throw new DevelopmentDeliveryError(
        "DEVELOPMENT_NOT_FOUND",
        "The approved development package is unavailable.",
      );
    const application = await repository.applications.get(
      operation.workspaceId,
      operation.runId,
    );
    if (!application)
      throw new DevelopmentDeliveryError(
        "DELIVERY_NOT_APPLIED",
        "The verified local application receipt is unavailable.",
      );
    const receipt = await connector.publish(
      operation,
      run,
      application,
      async (phase) => {
        signal.throwIfAborted();
        const readiness = await connector.readiness(signal);
        if (
          !readiness.ready ||
          readiness.authorityIdentity !== operation!.plan.authorityIdentity ||
          readiness.target?.repositoryId !== operation!.plan.repositoryId
        )
          throw new DevelopmentDeliveryError(
            "DELIVERY_AUTHORITY_CHANGED",
            "The configured GitHub authority changed or is unavailable; no further writes are authorized.",
          );
        await repository.deliveries.heartbeat(workerId, readiness);
        operation = await repository.deliveries.checkpoint(
          operation!.workspaceId,
          operation!.id,
          context(),
          phase,
          signal,
        );
        if (!operation)
          throw new DevelopmentDeliveryError(
            "DELIVERY_LEASE_LOST",
            "The durable publication lease is unavailable; no further writes are permitted.",
          );
        signal.throwIfAborted();
      },
      signal,
    );
    signal.throwIfAborted();
    await repository.deliveries.published(
      operation!.workspaceId,
      operation!.id,
      context(),
      receipt,
      signal,
    );
  } catch (error) {
    if (!operation) return;
    await repository.deliveries.fail(
      operation.workspaceId,
      operation.id,
      context(),
      error instanceof DevelopmentDeliveryError
        ? { code: error.code, message: error.message.slice(0, 600) }
        : {
            code: "DELIVERY_UNCONFIRMED",
            message:
              "GitHub publication did not confirm completion. Read-only reconciliation may inspect the reserved branch and exact draft PR; no remote write is retried automatically.",
          },
    );
  }
}
export async function startDevelopmentDeliveryWorker(
  options: Options,
): Promise<{ stop(): Promise<void> }> {
  const workerId = randomUUID(),
    controller = new AbortController(),
    operations = new Set<Promise<void>>();
  let effectConsumerEnabled = false;
  let initialInspection = true;
  let stopping = false,
    ticking = false,
    tickPromise: Promise<void> | undefined;
  const report = (error: unknown) => {
    try {
      options.onError?.(
        error instanceof Error
          ? error
          : new Error("Delivery worker operation failed."),
      );
    } catch {}
  };
  const tick = async () => {
    let readiness: Awaited<ReturnType<DevelopmentGitHubAdapter["readiness"]>>;
    try {
      readiness =
        initialInspection || effectConsumerEnabled
          ? await options.connector.readiness()
          : {
              ready: false,
              reason:
                "GitHub publication was disconnected at worker startup. Connect the explicit private credential file and restart the trusted publication worker before authorizing delivery.",
            };
    } catch {
      readiness = {
        ready: false,
        reason:
          "GitHub connector inspection failed. Existing receipts remain readable.",
      };
    }
    if (initialInspection) {
      effectConsumerEnabled = readiness.ready;
      initialInspection = false;
    }
    await options.repository.deliveries.heartbeat(workerId, readiness);
    if (effectConsumerEnabled)
      await options.repository.deliveries.reconcile(options.connector);
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
    if (effectConsumerEnabled)
      await options.repository.boss.work<DeliveryJobData>(
        DEVELOPMENT_DELIVERY_QUEUE,
        { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: 1 },
        async (jobs) => {
          for (const job of jobs) {
            if (stopping) throw new Error("Delivery worker is stopping.");
            const operation = processDevelopmentDeliveryJob({
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
    await options.repository.deliveries.removeHeartbeat(workerId);
    throw error;
  }
  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      controller.abort();
      if (effectConsumerEnabled)
        await options.repository.boss.offWork(DEVELOPMENT_DELIVERY_QUEUE, {
          wait: true,
        });
      await Promise.allSettled([...operations]);
      await tickPromise;
      await options.repository.deliveries.removeHeartbeat(workerId);
    },
  };
}
