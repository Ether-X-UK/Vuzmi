import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
export const embeddingProfileSchema = z.object({
  provider: z.literal("ollama"),
  model: z.string().min(1).max(200),
  digest: z.string().min(1).max(128),
  dimensions: z.number().int().min(1).max(4096),
  normalization: z.literal("l2"),
  version: z.literal(1),
  promptVersion: z.literal("embeddinggemma-retrieval-v1"),
});
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>;

export const sourceInputSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    format: z.enum(["text", "markdown"]),
    text: z.string().trim().min(10).max(64_000),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(value.text).byteLength <= 65_536,
    "Source text must fit within 64 KiB.",
  );
export type SourceInput = z.infer<typeof sourceInputSchema>;
export const sourceUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    format: z.enum(["text", "markdown"]),
    text: z.string().trim().min(10).max(64_000),
    revision: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(value.text).byteLength <= 65_536,
    "Source text must fit within 64 KiB.",
  );
export type SourceUpdate = z.infer<typeof sourceUpdateSchema>;
export const sourceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.literal("local-workspace"),
  title: z.string(),
  format: z.enum(["text", "markdown"]),
  revision: z.number().int().positive(),
  activeRevision: z.number().int().positive().nullable(),
  status: z.enum(["queued", "indexing", "ready", "failed"]),
  contentHash: hash,
  chunkCount: z.number().int().nonnegative(),
  profile: embeddingProfileSchema.nullable(),
  parserVersion: z.literal("plain-text-v1").optional(),
  chunkerVersion: z.literal("utf8-lines-v1").optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type Source = z.infer<typeof sourceSchema>;
export const sourceDetailSchema = z.object({
  source: sourceSchema,
  text: z.string(),
});
export type SourceDetail = z.infer<typeof sourceDetailSchema>;

export const memoryProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }).strict(),
  z
    .object({
      kind: z.literal("source"),
      sourceId: z.string().uuid(),
      sourceRevision: z.number().int().positive(),
    })
    .strict(),
]);
export const memoryInputSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    content: z.string().trim().min(3).max(2000),
    provenance: memoryProvenanceSchema.default({ kind: "operator" }),
    expiresAt: timestamp.nullable().default(null),
  })
  .strict();
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export const memoryUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    content: z.string().trim().min(3).max(2000),
    provenance: memoryProvenanceSchema,
    expiresAt: timestamp.nullable(),
    revision: z.number().int().positive(),
  })
  .strict();
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;
export const memorySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.literal("local-workspace"),
  scope: z.literal("workspace"),
  title: z.string(),
  content: z.string(),
  revision: z.number().int().positive(),
  provenance: memoryProvenanceSchema,
  trust: z.literal("confirmed"),
  expiresAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Memory = z.infer<typeof memorySchema>;

export const evidenceSelectionSchema = z
  .object({
    sourceIds: z.array(z.string().uuid()).max(10).default([]),
    memoryIds: z.array(z.string().uuid()).max(10).default([]),
  })
  .strict()
  .refine(
    (value) => value.sourceIds.length + value.memoryIds.length > 0,
    "Select at least one source or memory.",
  )
  .refine(
    (value) =>
      new Set(value.sourceIds).size === value.sourceIds.length &&
      new Set(value.memoryIds).size === value.memoryIds.length,
    "Duplicate evidence selections are not permitted.",
  );
export type EvidenceSelection = z.infer<typeof evidenceSelectionSchema>;
export const evidenceItemSchema = z.object({
  citation: z.string().regex(/^[SM][1-9][0-9]*$/),
  kind: z.enum(["source", "memory"]),
  ownerId: z.string().uuid(),
  title: z.string(),
  revision: z.number().int().positive(),
  chunkIndex: z.number().int().nonnegative().nullable(),
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  text: z.string().min(1).max(2400),
  contentHash: hash,
  score: z.number().finite().nullable(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export const evidenceSnapshotSchema = z.object({
  status: z.enum(["matched", "insufficient"]),
  query: z.string(),
  policy: z.literal("hybrid-v1"),
  items: z.array(evidenceItemSchema).max(6),
  profile: embeddingProfileSchema.nullable(),
  retrievedAt: timestamp,
  messages: z.array(z.string()),
});
export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;
export const searchKnowledgeSchema = z
  .object({
    query: z.string().trim().min(3).max(1000),
    selection: evidenceSelectionSchema,
  })
  .strict();
export type SearchKnowledgeInput = z.infer<typeof searchKnowledgeSchema>;
export const knowledgeSnapshotSchema = z.object({
  sources: z.array(sourceSchema),
  memories: z.array(memorySchema),
  embedding: z.object({
    model: z.string(),
    available: z.boolean(),
    profile: embeddingProfileSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export type KnowledgeSnapshot = z.infer<typeof knowledgeSnapshotSchema>;
