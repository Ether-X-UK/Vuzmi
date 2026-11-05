import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSimulationRun, decideRun, type Run } from "@vuzmi/core";
import {
  acknowledgeProposal,
  captureReviewedDecision,
  createProposalReview,
  openUpdatedProposal,
  proposalVersion,
  receiveProposalRun,
  requireProposalReview,
} from "../src/proposalReview";

function fixture(id = "review-run"): Run {
  return createSimulationRun(
    {
      title: "Owned review fixture",
      brief: "Verify only exact local proposal review boundaries.",
      domain: "build",
    },
    {
      id,
      now: "2026-11-05T12:00:00.000Z",
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
    },
  );
}
function replacement(run: Run, revision: number, content: string): Run {
  return {
    ...run,
    revision,
    proposal: {
      ...run.proposal!,
      content,
      fingerprint: createHash("sha256").update(content).digest("hex"),
    },
  };
}

test("unchanged initial proposals retain normal exact-version decision behavior", () => {
  const a = fixture();
  const state = receiveProposalRun(createProposalReview(a), { ...a });
  assert.deepEqual(
    captureReviewedDecision(state, proposalVersion(a), "approve"),
    {
      runId: a.id,
      input: {
        decision: "approve",
        revision: a.revision,
        fingerprint: a.proposal!.fingerprint,
      },
    },
  );
});

test("poll replacement preserves A and blocks both decisions until B is opened and acknowledged", () => {
  const a = fixture();
  const b = replacement(a, 2, "Replacement B");
  let state = receiveProposalRun(createProposalReview(a), b);
  assert.equal(state.displayed, a);
  assert.equal(state.latest, b);
  assert.equal(state.required, true);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(a), "approve"),
    null,
  );
  assert.equal(
    captureReviewedDecision(state, proposalVersion(a), "reject"),
    null,
  );
  assert.equal(acknowledgeProposal(state, proposalVersion(b)!), state);
  state = openUpdatedProposal(state, a.id);
  assert.equal(state.displayed, b);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(b), "approve"),
    null,
  );
  state = acknowledgeProposal(state, proposalVersion(b)!);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(b), "reject")?.input
      .revision,
    2,
  );
});

test("C arriving during B acknowledgment invalidates B without replacing its displayed text", () => {
  const a = fixture();
  const b = replacement(a, 2, "Replacement B");
  const c = replacement(a, 3, "Replacement C");
  let state = openUpdatedProposal(
    receiveProposalRun(createProposalReview(a), b),
    a.id,
  );
  state = acknowledgeProposal(
    receiveProposalRun(state, c),
    proposalVersion(b)!,
  );
  assert.equal(state.displayed, b);
  assert.equal(state.required, true);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(b), "approve"),
    null,
  );
  state = acknowledgeProposal(
    openUpdatedProposal(state, a.id),
    proposalVersion(c)!,
  );
  assert.equal(
    captureReviewedDecision(state, proposalVersion(c), "approve")?.input
      .fingerprint,
    c.proposal!.fingerprint,
  );
});

test("an acknowledged B is invalidated by either revision or fingerprint changes", () => {
  const a = fixture();
  let state = acknowledgeProposal(
    openUpdatedProposal(requireProposalReview(createProposalReview(a)), a.id),
    proposalVersion(a)!,
  );
  state = receiveProposalRun(state, { ...a, revision: 2 });
  assert.equal(
    captureReviewedDecision(state, proposalVersion(a), "approve"),
    null,
  );
  const changedFingerprint = replacement(
    a,
    a.revision,
    "Different body, same aggregate revision",
  );
  assert.equal(
    receiveProposalRun(createProposalReview(a), changedFingerprint).required,
    true,
  );
});

test("409 recovery stays blocked even if refresh fails or returns the same proposal", () => {
  const a = fixture();
  let state = requireProposalReview(createProposalReview(a));
  state = receiveProposalRun(state, { ...a });
  assert.equal(state.required, true);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(a), "approve"),
    null,
  );
  state = acknowledgeProposal(
    openUpdatedProposal(state, a.id),
    proposalVersion(a)!,
  );
  assert.ok(captureReviewedDecision(state, proposalVersion(a), "approve"));
});

test("captured requests remain bound to A while later observations require new review", () => {
  const a = fixture();
  const b = replacement(a, 2, "Replacement B");
  const captured = captureReviewedDecision(
    createProposalReview(a),
    proposalVersion(a),
    "approve",
  )!;
  const state = receiveProposalRun(createProposalReview(a), b);
  assert.equal(captured.input.revision, a.revision);
  assert.equal(captured.input.fingerprint, a.proposal!.fingerprint);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(a), "approve"),
    null,
  );
});

test("run switches reject old click/ack arguments and late older responses cannot reopen terminal review", () => {
  const a = fixture();
  const other = fixture("other-run");
  const switched = receiveProposalRun(createProposalReview(a), other);
  assert.equal(
    captureReviewedDecision(switched, proposalVersion(a), "approve"),
    null,
  );
  assert.equal(openUpdatedProposal(switched, a.id), switched);
  const saved = decideRun(
    a,
    {
      decision: "approve",
      revision: a.revision,
      fingerprint: a.proposal!.fingerprint,
    },
    "2026-11-05T12:01:00.000Z",
  );
  const terminal = receiveProposalRun(createProposalReview(a), saved);
  assert.equal(terminal.displayed, saved);
  assert.equal(
    captureReviewedDecision(terminal, proposalVersion(a), "reject"),
    null,
  );
  assert.equal(receiveProposalRun(terminal, a), terminal);
  assert.equal(
    receiveProposalRun(terminal, replacement(a, 10, "Invalid resurrection")),
    terminal,
  );
});

test("initial queued generation adopts its first proposal without treating it as a replacement", () => {
  const a = fixture();
  const queued: Run = { ...a, status: "queued", proposal: null };
  const state = receiveProposalRun(createProposalReview(queued), {
    ...a,
    revision: 2,
  });
  assert.equal(state.required, false);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(state.displayed), "approve")
      ?.input.revision,
    2,
  );
});

test("a terminal rejection replaces the pinned document and cannot be acknowledged into another decision", () => {
  const a = fixture();
  const b = replacement(a, 2, "Replacement B");
  const rejected = decideRun(
    b,
    {
      decision: "reject",
      revision: b.revision,
      fingerprint: b.proposal!.fingerprint,
    },
    "2026-11-05T12:01:00.000Z",
  );
  const changed = openUpdatedProposal(
    receiveProposalRun(createProposalReview(a), b),
    a.id,
  );
  const state = acknowledgeProposal(
    receiveProposalRun(changed, rejected),
    proposalVersion(b)!,
  );
  assert.equal(state.displayed, rejected);
  assert.equal(state.required, false);
  assert.equal(
    captureReviewedDecision(state, proposalVersion(b), "approve"),
    null,
  );
  assert.equal(
    captureReviewedDecision(state, proposalVersion(b), "reject"),
    null,
  );
});
