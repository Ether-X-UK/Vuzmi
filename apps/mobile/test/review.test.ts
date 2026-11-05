import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSimulationRun } from "@vuzmi/core";
import type { Run } from "@vuzmi/core";
import { NativeApi, NativeApiError } from "../src/api";
import {
  acknowledgeNativeReview,
  canAcknowledgeNativeReview,
  canDecideNativeReview,
  captureNativeDecision,
  confirmNativeReview,
  initialNativeReview,
  observeNativeReview,
  openNativeDocument,
  requireNativeRereview,
} from "../src/review";
function run(): Run {
  return createSimulationRun(
    {
      title: "Native proposal review",
      brief:
        "Review the version-bound local document without any external action.",
      domain: "build",
    },
    {
      id: "review-run",
      now: "2026-11-05T12:00:00.000Z",
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
    },
  );
}
function changed(value: Run, label: string): Run {
  return {
    ...value,
    revision: value.revision + 1,
    proposal: {
      ...value.proposal!,
      content: label,
      fingerprint: createHash("sha256").update(label).digest("hex"),
    },
  };
}

test("B replacing A while its document is open blocks both decisions until B is explicitly opened and acknowledged", () => {
  const a = run(),
    b = changed(a, "Version B");
  let state = openNativeDocument(initialNativeReview(a), a);
  assert.equal(canDecideNativeReview(state, a), true);
  assert.equal(
    canDecideNativeReview(state, b),
    false,
    "The render guard blocks immediately before any effect stores new state.",
  );
  state = observeNativeReview(state, b);
  assert.equal(state.changed, true);
  assert.equal(state.opened, null);
  assert.equal(canAcknowledgeNativeReview(state, b), false);
  assert.equal(acknowledgeNativeReview(state, b).changed, true);
  state = openNativeDocument(state, b);
  assert.equal(state.changed, true);
  assert.equal(canAcknowledgeNativeReview(state, b), true);
  state = acknowledgeNativeReview(state, b);
  assert.equal(state.changed, false);
  assert.equal(state.acknowledged!.revision, b.revision);
  assert.equal(canDecideNativeReview(state, b), true);
});

test("C arriving while B awaits acknowledgment invalidates B's open document and every prior acknowledgment", () => {
  const a = run(),
    b = changed(a, "Version B"),
    c = changed(b, "Version C");
  let state = openNativeDocument(
    observeNativeReview(initialNativeReview(a), b),
    b,
  );
  assert.equal(canAcknowledgeNativeReview(state, c), false);
  state = observeNativeReview(state, c);
  assert.equal(state.opened, null);
  assert.equal(state.changed, true);
  state = acknowledgeNativeReview(state, c);
  assert.equal(canDecideNativeReview(state, c), false);
  state = acknowledgeNativeReview(openNativeDocument(state, c), c);
  assert.equal(canDecideNativeReview(state, c), true);
  const next = { ...c, revision: c.revision + 1 };
  assert.equal(
    canDecideNativeReview(state, next),
    false,
    "The same content hash at a new revision still needs explicit review.",
  );
});

test("409 or unknown outcome latches review even if refresh returns the same version; a failed read cannot unlock it", () => {
  const current = run();
  let state = requireNativeRereview(initialNativeReview(current), current);
  assert.equal(canDecideNativeReview(state, current), false);
  assert.equal(
    canAcknowledgeNativeReview(openNativeDocument(state, current), current),
    false,
  );
  state = observeNativeReview(state, current);
  assert.equal(
    state.refreshRequired,
    true,
    "Ordinary rerender or failed recovery does not confirm a saved outcome.",
  );
  state = confirmNativeReview(state, current);
  assert.equal(state.changed, true);
  assert.equal(state.refreshRequired, false);
  assert.equal(canDecideNativeReview(state, current), false);
  state = acknowledgeNativeReview(openNativeDocument(state, current), current);
  assert.equal(canDecideNativeReview(state, current), true);
});

test("in-flight transport uses its captured CAS when the visible proposal changes", async (t) => {
  const a = run(),
    captured = captureNativeDecision(initialNativeReview(a), a)!;
  const oldFingerprint = a.proposal!.fingerprint,
    oldRevision = a.revision;
  const b = changed(a, "New document");
  assert.equal(captureNativeDecision(initialNativeReview(a), b), undefined);
  a.proposal!.fingerprint = b.proposal!.fingerprint;
  a.revision = b.revision;
  let sent: unknown;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json(
      {
        error: {
          code: "STALE_APPROVAL",
          message: "Review the changed proposal.",
        },
      },
      { status: 409 },
    );
  });
  await assert.rejects(
    new NativeApi("http://localhost:4310").decide(captured, "approve"),
    (error) => error instanceof NativeApiError && error.status === 409,
  );
  assert.deepEqual(sent, {
    decision: "approve",
    revision: oldRevision,
    fingerprint: oldFingerprint,
  });
});

test("terminal or missing proposals cannot be decided through an old acknowledgment", () => {
  const current = run(),
    state = initialNativeReview(current);
  for (const value of [
    { ...current, status: "completed" as const },
    { ...current, proposal: null, status: "running" as const },
  ]) {
    assert.equal(canDecideNativeReview(state, value), false);
    assert.equal(captureNativeDecision(state, value), undefined);
  }
});
