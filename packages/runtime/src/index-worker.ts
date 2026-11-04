import { randomUUID } from "node:crypto";
import type { EmbeddingProfile } from "@vuzmi/core";
import { INDEX_QUEUE, KnowledgeError } from "./knowledge.js";
import type { IndexJobData, KnowledgeEmbedder } from "./knowledge.js";
import type { PostgresRunRepository } from "./repository.js";

export interface IndexWorkerJob {
  data: IndexJobData;
  retryCount: number;
  signal?: AbortSignal;
}
export async function processIndexJob(options: {
  repository: PostgresRunRepository;
  embed: KnowledgeEmbedder;
  job: IndexWorkerJob;
  signal?: AbortSignal;
}): Promise<void> {
  const { repository, embed, job } = options;
  const signals = [job.signal, options.signal].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  if (signal?.aborted) return;
  if (
    job.data?.workspaceId !== "local-workspace" ||
    typeof job.data.sourceId !== "string" ||
    !Number.isSafeInteger(job.data.revision) ||
    job.data.revision < 1
  )
    throw new KnowledgeError(
      "INVALID_JOB",
      "The indexing job reference is invalid.",
      400,
    );
  const claim = await repository.knowledge.claimIndex(
    job.data,
    randomUUID(),
    job.retryCount > 0,
  );
  if (!claim) return;
  let cancellation: Promise<void> | undefined;
  const cancel = () =>
    (cancellation ??= repository.knowledge.failIndex(
      claim,
      {
        code: "INDEX_LEASE_LOST",
        message:
          "Indexing was interrupted before activation. Partial vectors were discarded.",
      },
      job.retryCount < 2,
    ));
  const onAbort = () => {
    void cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    let profile: EmbeddingProfile | undefined;
    const vectors: number[][] = [];
    for (let offset = 0; offset < claim.chunks.length; ) {
      const batch: typeof claim.chunks = [];
      let bytes = 0;
      while (offset < claim.chunks.length && batch.length < 8) {
        const chunk = claim.chunks[offset]!;
        // Match the pinned embeddinggemma document prompt, including its title.
        const inputBytes = Buffer.byteLength(
          `title: ${claim.source.title.trim() || "none"} | text: ${chunk.text}`,
          "utf8",
        );
        if (inputBytes > 8192)
          throw new KnowledgeError(
            "EMBEDDING_INVALID",
            "A source chunk exceeds the local embedding input budget.",
            400,
          );
        if (bytes + inputBytes > 32768) break;
        batch.push(chunk);
        bytes += inputBytes;
        offset += 1;
      }
      const result = await embed({
        texts: batch.map((chunk) => chunk.text),
        kind: "document",
        title: claim.source.title,
        signal,
      });
      signal?.throwIfAborted();
      if (result.vectors.length !== batch.length)
        throw new KnowledgeError(
          "EMBEDDING_INVALID",
          "The local embedding response omitted a source chunk.",
          502,
        );
      if (profile && JSON.stringify(result.profile) !== JSON.stringify(profile))
        throw new KnowledgeError(
          "EMBEDDING_PROFILE_CHANGED",
          "The embedding profile changed while indexing. No revision was activated.",
        );
      profile = result.profile;
      vectors.push(...result.vectors);
    }
    if (!profile)
      throw new KnowledgeError(
        "EMPTY_SOURCE",
        "The source has no indexable text.",
        400,
      );
    signal?.throwIfAborted();
    await repository.knowledge.completeIndex(claim, profile, vectors, signal);
  } catch (error) {
    const detail = signal?.aborted
      ? {
          code: "INDEX_LEASE_LOST",
          message:
            "Indexing lost its lease or was stopped. No partial revision was activated.",
          retryable: true,
        }
      : error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
        ? {
            code: error.code,
            message: error.message.slice(0, 500),
            retryable: "retryable" in error && error.retryable === true,
          }
        : {
            code: "INDEX_FAILED",
            message:
              "Local indexing failed. Review the embedding service before updating the source to retry.",
            retryable: false,
          };
    const willRetry = detail.retryable && job.retryCount < 2;
    if (signal?.aborted) await cancel();
    else await repository.knowledge.failIndex(claim, detail, willRetry);
    if (willRetry) throw new Error(detail.code);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
export { INDEX_QUEUE };
