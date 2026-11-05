import {
  evidenceSnapshotSchema,
  knowledgeSnapshotSchema,
  memorySchema,
  sourceDetailSchema,
  sourceSchema,
  githubPreviewSchema,
  type GithubPreview,
  type GithubPreviewInput,
  type GithubImportInput,
  type EvidenceSnapshot,
  type KnowledgeSnapshot,
  type Memory,
  type MemoryInput,
  type MemoryUpdate,
  type SearchKnowledgeInput,
  type Source,
  type SourceDetail,
  type SourceInput,
  type SourceUpdate,
} from "@vuzmi/core";
import { ApiError, request } from "./api";

export async function getKnowledge(): Promise<KnowledgeSnapshot> {
  return knowledgeSnapshotSchema.parse(await request("/knowledge"));
}
export async function getSource(id: string): Promise<SourceDetail> {
  return sourceDetailSchema.parse(
    await request(`/knowledge/sources/${encodeURIComponent(id)}`),
  );
}
export async function saveSource(
  input: SourceInput | SourceUpdate,
  id?: string,
): Promise<Source> {
  const body = (await request(
    `/knowledge/sources${id ? `/${encodeURIComponent(id)}` : ""}`,
    { method: id ? "PATCH" : "POST", body: JSON.stringify(input) },
  )) as { source: unknown };
  return sourceSchema.parse(body.source);
}
export async function deleteSource(id: string): Promise<void> {
  await request(`/knowledge/sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
export async function saveMemory(
  input: MemoryInput | MemoryUpdate,
  id?: string,
): Promise<Memory> {
  const body = (await request(
    `/knowledge/memories${id ? `/${encodeURIComponent(id)}` : ""}`,
    { method: id ? "PATCH" : "POST", body: JSON.stringify(input) },
  )) as { memory: unknown };
  return memorySchema.parse(body.memory);
}
export async function deleteMemory(id: string): Promise<void> {
  await request(`/knowledge/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
export async function searchKnowledge(
  input: SearchKnowledgeInput,
): Promise<EvidenceSnapshot> {
  const body = (await request("/knowledge/search", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { result: unknown };
  return evidenceSnapshotSchema.parse(body.result);
}

export async function previewGithubFile(
  input: GithubPreviewInput,
  signal?: AbortSignal,
): Promise<GithubPreview> {
  return githubPreviewSchema.parse(
    await request("/knowledge/github/preview", {
      method: "POST",
      body: JSON.stringify(input),
      signal,
    }),
  );
}

export async function importGithubFile(
  input: GithubImportInput,
  signal?: AbortSignal,
): Promise<{ source: Source; replayed: boolean }> {
  const body = (await request("/knowledge/github/import", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  })) as { source?: unknown; replayed?: unknown };
  const source = sourceSchema.safeParse(body?.source);
  if (!source.success || typeof body.replayed !== "boolean") {
    throw new ApiError(
      "The import response could not be verified. Retry save unchanged to check the same import receipt.",
      "INVALID_RESPONSE",
      0,
    );
  }
  return { source: source.data, replayed: body.replayed };
}
