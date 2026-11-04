import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import {
  embeddingProfileSchema,
  evidenceSelectionSchema,
  evidenceSnapshotSchema,
  memoryInputSchema,
  memorySchema,
  memoryUpdateSchema,
  sourceInputSchema,
  sourceSchema,
  sourceUpdateSchema,
} from "@vuzmi/core";
import type {
  EmbeddingProfile,
  EvidenceItem,
  EvidenceSelection,
  EvidenceSnapshot,
  Memory,
  MemoryInput,
  MemoryUpdate,
  Source,
  SourceDetail,
  SourceInput,
  SourceUpdate,
} from "@vuzmi/core";

export const INDEX_QUEUE = "vuzmi-index-source";
const workspace = "local-workspace";
const CHUNK_BYTES = 1000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Transaction = <T>(
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
export type KnowledgeEmbedder = (input: {
  texts: string[];
  kind: "document" | "query";
  title?: string;
  signal?: AbortSignal;
}) => Promise<{ profile: EmbeddingProfile; vectors: number[][] }>;
export interface IndexJobData {
  workspaceId: string;
  sourceId: string;
  revision: number;
}
export interface PinnedSelection {
  sources: Array<{ id: string; revision: number; activeRevision: number }>;
  memories: Array<{ id: string; revision: number }>;
}
interface Chunk {
  index: number;
  text: string;
  lineStart: number;
  lineEnd: number;
  contentHash: string;
}
export interface IndexClaim {
  source: Source;
  text: string;
  attemptId: string;
  chunks: Chunk[];
}

export class KnowledgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function knowledgeMigration(schema: string): string {
  return `
    CREATE TABLE ${schema}.knowledge_profiles (workspace_id text PRIMARY KEY, profile jsonb NOT NULL, profile_hash text NOT NULL);
    CREATE TABLE ${schema}.knowledge_sources (
      workspace_id text NOT NULL, id uuid NOT NULL, revision integer NOT NULL,
      active_revision integer, metadata jsonb NOT NULL, deleted_at timestamptz,
      PRIMARY KEY(workspace_id,id)
    );
    CREATE TABLE ${schema}.source_revisions (
      workspace_id text NOT NULL, source_id uuid NOT NULL, revision integer NOT NULL,
      title text NOT NULL, body text NOT NULL, state text NOT NULL,
      attempt_id text, PRIMARY KEY(workspace_id,source_id,revision),
      FOREIGN KEY(workspace_id,source_id) REFERENCES ${schema}.knowledge_sources(workspace_id,id)
    );
    CREATE TABLE ${schema}.source_chunks (
      workspace_id text NOT NULL, source_id uuid NOT NULL, revision integer NOT NULL,
      chunk_index integer NOT NULL, body text NOT NULL, content_hash text NOT NULL,
      line_start integer NOT NULL, line_end integer NOT NULL, profile_hash text NOT NULL,
      embedding public.vector NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, body)) STORED,
      PRIMARY KEY(workspace_id,source_id,revision,chunk_index),
      FOREIGN KEY(workspace_id,source_id,revision) REFERENCES ${schema}.source_revisions(workspace_id,source_id,revision) ON DELETE CASCADE
    );
    CREATE INDEX knowledge_chunks_scope ON ${schema}.source_chunks(workspace_id,source_id,revision);
    CREATE TABLE ${schema}.knowledge_memories (
      workspace_id text NOT NULL, id uuid NOT NULL, revision integer NOT NULL,
      aggregate jsonb NOT NULL, source_id uuid,
      PRIMARY KEY(workspace_id,id),
      FOREIGN KEY(workspace_id,source_id) REFERENCES ${schema}.knowledge_sources(workspace_id,id)
    );
    CREATE TABLE ${schema}.run_knowledge (
      workspace_id text NOT NULL, run_id text NOT NULL, pins jsonb NOT NULL,
      PRIMARY KEY(workspace_id,run_id),
      FOREIGN KEY(workspace_id,run_id) REFERENCES ${schema}.runs(workspace_id,id)
    );
  `;
}

function parse<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new KnowledgeError(
      "INVALID_INPUT",
      "The knowledge request does not match the supported content and revision limits.",
      400,
    );
  return result.data;
}
function local(id: string): void {
  if (id !== workspace)
    throw new KnowledgeError(
      "NOT_FOUND",
      "This knowledge item does not exist in the local workspace.",
      404,
    );
}
function sourceChanged(): never {
  throw new KnowledgeError(
    "SOURCE_CHANGED",
    "Selected evidence changed, expired, or was deleted. Review the current sources and start a new mission.",
  );
}
function splitUtf8(value: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const point of value) {
    const length = Buffer.byteLength(point, "utf8");
    if (bytes + length > maxBytes) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += point;
    bytes += length;
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}
function chunks(text: string): Chunk[] {
  const result: Chunk[] = [];
  let body = "";
  let start = 1;
  let end = 1;
  const flush = () => {
    const text = body.trim();
    const leadingLines = (body.match(/^\s*/u)?.[0].match(/\n/g) ?? []).length;
    if (text)
      result.push({
        index: result.length,
        text,
        lineStart: start + leadingLines,
        lineEnd: end,
        contentHash: hash(text),
      });
    body = "";
  };
  text.split("\n").forEach((line, offset) => {
    const parts = splitUtf8(line, CHUNK_BYTES);
    if (parts.length > 1) {
      flush();
      for (const part of parts) {
        if (part.trim())
          result.push({
            index: result.length,
            text: part.trim(),
            lineStart: offset + 1,
            lineEnd: offset + 1,
            contentHash: hash(part.trim()),
          });
      }
      return;
    }
    for (const part of parts) {
      if (
        body &&
        Buffer.byteLength(body, "utf8") + Buffer.byteLength(part, "utf8") + 1 >
          CHUNK_BYTES
      )
        flush();
      if (!body) start = offset + 1;
      body += `${body ? "\n" : ""}${part}`;
      end = offset + 1;
    }
  });
  flush();
  return result;
}
function vector(values: number[], profile: EmbeddingProfile): number[] {
  if (
    values.length !== profile.dimensions ||
    values.some((value) => !Number.isFinite(value))
  )
    throw new KnowledgeError(
      "EMBEDDING_INVALID",
      "The local embedding vector has invalid dimensions or values.",
      502,
    );
  const norm = Math.hypot(...values);
  if (!norm)
    throw new KnowledgeError(
      "EMBEDDING_INVALID",
      "The local embedding vector has zero length.",
      502,
    );
  return values.map((value) => value / norm);
}
function excerpt(value: string, bytes: number): string {
  let used = 0;
  let result = "";
  for (const point of value) {
    const length = Buffer.byteLength(point, "utf8");
    if (used + length > bytes) break;
    result += point;
    used += length;
  }
  return result.trim();
}
function terms(query: string): string {
  const stop = new Set(
    "and the for this that with from only describe explain prepare does what how when where which each every have has are was were will shall must should not into its their these those than then can could would about using use used our your any all".split(
      " ",
    ),
  );
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
    .filter((term) => !stop.has(term))
    .slice(0, 32)
    .join(" | ");
}

