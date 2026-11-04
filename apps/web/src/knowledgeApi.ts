import {
  evidenceSnapshotSchema,
  knowledgeSnapshotSchema,
  memorySchema,
  sourceDetailSchema,
  sourceSchema,
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
import { request } from "./api";

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
