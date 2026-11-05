import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  amendDraft,
  attachEvidence,
  claimGeneration,
  completeGeneration,
  createApprovedPackage,
  createQueuedRun,
  createSimulationRun,
  decideRun,
  DomainError,
  draftRevisionIntegrityInputs,
  DraftRevisionError,
  extractDraftBody,
  OutboxError,
  parseRunIntegrity,
  renderDraftDocument,
  reviseDraftSchema,
} from "../src/index.js";
import type { EvidenceSnapshot, ReviseDraftInput, Run } from "../src/index.js";

const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const now = "2026-11-05T10:00:00.000Z",
  later = "2026-11-05T10:01:00.000Z";
const actor = { id: "immutable-owner-id", name: "Fixture owner" };
const brief = {
  title: "Revise founder release",
  brief: "Prepare a reviewed release document whose wording can be corrected.",
  domain: "build" as const,
};
const sourceId = "10000000-0000-4000-8000-000000000001";
const evidence: EvidenceSnapshot = {
  status: "matched",
  query: brief.brief,
  policy: "hybrid-v1",
  profile: null,
  retrievedAt: now,
  messages: [],
  items: [
    {
      citation: "S1",
      kind: "source",
      ownerId: sourceId,
      title: "Product policy",
      revision: 1,
      chunkIndex: 0,
      lineStart: 1,
      lineEnd: 1,
      text: "Vuzmi saves reviewed local artifacts.",
      contentHash: sha("Vuzmi saves reviewed local artifacts."),
      score: 0.8,
    },
  ],
};
function waiting(grounded = false, content?: string): Run {
  const queued = createQueuedRun(
    {
      ...brief,
      mode: "ollama",
      ...(grounded
        ? { knowledge: { sourceIds: [sourceId], memoryIds: [] } }
        : {}),
    },
    { id: "revision-run", now, model: "fixture-local-model" },
  );
  let run = claimGeneration(queued, { attemptId: "attempt-1", now })!;
  if (grounded)
    run = attachEvidence(run, {
      attemptId: run.attemptId!,
      expectedRevision: run.revision,
      evidence,
      now,
    })!;
  return completeGeneration(run, {
    attemptId: run.attemptId!,
    expectedRevision: run.revision,
    content:
      content ??
      renderDraftDocument(
        grounded ? "Original model wording. [S1]" : "Original model wording.",
        grounded ? evidence : undefined,
      ),
    usage: { inputTokens: 10, outputTokens: 20, durationMs: 30 },
    now,
    fingerprint: sha,
  })!;
}
function edit(
  run: Run,
  body = run.knowledge ? "Corrected wording. [S1]" : "Corrected wording.",
): ReviseDraftInput {
  return {
    editId: randomUUID(),
    revision: run.revision,
    fingerprint: run.proposal!.fingerprint,
    body,
    reason: "Correct the factual wording.",
  };
}
function amend(run: Run, input = edit(run)): Run {
  return amendDraft(run, input, { now: later, fingerprint: sha, actor });
}
const code = (expected: string) => (error: unknown) =>
  error instanceof DraftRevisionError && error.code === expected;

test("human amendment preserves exact body and trusted references, usage/route/evidence, original bytes and an approval fence", () => {
  const initial = waiting(true),
    original = JSON.stringify(initial);
  const body = "# Corrected café 🚀\r\n\r\n  Exact spaces remain. [S1]  \r\n\n";
  const input = edit(initial, body),
    revised = amend(initial, input);
  assert.equal(JSON.stringify(initial), original);
  assert.equal(revised.revision, initial.revision + 1);
  assert.equal(revised.status, "waiting_approval");
  assert.equal(
    revised.proposal!.content,
    renderDraftDocument(body, evidence, "human"),
  );
  assert.equal(
    extractDraftBody(revised.proposal!.content, evidence, "human"),
    body,
  );
  assert.match(revised.proposal!.content, /Human-revised draft — unverified/);
  assert.equal(revised.artifact, undefined);
  for (const field of [
    "usage",
    "route",
    "evidence",
    "knowledge",
    "workflow",
  ] as const)
    assert.deepEqual(revised[field], initial[field]);
  const retained = revised.draftRevisions![0]!;
  assert.deepEqual(retained.previousProposal, initial.proposal);
  assert.equal(retained.actor, actor.id);
  assert.equal(retained.actorName, actor.name);
  assert.equal(retained.reason, input.reason);
  assert.equal(retained.fromRevision, initial.revision);
  assert.equal(retained.toRevision, revised.revision);
  assert.equal(revised.events.at(-1)!.type, "draft.revised");
  assert.equal(retained.eventSequence, revised.events.at(-1)!.sequence);
  assert.throws(
    () =>
      decideRun(
        revised,
        {
          decision: "approve",
          revision: initial.revision,
          fingerprint: initial.proposal!.fingerprint,
        },
        later,
      ),
    (error) => error instanceof DomainError && error.code === "STALE_APPROVAL",
  );
  const approved = decideRun(
    revised,
    {
      decision: "approve",
      revision: revised.revision,
      fingerprint: revised.proposal!.fingerprint,
    },
    later,
    actor,
  );
  assert.equal(approved.artifact!.content, revised.proposal!.content);
  assert.equal(parseRunIntegrity(approved, sha).status, "completed");
});