export class KnowledgeRepository {
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

  async listSources(workspaceId = workspace): Promise<Source[]> {
    const result = await this.options.pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM ${this.schema}.knowledge_sources WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY metadata->>'createdAt' DESC`,
      [workspaceId],
    );
    return result.rows.map((row) => sourceSchema.parse(row.metadata));
  }
  async getSource(
    workspaceId: string,
    id: string,
  ): Promise<SourceDetail | undefined> {
    const result = await this.options.pool.query<{
      metadata: unknown;
      body: string;
    }>(
      `SELECT s.metadata,r.body FROM ${this.schema}.knowledge_sources s
      JOIN ${this.schema}.source_revisions r ON r.workspace_id=s.workspace_id AND r.source_id=s.id AND r.revision=s.revision
      WHERE s.workspace_id=$1 AND s.id=$2 AND s.deleted_at IS NULL`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? {
          source: sourceSchema.parse(result.rows[0].metadata),
          text: result.rows[0].body,
        }
      : undefined;
  }
  async createSource(workspaceId: string, input: SourceInput): Promise<Source> {
    local(workspaceId);
    const value = parse(sourceInputSchema, input);
    const text = this.normalize(value.text);
    const now = this.options.now().toISOString();
    const source: Source = {
      id: randomUUID(),
      workspaceId: workspace,
      title: value.title,
      format: value.format,
      revision: 1,
      activeRevision: null,
      status: "queued",
      contentHash: hash(text),
      chunkCount: 0,
      profile: null,
      parserVersion: "plain-text-v1",
      chunkerVersion: "utf8-lines-v1",
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    await this.options.transaction(async (client) => {
      await client.query(
        `INSERT INTO ${this.schema}.knowledge_sources(workspace_id,id,revision,metadata) VALUES($1,$2,$3,$4::jsonb)`,
        [workspaceId, source.id, 1, JSON.stringify(source)],
      );
      await this.insertRevision(client, source, text);
    });
    return source;
  }
  async updateSource(
    workspaceId: string,
    id: string,
    input: SourceUpdate,
  ): Promise<Source> {
    local(workspaceId);
    const value = parse(sourceUpdateSchema, input);
    const text = this.normalize(value.text);
    return this.options.transaction(async (client) => {
      const current = await this.lockSource(client, workspaceId, id, "UPDATE");
      if (!current)
        throw new KnowledgeError(
          "SOURCE_NOT_FOUND",
          "This source does not exist.",
          404,
        );
      if (current.revision !== value.revision)
        throw new KnowledgeError(
          "STALE_REVISION",
          "The source changed. Refresh before saving.",
        );
      const next: Source = {
        ...current,
        title: value.title,
        format: value.format,
        revision: current.revision + 1,
        status: "queued",
        contentHash: hash(text),
        parserVersion: "plain-text-v1",
        chunkerVersion: "utf8-lines-v1",
        updatedAt: this.options.now().toISOString(),
        error: null,
      };
      await client.query(
        `UPDATE ${this.schema}.knowledge_sources SET revision=$3,metadata=$4::jsonb WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id, next.revision, JSON.stringify(next)],
      );
      await this.insertRevision(client, next, text);
      return next;
    });
  }
  async deleteSource(workspaceId: string, id: string): Promise<void> {
    local(workspaceId);
    await this.options.transaction(async (client) => {
      const current = await this.lockSource(client, workspaceId, id, "UPDATE");
      if (!current) return;
      await client.query(
        `DELETE FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND source_id=$2`,
        [workspaceId, id],
      );
      await client.query(
        `DELETE FROM ${this.schema}.source_revisions WHERE workspace_id=$1 AND source_id=$2`,
        [workspaceId, id],
      );
      await client.query(
        `UPDATE ${this.schema}.knowledge_sources SET metadata='{}'::jsonb,active_revision=NULL,deleted_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id],
      );
    });
  }
  async listMemories(workspaceId = workspace): Promise<Memory[]> {
    const result = await this.options.pool.query<{ aggregate: unknown }>(
      `SELECT aggregate FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 ORDER BY aggregate->>'createdAt' DESC`,
      [workspaceId],
    );
    return result.rows.map((row) => memorySchema.parse(row.aggregate));
  }
  async createMemory(workspaceId: string, input: MemoryInput): Promise<Memory> {
    local(workspaceId);
    const value = parse(memoryInputSchema, input);
    const now = this.options.now().toISOString();
    const memory: Memory = {
      ...value,
      id: randomUUID(),
      workspaceId: workspace,
      scope: "workspace",
      revision: 1,
      trust: "confirmed",
      createdAt: now,
      updatedAt: now,
    };
    return this.options.transaction(async (client) => {
      await this.validateProvenance(client, memory);
      await client.query(
        `INSERT INTO ${this.schema}.knowledge_memories(workspace_id,id,revision,aggregate,source_id) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [
          workspaceId,
          memory.id,
          1,
          JSON.stringify(memory),
          memory.provenance.kind === "source"
            ? memory.provenance.sourceId
            : null,
        ],
      );
      return memory;
    });
  }
  async updateMemory(
    workspaceId: string,
    id: string,
    input: MemoryUpdate,
  ): Promise<Memory> {
    local(workspaceId);
    const value = parse(memoryUpdateSchema, input);
    return this.options.transaction(async (client) => {
      await this.validateProvenance(client, { provenance: value.provenance });
      const result = await client.query<{ aggregate: unknown }>(
        `SELECT aggregate FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, id],
      );
      if (!result.rows[0])
        throw new KnowledgeError(
          "MEMORY_NOT_FOUND",
          "This memory does not exist.",
          404,
        );
      const current = memorySchema.parse(result.rows[0].aggregate);
      if (current.revision !== value.revision)
        throw new KnowledgeError(
          "STALE_REVISION",
          "The memory changed. Refresh before saving.",
        );
      const next: Memory = {
        ...current,
        ...value,
        revision: current.revision + 1,
        updatedAt: this.options.now().toISOString(),
      };
      await client.query(
        `UPDATE ${this.schema}.knowledge_memories SET revision=$3,aggregate=$4::jsonb,source_id=$5 WHERE workspace_id=$1 AND id=$2`,
        [
          workspaceId,
          id,
          next.revision,
          JSON.stringify(next),
          value.provenance.kind === "source" ? value.provenance.sourceId : null,
        ],
      );
      return next;
    });
  }
  async deleteMemory(workspaceId: string, id: string): Promise<void> {
    local(workspaceId);
    await this.options.pool.query(
      `DELETE FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, id],
    );
  }
  async profile(): Promise<EmbeddingProfile | null> {
    const result = await this.options.pool.query<{ profile: unknown }>(
      `SELECT profile FROM ${this.schema}.knowledge_profiles WHERE workspace_id=$1`,
      [workspace],
    );
    return result.rows[0]
      ? embeddingProfileSchema.parse(result.rows[0].profile)
      : null;
  }
  async pinSelection(
    client: PoolClient,
    selection: EvidenceSelection,
    requireCurrent = true,
  ): Promise<PinnedSelection> {
    const parsed = parse(evidenceSelectionSchema, selection);
    const pins: PinnedSelection = { sources: [], memories: [] };
    await this.lockDependencies(client, parsed.sourceIds, parsed.memoryIds);
    for (const id of [...parsed.sourceIds].sort()) {
      const source = await this.lockSource(client, workspace, id, "SHARE");
      if (!source?.activeRevision)
        throw new KnowledgeError(
          "SOURCE_NOT_READY",
          "Select a source with an active searchable revision.",
        );
      if (
        requireCurrent &&
        (source.status !== "ready" || source.activeRevision !== source.revision)
      )
        throw new KnowledgeError(
          "SOURCE_NOT_READY",
          "New missions require the latest source revision to be ready.",
        );
      pins.sources.push({
        id,
        revision: source.revision,
        activeRevision: source.activeRevision,
      });
    }
    for (const id of [...parsed.memoryIds].sort()) {
      const result = await client.query<{ aggregate: unknown }>(
        `SELECT aggregate FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
        [workspace, id],
      );
      if (!result.rows[0]) sourceChanged();
      const memory = memorySchema.parse(result.rows[0].aggregate);
      this.notExpired(memory);
      await this.validateProvenance(client, memory);
      pins.memories.push({ id, revision: memory.revision });
    }
    return pins;
  }
  async savePins(
    client: PoolClient,
    runId: string,
    pins: PinnedSelection,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.schema}.run_knowledge(workspace_id,run_id,pins) VALUES($1,$2,$3::jsonb)`,
      [workspace, runId, JSON.stringify(pins)],
    );
  }
  async runPins(
    workspaceId: string,
    runId: string,
    client?: PoolClient,
  ): Promise<PinnedSelection | undefined> {
    const result = await (client ?? this.options.pool).query<{
      pins: PinnedSelection;
    }>(
      `SELECT pins FROM ${this.schema}.run_knowledge WHERE workspace_id=$1 AND run_id=$2`,
      [workspaceId, runId],
    );
    return result.rows[0]?.pins;
  }
  async assertRunPins(
    workspaceId: string,
    runId: string,
    client: PoolClient,
  ): Promise<void> {
    const pins = await this.runPins(workspaceId, runId, client);
    if (!pins) sourceChanged();
    await this.validatePins(client, pins);
  }
  async search(
    selection: EvidenceSelection,
    query: string,
    embed: KnowledgeEmbedder,
    signal?: AbortSignal,
  ): Promise<EvidenceSnapshot> {
    const pins = await this.options.transaction((client) =>
      this.pinSelection(client, selection, false),
    );
    return this.searchPinned(pins, query, embed, signal);
  }
  async searchPinned(
    pins: PinnedSelection,
    query: string,
    embed: KnowledgeEmbedder,
    signal?: AbortSignal,
  ): Promise<EvidenceSnapshot> {
    if (!query.trim() || query.length > 10_000)
      throw new KnowledgeError(
        "INVALID_INPUT",
        "Enter a bounded retrieval query.",
        400,
      );
    signal?.throwIfAborted();
    await this.options.transaction((client) => this.validatePins(client, pins));
    let profile: EmbeddingProfile | null = null;
    let queryVector: number[] | null = null;
    if (pins.sources.length) {
      const result = await embed({ texts: [query], kind: "query", signal });
      profile = embeddingProfileSchema.parse(result.profile);
      if (result.vectors.length !== 1)
        throw new KnowledgeError(
          "EMBEDDING_INVALID",
          "The local query embedding response is invalid.",
          502,
        );
      queryVector = vector(result.vectors[0]!, profile);
      const activeProfile = await this.profile();
      if (
        !activeProfile ||
        hash(JSON.stringify(profile)) !== hash(JSON.stringify(activeProfile))
      )
        throw new KnowledgeError(
          "EMBEDDING_PROFILE_CHANGED",
          "The local embedding model differs from the active index. Reindexing is required.",
        );
    }
    signal?.throwIfAborted();
    return this.options.transaction(async (client) => {
      await this.validatePins(client, pins);
      const candidates: Array<
        Omit<EvidenceItem, "citation"> & { ranking: number }
      > = [];
      const lexical = terms(query);
      if (queryVector && profile) {
        const result = await client.query<{
          source_id: string;
          revision: number;
          title: string;
          chunk_index: number;
          body: string;
          content_hash: string;
          line_start: number;
          line_end: number;
          semantic: number;
          lexical: number;
        }>(
          `SELECT c.source_id,c.revision,r.title,c.chunk_index,c.body,c.content_hash,c.line_start,c.line_end,
             (1-(c.embedding OPERATOR(public.<=>) $3::public.vector))::float8 AS semantic,
             ts_rank_cd(to_tsvector('english',c.body),to_tsquery('english',$4))::float8 AS lexical
           FROM ${this.schema}.source_chunks c JOIN ${this.schema}.knowledge_sources s
             ON s.workspace_id=c.workspace_id AND s.id=c.source_id AND s.active_revision=c.revision
           JOIN ${this.schema}.source_revisions r ON r.workspace_id=c.workspace_id AND r.source_id=c.source_id AND r.revision=c.revision
           WHERE c.workspace_id=$1 AND c.source_id=ANY($2::uuid[]) AND s.deleted_at IS NULL AND r.state='ready' AND c.profile_hash=$5
           ORDER BY (c.embedding OPERATOR(public.<=>) $3::public.vector) LIMIT 24`,
          [
            workspace,
            pins.sources.map((source) => source.id),
            JSON.stringify(queryVector),
            lexical,
            hash(JSON.stringify(profile)),
          ],
        );
        for (const row of result.rows) {
          if (row.semantic < 0.55 && (row.lexical <= 0 || row.semantic < 0.25))
            continue;
          candidates.push({
            kind: "source",
            ownerId: row.source_id,
            title: row.title,
            revision: row.revision,
            chunkIndex: row.chunk_index,
            lineStart: row.line_start,
            lineEnd: row.line_end,
            text: row.body,
            contentHash: row.content_hash,
            score: row.semantic,
            ranking: row.semantic * 0.7 + Math.min(1, row.lexical) * 0.3,
          });
        }
      }
      if (pins.memories.length && lexical) {
        const result = await client.query<{ aggregate: unknown; rank: number }>(
          `SELECT aggregate,
          ts_rank_cd(to_tsvector('english',(aggregate->>'title') || ' ' || (aggregate->>'content')),to_tsquery('english',$3))::float8 AS rank
          FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
          [workspace, pins.memories.map((memory) => memory.id), lexical],
        );
        for (const row of result.rows) {
          const memory = memorySchema.parse(row.aggregate);
          if (row.rank <= 0) continue;
          candidates.push({
            kind: "memory",
            ownerId: memory.id,
            title: memory.title,
            revision: memory.revision,
            chunkIndex: null,
            lineStart: null,
            lineEnd: null,
            text: memory.content,
            contentHash: hash(memory.content),
            score: row.rank,
            ranking: Math.min(1, row.rank) + 0.1,
          });
        }
      }
      candidates.sort(
        (a, b) =>
          b.ranking - a.ranking ||
          a.ownerId.localeCompare(b.ownerId) ||
          (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0),
      );
      const items: EvidenceItem[] = [];
      let bytes = 2400;
      let sourceNumber = 0;
      let memoryNumber = 0;
      for (const candidate of candidates.slice(0, 6)) {
        const text = excerpt(candidate.text, Math.min(800, bytes));
        if (!text) break;
        bytes -= Buffer.byteLength(text, "utf8");
        const { ranking: _ranking, ...item } = candidate;
        items.push({
          ...item,
          text,
          lineEnd:
            item.lineStart === null
              ? null
              : item.lineStart + text.split("\n").length - 1,
          contentHash: hash(text),
          citation:
            candidate.kind === "source"
              ? `S${++sourceNumber}`
              : `M${++memoryNumber}`,
        });
      }
      signal?.throwIfAborted();
      return evidenceSnapshotSchema.parse({
        status: items.length ? "matched" : "insufficient",
        query,
        policy: "hybrid-v1",
        items,
        profile,
        retrievedAt: this.options.now().toISOString(),
        messages: items.length
          ? [
              "Scores describe ranking, not factual confidence. Historical run evidence is retained after source deletion.",
            ]
          : [
              "No relevant passages were found in the selected active evidence. Generation is blocked.",
            ],
      });
    });
  }
  async claimIndex(
    data: IndexJobData,
    attemptId: string,
    allowRecovery = false,
  ): Promise<IndexClaim | undefined> {
    if (data.workspaceId !== workspace) return undefined;
    return this.options.transaction(async (client) => {
      const source = await this.lockSource(
        client,
        workspace,
        data.sourceId,
        "UPDATE",
      );
      if (
        !source ||
        source.revision !== data.revision ||
        (source.status !== "queued" &&
          !(allowRecovery && source.status === "indexing"))
      )
        return undefined;
      const result = await client.query<{ body: string }>(
        `SELECT body FROM ${this.schema}.source_revisions WHERE workspace_id=$1 AND source_id=$2 AND revision=$3`,
        [workspace, data.sourceId, data.revision],
      );
      if (!result.rows[0]) return undefined;
      const next: Source = {
        ...source,
        status: "indexing",
        error: null,
        updatedAt: this.options.now().toISOString(),
      };
      await client.query(
        `UPDATE ${this.schema}.source_revisions SET state='indexing',attempt_id=$4 WHERE workspace_id=$1 AND source_id=$2 AND revision=$3`,
        [workspace, data.sourceId, data.revision, attemptId],
      );
      await client.query(
        `UPDATE ${this.schema}.knowledge_sources SET metadata=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
        [workspace, data.sourceId, JSON.stringify(next)],
      );
      return {
        source: next,
        text: result.rows[0].body,
        attemptId,
        chunks: chunks(result.rows[0].body),
      };
    });
  }
  async completeIndex(
    claim: IndexClaim,
    profileValue: EmbeddingProfile,
    vectors: number[][],
    signal?: AbortSignal,
  ): Promise<boolean> {
    const profile = embeddingProfileSchema.parse(profileValue);
    const profileHash = hash(JSON.stringify(profile));
    if (vectors.length !== claim.chunks.length)
      throw new KnowledgeError(
        "EMBEDDING_INVALID",
        "The source embedding response has a missing chunk.",
        502,
      );
    const normalized = vectors.map((value) => vector(value, profile));
    return this.options.transaction(async (client) => {
      const source = await this.lockSource(
        client,
        workspace,
        claim.source.id,
        "UPDATE",
      );
      if (
        !source ||
        source.revision !== claim.source.revision ||
        source.status !== "indexing"
      )
        return false;
      const attempt = await client.query<{ attempt_id: string }>(
        `SELECT attempt_id FROM ${this.schema}.source_revisions WHERE workspace_id=$1 AND source_id=$2 AND revision=$3`,
        [workspace, source.id, source.revision],
      );
      if (attempt.rows[0]?.attempt_id !== claim.attemptId) return false;
      signal?.throwIfAborted();
      await client.query(
        `INSERT INTO ${this.schema}.knowledge_profiles(workspace_id,profile,profile_hash) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING`,
        [workspace, JSON.stringify(profile), profileHash],
      );
      const configured = await client.query<{ profile_hash: string }>(
        `SELECT profile_hash FROM ${this.schema}.knowledge_profiles WHERE workspace_id=$1 FOR SHARE`,
        [workspace],
      );
      if (configured.rows[0]?.profile_hash !== profileHash)
        throw new KnowledgeError(
          "EMBEDDING_PROFILE_CHANGED",
          "This workspace uses a different immutable embedding profile. Explicit reindexing is required.",
        );
      for (const chunk of claim.chunks) {
        await client.query(
          `INSERT INTO ${this.schema}.source_chunks(workspace_id,source_id,revision,chunk_index,body,content_hash,line_start,line_end,profile_hash,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::public.vector)`,
          [
            workspace,
            source.id,
            source.revision,
            chunk.index,
            chunk.text,
            chunk.contentHash,
            chunk.lineStart,
            chunk.lineEnd,
            profileHash,
            JSON.stringify(normalized[chunk.index]),
          ],
        );
      }
      signal?.throwIfAborted();
      const next: Source = {
        ...source,
        status: "ready",
        activeRevision: source.revision,
        chunkCount: claim.chunks.length,
        profile,
        error: null,
        updatedAt: this.options.now().toISOString(),
      };
      await client.query(
        `UPDATE ${this.schema}.source_revisions SET state='ready' WHERE workspace_id=$1 AND source_id=$2 AND revision=$3`,
        [workspace, source.id, source.revision],
      );
      await client.query(
        `UPDATE ${this.schema}.knowledge_sources SET active_revision=$3,metadata=$4::jsonb WHERE workspace_id=$1 AND id=$2`,
        [workspace, source.id, source.revision, JSON.stringify(next)],
      );
      return true;
    }, signal);
  }
  async failIndex(
    claim: IndexClaim,
    detail: { code: string; message: string },
    willRetry: boolean,
  ): Promise<void> {
    await this.options.transaction(async (client) => {
      const source = await this.lockSource(
        client,
        workspace,
        claim.source.id,
        "UPDATE",
      );
      if (
        !source ||
        source.revision !== claim.source.revision ||
        source.status !== "indexing"
      )
        return;
      const result = await client.query(
        `UPDATE ${this.schema}.source_revisions SET state=$5,attempt_id=NULL WHERE workspace_id=$1 AND source_id=$2 AND revision=$3 AND attempt_id=$4`,
        [
          workspace,
          source.id,
          source.revision,
          claim.attemptId,
          willRetry ? "queued" : "failed",
        ],
      );
      if (!result.rowCount) return;
      const next: Source = {
        ...source,
        status: willRetry ? "queued" : "failed",
        error: detail,
        updatedAt: this.options.now().toISOString(),
      };
      await client.query(
        `UPDATE ${this.schema}.knowledge_sources SET metadata=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
        [workspace, source.id, JSON.stringify(next)],
      );
    });
  }
  async reconcileExhausted(): Promise<void> {
    const result = await this.options.pool.query<{ data: IndexJobData }>(
      `SELECT j.data FROM ${this.options.queueSchema}.job j
      JOIN ${this.schema}.knowledge_sources s ON s.workspace_id=j.data->>'workspaceId' AND s.id::text=j.data->>'sourceId' AND s.revision::text=j.data->>'revision'
      WHERE j.name=$1 AND j.state='failed' AND s.deleted_at IS NULL AND s.metadata->>'status' IN ('queued','indexing') LIMIT 50`,
      [INDEX_QUEUE],
    );
    for (const row of result.rows) {
      const claim = await this.claimIndex(row.data, randomUUID(), true);
      if (claim)
        await this.failIndex(
          claim,
          {
            code: "INDEX_RETRIES_EXHAUSTED",
            message:
              "Local indexing exhausted its bounded retries. Update the source to retry.",
          },
          false,
        );
    }
    // Queue retention can remove a pending job while the API remains online and
    // no worker is available. Never turn that missing job into fresh inference.
    const orphans = await this.options.pool.query<{
      id: string;
      revision: number;
    }>(
      `SELECT s.id,s.revision FROM ${this.schema}.knowledge_sources s
      WHERE s.workspace_id=$1 AND s.deleted_at IS NULL AND s.metadata->>'status' IN ('queued','indexing')
      AND (s.metadata->>'updatedAt')::timestamptz < now() - interval '10 minutes'
      AND NOT EXISTS (SELECT 1 FROM ${this.options.queueSchema}.job j WHERE j.name=$2
        AND j.data->>'workspaceId'=s.workspace_id AND j.data->>'sourceId'=s.id::text AND j.data->>'revision'=s.revision::text
        AND j.state IN ('created','retry','active')) LIMIT 50`,
      [workspace, INDEX_QUEUE],
    );
    for (const row of orphans.rows) {
      await this.options.transaction(async (client) => {
        const source = await this.lockSource(
          client,
          workspace,
          row.id,
          "UPDATE",
        );
        if (
          !source ||
          source.revision !== row.revision ||
          !["queued", "indexing"].includes(source.status)
        )
          return;
        const stale = await client.query(
          `SELECT 1 FROM ${this.schema}.knowledge_sources s WHERE s.workspace_id=$1 AND s.id=$2
          AND (s.metadata->>'updatedAt')::timestamptz < now() - interval '10 minutes'
          AND NOT EXISTS (SELECT 1 FROM ${this.options.queueSchema}.job j WHERE j.name=$3
            AND j.data->>'workspaceId'=s.workspace_id AND j.data->>'sourceId'=s.id::text AND j.data->>'revision'=s.revision::text
            AND j.state IN ('created','retry','active'))`,
          [workspace, row.id, INDEX_QUEUE],
        );
        if (!stale.rowCount) return;
        const next: Source = {
          ...source,
          status: "failed",
          error: {
            code: "INDEX_JOB_UNAVAILABLE",
            message:
              "No live indexing job remains for this interrupted source revision. Update the source to retry; no automatic inference was started.",
          },
          updatedAt: this.options.now().toISOString(),
        };
        await client.query(
          `UPDATE ${this.schema}.source_revisions SET state='failed',attempt_id=NULL WHERE workspace_id=$1 AND source_id=$2 AND revision=$3`,
          [workspace, row.id, row.revision],
        );
        await client.query(
          `UPDATE ${this.schema}.knowledge_sources SET metadata=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
          [workspace, row.id, JSON.stringify(next)],
        );
      });
    }
  }
  private normalize(text: string): string {
    if (text.includes("\u0000"))
      throw new KnowledgeError(
        "INVALID_INPUT",
        "Source text cannot contain null characters.",
        400,
      );
    return text.replace(/\r\n?/g, "\n").trim();
  }
  private async insertRevision(
    client: PoolClient,
    source: Source,
    text: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.schema}.source_revisions(workspace_id,source_id,revision,title,body,state) VALUES($1,$2,$3,$4,$5,'queued')`,
      [workspace, source.id, source.revision, source.title, text],
    );
    const data: IndexJobData = {
      workspaceId: workspace,
      sourceId: source.id,
      revision: source.revision,
    };
    const id = await this.options.boss.send(INDEX_QUEUE, data, {
      singletonKey: `${workspace}:${source.id}:${source.revision}`,
      db: {
        executeSql: (text: string, values: unknown[]) =>
          client.query(text, values),
      },
    });
    if (!id)
      throw new KnowledgeError(
        "INDEX_QUEUE_UNAVAILABLE",
        "The source was not saved because its indexing job could not be queued.",
        503,
      );
  }
  private async lockSource(
    client: PoolClient,
    workspaceId: string,
    id: string,
    lock: "SHARE" | "UPDATE",
  ): Promise<Source | undefined> {
    const result = await client.query<{ metadata: unknown }>(
      `SELECT metadata FROM ${this.schema}.knowledge_sources WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR ${lock}`,
      [workspaceId, id],
    );
    return result.rows[0]
      ? sourceSchema.parse(result.rows[0].metadata)
      : undefined;
  }
  private notExpired(memory: Memory): void {
    if (
      memory.expiresAt &&
      new Date(memory.expiresAt).getTime() <= this.options.now().getTime()
    )
      sourceChanged();
  }
  private async validateProvenance(
    client: PoolClient,
    memory: Pick<Memory, "provenance">,
  ): Promise<void> {
    if (memory.provenance.kind !== "source") return;
    const source = await this.lockSource(
      client,
      workspace,
      memory.provenance.sourceId,
      "SHARE",
    );
    if (!source || source.activeRevision !== memory.provenance.sourceRevision)
      sourceChanged();
  }
  private async validatePins(
    client: PoolClient,
    pins: PinnedSelection,
  ): Promise<void> {
    await this.lockDependencies(
      client,
      pins.sources.map((pin) => pin.id),
      pins.memories.map((pin) => pin.id),
    );
    for (const pin of pins.sources) {
      const source = await this.lockSource(client, workspace, pin.id, "SHARE");
      if (
        !source ||
        source.revision !== pin.revision ||
        source.activeRevision !== pin.activeRevision
      )
        sourceChanged();
    }
    for (const pin of pins.memories) {
      const result = await client.query<{ aggregate: unknown }>(
        `SELECT aggregate FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
        [workspace, pin.id],
      );
      if (!result.rows[0]) sourceChanged();
      const memory = memorySchema.parse(result.rows[0].aggregate);
      if (memory.revision !== pin.revision) sourceChanged();
      this.notExpired(memory);
      await this.validateProvenance(client, memory);
    }
  }
  private async lockDependencies(
    client: PoolClient,
    sourceIds: string[],
    memoryIds: string[],
  ): Promise<void> {
    const rows = await client.query<{ aggregate: unknown }>(
      `SELECT aggregate FROM ${this.schema}.knowledge_memories WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
      [workspace, memoryIds],
    );
    const ids = new Set(sourceIds);
    for (const row of rows.rows) {
      const memory = memorySchema.parse(row.aggregate);
      if (memory.provenance.kind === "source")
        ids.add(memory.provenance.sourceId);
    }
    // Source deletion locks the source before deleting linked memories. Use that same order.
    for (const id of [...ids].sort())
      await this.lockSource(client, workspace, id, "SHARE");
  }
}
