import { z } from "zod";
import { parseRunIntegrity, runSchema } from "./index.js";
import type { Run } from "./index.js";
import { evidenceSnapshotSchema } from "./knowledge.js";
import { workflowRefSchema } from "./workflow.js";
import {
  draftRevisionIntegrityInputs,
  draftRevisionSchema,
} from "./draft-revision.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
export const outboxRetentionDisclosure =
  "Approved artifacts, approval history, and any evidence excerpts are retained in run history even if the original sources or memories are later changed or deleted. This download contains a local copy. It does not send messages, publish content, or deploy a release.";

export const approvedPackageSchema = z.object({
  schemaVersion: z.literal(1),
  workflow: workflowRefSchema.nullable(),
  runId: z.string(),
  workspaceId: z.literal("local-workspace"),
  title: z.string(),
  domain: z.enum(["build", "operate", "support", "market", "sell"]),
  mode: z.enum(["simulation", "ollama"]),
  approval: z.object({
    actionFingerprint: sha256Schema,
    revision: z.number().int().positive(),
    actor: z.string().min(1),
    actorName: z.string().min(1).optional(),
    decidedAt: timestamp,
  }),
  route: z.object({
    policy: z.literal("local_only"),
    provider: z.literal("ollama"),
    model: z.string().nullable(),
    executed: z.boolean(),
    reason: z.string(),
  }),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      durationMs: z.number().nonnegative().nullable(),
    })
    .nullable(),
  evidence: evidenceSnapshotSchema.nullable(),
  draftRevisions: z.array(draftRevisionSchema).max(10).default([]),
  documents: z.tuple([
    z.object({
      id: z.string(),
      filename: z.literal("release-readiness.md"),
      mediaType: z.literal("text/markdown"),
      content: z.string(),
      sha256: sha256Schema,
      byteLength: z.number().int().nonnegative(),
      savedAt: timestamp,
    }),
  ]),
  events: z.array(
    z.object({
      sequence: z.number().int().positive(),
      type: z.string(),
      occurredAt: timestamp,
      message: z.string(),
    }),
  ),
  retention: z.object({ disclosure: z.literal(outboxRetentionDisclosure) }),
});
export type ApprovedPackage = z.infer<typeof approvedPackageSchema>;

export const outboxItemSchema = z.object({
  runId: z.string(),
  title: z.string(),
  mode: z.enum(["simulation", "ollama"]),
  approvedAt: timestamp,
  actor: z.string(),
  actorName: z.string().optional(),
  filename: z.string().max(100),
  documentSha256: sha256Schema,
  documentBytes: z.number().int().nonnegative(),
});
export type OutboxItem = z.infer<typeof outboxItemSchema>;
export const outboxSnapshotSchema = z.object({
  items: z.array(outboxItemSchema),
});
export type OutboxSnapshot = z.infer<typeof outboxSnapshotSchema>;

export class OutboxError extends Error {
  constructor(
    readonly code:
      | "OUTBOX_NOT_APPROVED"
      | "OUTBOX_INVALID_ARTIFACT"
      | "OUTBOX_HASH_UNAVAILABLE",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "OutboxError";
  }
}

async function sha256(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new OutboxError(
      "OUTBOX_HASH_UNAVAILABLE",
      "A native SHA-256 implementation is required to verify this local package.",
      503,
    );
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A read-only projection of one exact, already-approved artifact. No files or outbox rows are created. */
export async function createApprovedPackage(
  value: Run,
): Promise<ApprovedPackage> {
  let candidate: Run;
  try {
    candidate = runSchema.parse(value);
  } catch {
    throw new OutboxError(
      "OUTBOX_INVALID_ARTIFACT",
      "This run cannot be verified as an approved local artifact.",
    );
  }
  if (
    candidate.status !== "completed" ||
    candidate.decision?.decision !== "approve" ||
    !candidate.artifact ||
    !candidate.proposal
  ) {
    throw new OutboxError(
      "OUTBOX_NOT_APPROVED",
      "Only completed, explicitly approved local artifacts can be downloaded.",
    );
  }
  const { kind, destination, content } = candidate.proposal;
  let inputs: Set<string>;
  try {
    inputs = new Set([
      JSON.stringify({ kind, destination, content }),
      ...(candidate.evidence?.items.map((item) => item.text) ?? []),
      ...draftRevisionIntegrityInputs(candidate),
    ]);
  } catch {
    throw new OutboxError(
      "OUTBOX_INVALID_ARTIFACT",
      "The retained draft revision history could not be reconstructed.",
    );
  }
  // The shared integrity validator is synchronous. Precompute every hash it
  // verifies using native Web Crypto, then require a known input on callback.
  const hashes = new Map(
    await Promise.all(
      [...inputs].map(async (text) => [text, await sha256(text)] as const),
    ),
  );
  let run: Run;
  try {
    run = parseRunIntegrity(candidate, (text) => {
      const hash = hashes.get(text);
      if (!hash) throw new Error("An integrity input was not precomputed.");
      return hash;
    });
  } catch {
    throw new OutboxError(
      "OUTBOX_INVALID_ARTIFACT",
      "The saved artifact, approval, or evidence differs from its recorded integrity data.",
    );
  }
  const artifact = run.artifact!;
  const approval = run.decision!;
  return approvedPackageSchema.parse({
    schemaVersion: 1,
    workflow: run.workflow ?? null,
    runId: run.id,
    workspaceId: run.workspaceId,
    title: run.title,
    domain: run.domain,
    mode: run.mode,
    approval: {
      actionFingerprint: approval.fingerprint,
      revision: approval.revision,
      actor: approval.actor,
      ...(approval.actorName ? { actorName: approval.actorName } : {}),
      decidedAt: approval.decidedAt,
    },
    route: run.route,
    usage: run.usage ?? null,
    evidence: run.evidence ?? null,
    draftRevisions: run.draftRevisions ?? [],
    documents: [
      {
        id: artifact.id,
        filename: "release-readiness.md",
        mediaType: "text/markdown",
        content: artifact.content,
        sha256: await sha256(artifact.content),
        byteLength: new TextEncoder().encode(artifact.content).byteLength,
        savedAt: artifact.savedAt,
      },
    ],
    events: run.events,
    retention: { disclosure: outboxRetentionDisclosure },
  });
}

/** ASCII only, bounded, stable; titles and raw path characters never enter response headers. */
export function approvedPackageFilename(value: ApprovedPackage): string {
  const id =
    value.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 36) || "release";
  return `vuzmi-${id}-${value.documents[0].sha256.slice(0, 12)}.json`;
}

export function approvedPackageSummary(value: ApprovedPackage): OutboxItem {
  return outboxItemSchema.parse({
    runId: value.runId,
    title: value.title,
    mode: value.mode,
    approvedAt: value.approval.decidedAt,
    actor: value.approval.actor,
    ...(value.approval.actorName
      ? { actorName: value.approval.actorName }
      : {}),
    filename: approvedPackageFilename(value),
    documentSha256: value.documents[0].sha256,
    documentBytes: value.documents[0].byteLength,
  });
}