test("exact edit UUID replay is a no-op after later edits and approval; conflicting request or actor fails closed", () => {
  const initial = waiting(),
    firstInput = edit(initial),
    first = amend(initial, firstInput),
    second = amend(first, edit(first, "Another exact correction."));
  assert.equal(
    amendDraft(second, firstInput, { now, fingerprint: sha, actor }),
    second,
  );
  const approved = decideRun(
    second,
    {
      decision: "approve",
      revision: second.revision,
      fingerprint: second.proposal!.fingerprint,
    },
    later,
    actor,
  );
  assert.equal(
    amendDraft(approved, firstInput, { now, fingerprint: sha, actor }),
    approved,
  );
  for (const changed of [
    { ...firstInput, body: "Different text" },
    { ...firstInput, reason: "Different reason" },
  ])
    assert.throws(() => amend(approved, changed), code("EDIT_ID_CONFLICT"));
  assert.throws(
    () =>
      amendDraft(approved, firstInput, {
        now,
        fingerprint: sha,
        actor: { ...actor, id: "other-owner" },
      }),
    code("EDIT_ID_CONFLICT"),
  );
  assert.throws(
    () =>
      amendDraft(approved, firstInput, {
        now,
        fingerprint: sha,
        actor: { ...actor, name: "Renamed owner" },
      }),
    code("EDIT_ID_CONFLICT"),
  );
  assert.throws(
    () => amend(approved, edit(approved)),
    code("DRAFT_NOT_EDITABLE"),
  );
  assert.throws(
    () =>
      amend(first, {
        ...edit(first),
        revision: initial.revision,
        fingerprint: initial.proposal!.fingerprint,
      }),
    code("STALE_DRAFT"),
  );
});

test("body bounds count UTF-8, reject invalid Unicode/controls and preserve supported line breaks without normalizing input", () => {
  const input = edit(waiting());
  assert.equal(
    reviseDraftSchema.safeParse({ ...input, body: "x".repeat(65_536) }).success,
    true,
  );
  for (const body of [
    " ",
    "x".repeat(65_537),
    "界".repeat(22_000),
    "bad\u0000body",
    "bad\u007fbody",
    "bad\ud800body",
    "bad\udc00body",
  ])
    assert.equal(
      reviseDraftSchema.safeParse({ ...input, body }).success,
      false,
    );
  assert.equal(
    reviseDraftSchema.safeParse({ ...input, body: "Exact\ttext\r\n " }).success,
    true,
  );
  assert.equal(
    reviseDraftSchema.safeParse({ ...input, reason: "  " }).success,
    false,
  );
  assert.equal(
    reviseDraftSchema.safeParse({ ...input, actor: "spoofed" }).success,
    false,
  );
});

test("only recognized waiting Ollama proposals can change, with known retained citations when evidence is required", () => {
  const grounded = waiting(true);
  for (const body of [
    "Missing reference.",
    "Invented [S2].",
    "Linked [S1](https://example.test)",
    "Invented numeric [1].",
  ])
    assert.throws(
      () => amend(grounded, edit(grounded, body)),
      code("INVALID_DRAFT"),
    );
  assert.throws(
    () => amend(waiting(), edit(waiting(), "Invented [S1].")),
    code("INVALID_DRAFT"),
  );
  const custom = waiting(false, "# Legacy custom document");
  assert.throws(() => amend(custom, edit(custom)), code("DRAFT_NOT_EDITABLE"));
  const simulated = createSimulationRun(brief, {
    id: "sim",
    now,
    fingerprint: sha,
  });
  assert.throws(
    () => amend(simulated, edit(simulated)),
    code("DRAFT_NOT_EDITABLE"),
  );
  const rejected = decideRun(
    grounded,
    {
      decision: "reject",
      revision: grounded.revision,
      fingerprint: grounded.proposal!.fingerprint,
    },
    later,
    actor,
  );
  assert.throws(
    () => amend(rejected, edit(rejected)),
    code("DRAFT_NOT_EDITABLE"),
  );
});

