import { z } from "zod";
import { parseRunIntegrity } from "./index.js";
import type { Proposal, Run } from "./index.js";
import {
  DraftDocumentError,
  extractDraftBody,
  renderDraftDocument,
  validateDraftCitations,
} from "./document.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
function validText(value: string): boolean {
  if (controls.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export const reviseDraftSchema = z
  .object({
    editId: z.string().uuid(),
    revision: z.number().int().positive(),
    fingerprint: hash,
    body: z
      .string()
      .min(1)
      .refine(
        (value) =>
          Boolean(value.trim()) &&
          validText(value) &&
          new TextEncoder().encode(value).byteLength <= 65_536,
        "Use nonblank valid Unicode text within 64 KiB, without control characters other than tab and line breaks.",
      ),
    reason: z
      .string()
      .min(3)
      .max(600)
      .refine(
        (value) => value.trim().length >= 3 && validText(value),
        "Provide a short valid change reason.",
      ),
  })
  .strict();
export type ReviseDraftInput = z.infer<typeof reviseDraftSchema>;
const retainedProposalSchema = z
  .object({
    kind: z.literal("save_local_artifact"),
    destination: z.literal("Local artifact library"),
    content: z.string(),
    fingerprint: hash,
  })
  .strict();
export const draftRevisionSchema = z
  .object({
    editId: z.string().uuid(),
    actor: z.string().min(1),
    actorName: z.string().min(1).optional(),
    reason: reviseDraftSchema.shape.reason,
    occurredAt: z.string().datetime(),
    eventSequence: z.number().int().positive(),
    fromRevision: z.number().int().positive(),
    toRevision: z.number().int().positive(),
    requestHash: hash,
    previousProposal: retainedProposalSchema,
    nextFingerprint: hash,
  })
  .strict();
export type DraftRevision = z.infer<typeof draftRevisionSchema>;
export interface DraftActor {
  id: string;
  name?: string;
}
export class DraftRevisionError extends Error {
  constructor(
    readonly code:
      | "INVALID_DRAFT"
      | "STALE_DRAFT"
      | "EDIT_ID_CONFLICT"
      | "DRAFT_NOT_EDITABLE"
      | "DRAFT_REVISION_LIMIT",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "DraftRevisionError";
  }
}
function actionInput(proposal: Proposal): string {
  return JSON.stringify({
    kind: proposal.kind,
    destination: proposal.destination,
    content: proposal.content,
  });
}
function revisionMessage(editId: string): string {
  return `Human draft revision ${editId} saved. Review the exact updated document before approval.`;
}
export function draftRevisionRequestHashInput(
  input: ReviseDraftInput,
  actor?: DraftActor,
): string {
  return JSON.stringify({
    editId: input.editId,
    revision: input.revision,
    fingerprint: input.fingerprint,
    body: input.body,
    reason: input.reason,
    actor: actor?.id ?? "local-operator",
    actorName: actor?.name ?? null,
  });
}
function nextProposal(run: Run, index: number): Proposal {
  const next =
    run.draftRevisions?.[index + 1]?.previousProposal ?? run.proposal;
  if (!next) throw new Error("A retained draft revision has no next proposal.");
  return next;
}
function retainedRequest(run: Run, index: number): ReviseDraftInput {
  const entry = run.draftRevisions![index]!;
  const body = extractDraftBody(
    nextProposal(run, index).content,
    run.evidence,
    "human",
  );
  if (body === undefined)
    throw new Error(
      "A retained draft revision has an unrecognized next document.",
    );
  return reviseDraftSchema.parse({
    editId: entry.editId,
    revision: entry.fromRevision,
    fingerprint: entry.previousProposal.fingerprint,
    body,
    reason: entry.reason,
  });
}

/** Exact SHA-256 inputs required by the synchronous history validator; none are omitted. */
export function draftRevisionIntegrityInputs(run: Run): string[] {
  return (run.draftRevisions ?? []).flatMap((entry, index) => [
    actionInput(entry.previousProposal),
    draftRevisionRequestHashInput(retainedRequest(run, index), {
      id: entry.actor,
      ...(entry.actorName ? { name: entry.actorName } : {}),
    }),
  ]);
}

export function validateDraftRevisionIntegrity(
  run: Run,
  fingerprint: (value: string) => string,
): void {
  const history = run.draftRevisions ?? [];
  const events = run.events.filter((event) => event.type === "draft.revised");
  if (events.length !== history.length)
    throw new Error("Draft revision events and retained history differ.");
  if (!history.length) {
    if (
      run.mode === "ollama" &&
      run.proposal &&
      extractDraftBody(run.proposal.content, run.evidence, "human") !==
        undefined
    )
      throw new Error("Human-revised provenance has no retained history.");
    return;
  }
  if (
    run.mode !== "ollama" ||
    !run.proposal ||
    !run.route.executed ||
    !["waiting_approval", "completed", "cancelled"].includes(run.status)
  )
    throw new Error("Draft revisions are inconsistent with this run.");
  const identities = new Set<string>();
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!,
      event = events[index]!,
      next = nextProposal(run, index),
      request = retainedRequest(run, index);
    const id = entry.editId.toLowerCase();
    if (identities.has(id))
      throw new Error("Duplicate draft revision identity.");
    identities.add(id);
    if (
      entry.toRevision !== entry.fromRevision + 1 ||
      (index > 0 && entry.fromRevision !== history[index - 1]!.toRevision)
    )
      throw new Error("Draft revision numbers do not form a contiguous chain.");
    if (
      event.sequence !== entry.eventSequence ||
      event.occurredAt !== entry.occurredAt ||
      event.message !== revisionMessage(entry.editId)
    )
      throw new Error("Draft revision metadata differs from its event.");
    if (
      fingerprint(actionInput(entry.previousProposal)) !==
        entry.previousProposal.fingerprint ||
      entry.nextFingerprint !== next.fingerprint ||
      fingerprint(actionInput(next)) !== entry.nextFingerprint
    )
      throw new Error(
        "Draft proposal fingerprints do not form a retained chain.",
      );
    const previousBody = extractDraftBody(
      entry.previousProposal.content,
      run.evidence,
      index === 0 ? "model" : "human",
    );
    if (previousBody === undefined)
      throw new Error(
        "A previous draft has an unrecognized provenance or evidence appendix.",
      );
    validateDraftCitations(request.body, run.evidence);
    if (
      renderDraftDocument(request.body, run.evidence, "human") !== next.content
    )
      throw new Error(
        "A revised draft differs from its trusted reconstruction.",
      );
    const expected = fingerprint(
      draftRevisionRequestHashInput(request, {
        id: entry.actor,
        ...(entry.actorName ? { name: entry.actorName } : {}),
      }),
    );
    if (expected !== entry.requestHash)
      throw new Error(
        "Draft revision request or actor metadata is inconsistent.",
      );
  }
  if (history.at(-1)!.toRevision !== run.revision - (run.decision ? 1 : 0))
    throw new Error(
      "The retained draft revision head differs from the current run revision.",
    );
}

export function amendDraft(
  run: Run,
  input: ReviseDraftInput,
  context: {
    now: string;
    fingerprint: (value: string) => string;
    actor?: DraftActor;
  },
): Run {
  const parsed = reviseDraftSchema.safeParse(input);
  if (!parsed.success)
    throw new DraftRevisionError(
      "INVALID_DRAFT",
      "Provide an edit UUID, current revision/fingerprint, bounded exact body, and a reason.",
      400,
    );
  parseRunIntegrity(run, context.fingerprint);
  const value = parsed.data,
    history = run.draftRevisions ?? [];
  const requestHash = context.fingerprint(
    draftRevisionRequestHashInput(value, context.actor),
  );
  const existing = history.find(
    (entry) => entry.editId.toLowerCase() === value.editId.toLowerCase(),
  );
  if (existing) {
    if (existing.requestHash !== requestHash)
      throw new DraftRevisionError(
        "EDIT_ID_CONFLICT",
        "This edit UUID already identifies a different request or actor. Preserve your unsaved text and use a new edit UUID deliberately.",
      );
    return run;
  }
  if (
    run.mode !== "ollama" ||
    run.status !== "waiting_approval" ||
    !run.route.executed ||
    !run.proposal ||
    run.decision ||
    run.artifact ||
    extractDraftBody(
      run.proposal.content,
      run.evidence,
      history.length ? "human" : "model",
    ) === undefined
  )
    throw new DraftRevisionError(
      "DRAFT_NOT_EDITABLE",
      "Only a waiting local Ollama draft in the recognized document format can be revised.",
    );
  if (
    value.revision !== run.revision ||
    value.fingerprint !== run.proposal.fingerprint
  )
    throw new DraftRevisionError(
      "STALE_DRAFT",
      "The draft changed. Keep your unsaved text and review the current saved document before retrying.",
    );
  if (history.length >= 10)
    throw new DraftRevisionError(
      "DRAFT_REVISION_LIMIT",
      "This mission has reached its ten-revision limit. Start another mission after reviewing its retained history.",
    );
  try {
    validateDraftCitations(value.body, run.evidence);
  } catch (error) {
    if (error instanceof DraftDocumentError)
      throw new DraftRevisionError("INVALID_DRAFT", error.message, 400);
    throw error;
  }
  const action = {
    kind: run.proposal.kind,
    destination: run.proposal.destination,
    content: renderDraftDocument(value.body, run.evidence, "human"),
  };
  const proposal = {
    ...action,
    fingerprint: context.fingerprint(JSON.stringify(action)),
  };
  const entry: DraftRevision = {
    editId: value.editId,
    actor: context.actor?.id ?? "local-operator",
    ...(context.actor?.name ? { actorName: context.actor.name } : {}),
    reason: value.reason,
    occurredAt: context.now,
    eventSequence: run.events.length + 1,
    fromRevision: run.revision,
    toRevision: run.revision + 1,
    requestHash,
    previousProposal: { ...run.proposal },
    nextFingerprint: proposal.fingerprint,
  };
  const next: Run = {
    ...run,
    revision: run.revision + 1,
    updatedAt: context.now,
    proposal,
    draftRevisions: [...history, entry],
    events: [
      ...run.events,
      {
        sequence: entry.eventSequence,
        type: "draft.revised",
        occurredAt: context.now,
        message: revisionMessage(value.editId),
      },
    ],
  };
  parseRunIntegrity(next, context.fingerprint);
  return next;
}