test("ten retained revisions remain bounded and exact replay still works at the limit", () => {
  let run = waiting();
  let replay: ReviseDraftInput | undefined;
  for (let index = 0; index < 10; index++) {
    const input = edit(run, `Correction ${index}.`);
    if (index === 0) replay = input;
    run = amend(run, input);
  }
  assert.equal(run.draftRevisions!.length, 10);
  assert.throws(() => amend(run), code("DRAFT_REVISION_LIMIT"));
  assert.equal(amendDraft(run, replay!, { now, fingerprint: sha, actor }), run);
  assert.equal(parseRunIntegrity(run, sha).draftRevisions!.length, 10);
});

test("history corruption fails verification at previous bytes, actor/reason, UUID, event and revision links", () => {
  const first = amend(waiting(true)),
    run = amend(first, edit(first, "Second corrected statement. [S1]"));
  const changes: Array<(copy: Run) => void> = [
    (copy) => {
      copy.draftRevisions![0]!.previousProposal.content += "changed";
    },
    (copy) => {
      copy.draftRevisions![0]!.actor = "spoofed";
    },
    (copy) => {
      copy.draftRevisions![0]!.actorName = "spoofed";
    },
    (copy) => {
      copy.draftRevisions![0]!.reason = "Different reason";
    },
    (copy) => {
      copy.draftRevisions![0]!.editId = randomUUID();
    },
    (copy) => {
      copy.draftRevisions![0]!.occurredAt = now;
    },
    (copy) => {
      copy.draftRevisions![0]!.eventSequence = 1;
    },
    (copy) => {
      copy.draftRevisions![0]!.fromRevision += 1;
    },
    (copy) => {
      copy.draftRevisions![0]!.toRevision += 1;
    },
    (copy) => {
      copy.draftRevisions![0]!.nextFingerprint = "0".repeat(64);
    },
    (copy) => {
      copy.draftRevisions![0]!.requestHash = "0".repeat(64);
    },
    (copy) => {
      copy.draftRevisions!.pop();
    },
    (copy) => {
      delete copy.draftRevisions;
    },
    (copy) => {
      copy.draftRevisions![1]!.editId = copy.draftRevisions![0]!.editId;
    },
  ];
  for (const change of changes) {
    const copy = structuredClone(run);
    change(copy);
    assert.throws(() => parseRunIntegrity(copy, sha));
  }
  assert.equal(parseRunIntegrity(run, sha).draftRevisions!.length, 2);
});

test("browser precomputed integrity inputs cover every historical action and canonical request without skipping required hashes", () => {
  const initial = waiting(true),
    first = amend(initial),
    run = amend(first, edit(first, "Second correction. [S1]"));
  assert.deepEqual(draftRevisionIntegrityInputs(initial), []);
  const inputs = draftRevisionIntegrityInputs(run);
  assert.equal(inputs.length, 4);
  const proposal = run.proposal!;
  const all = [
    ...inputs,
    JSON.stringify({
      kind: proposal.kind,
      destination: proposal.destination,
      content: proposal.content,
    }),
    ...run.evidence!.items.map((item) => item.text),
  ];
  const hashes = new Map(all.map((value) => [value, sha(value)]));
  assert.equal(
    parseRunIntegrity(run, (value) => {
      const digest = hashes.get(value);
      if (!digest) throw new Error("Missing required digest");
      return digest;
    }).revision,
    run.revision,
  );
  const broken = structuredClone(run);
  broken.proposal!.content = "Unrecognized document";
  assert.throws(() => draftRevisionIntegrityInputs(broken));
});

test("approved browser-safe package includes the exact retained history and rejects changed or stripped history", async () => {
  const first = amend(waiting(true)),
    revised = amend(first, edit(first, "Final exact correction. [S1]"));
  const approved = decideRun(
    revised,
    {
      decision: "approve",
      revision: revised.revision,
      fingerprint: revised.proposal!.fingerprint,
    },
    later,
    actor,
  );
  const value = await createApprovedPackage(approved);
  assert.deepEqual(value.draftRevisions, approved.draftRevisions);
  assert.equal(value.documents[0].content, approved.artifact!.content);
  assert.equal(value.documents[0].sha256, sha(approved.artifact!.content));
  const changes: Array<(copy: Run) => void> = [
    (copy) => {
      copy.draftRevisions![0]!.previousProposal.content =
        "Changed original bytes";
    },
    (copy) => {
      copy.draftRevisions![0]!.reason = "Changed retained reason";
    },
    (copy) => {
      delete copy.draftRevisions;
    },
  ];
  for (const change of changes) {
    const broken = structuredClone(approved);
    change(broken);
    await assert.rejects(
      createApprovedPackage(broken),
      (error: unknown) =>
        error instanceof OutboxError &&
        error.code === "OUTBOX_INVALID_ARTIFACT",
    );
  }
});
