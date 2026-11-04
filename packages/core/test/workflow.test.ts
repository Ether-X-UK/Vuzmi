import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createRunSchema,
  createSimulationRun,
  decideRun,
  DomainError,
  runSchema,
} from "../src/index.js";

const now = "2026-11-04T20:00:00.000Z";
const input = {
  title: "Prepare Vuzmi alpha",
  brief: "Prepare the smallest reviewable local release package.",
  domain: "build" as const,
};
function fixture() {
  return createSimulationRun(input, {
    id: "run-1",
    now,
    fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
  });
}

test("a proposal is explicitly simulated and approval saves only the exact displayed artifact", () => {
  const run = fixture();
  assert.equal(run.route.executed, false);
  assert.match(run.proposal.content, /LOCAL SIMULATION/);
  assert.equal(run.artifact, undefined);
  const decision = {
    decision: "approve" as const,
    fingerprint: run.proposal.fingerprint,
    revision: run.revision,
  };
  const completed = decideRun(run, decision, now);
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact?.content, run.proposal.content);
  assert.equal(run.status, "waiting_approval");
  assert.deepEqual(runSchema.parse(completed), completed);
  assert.equal(
    decideRun(completed, decision, now),
    completed,
    "identical replay is idempotent",
  );
});

test("rejection creates no artifact and cannot be changed to approval", () => {
  const run = fixture();
  const decision = {
    decision: "reject" as const,
    fingerprint: run.proposal.fingerprint,
    revision: 1,
  };
  const cancelled = decideRun(run, decision, now);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.artifact, undefined);
  assert.equal(decideRun(cancelled, decision, now), cancelled);
  assert.throws(
    () => decideRun(cancelled, { ...decision, decision: "approve" }, now),
    DomainError,
  );
});

test("stale revision and changed content fingerprint cannot authorize an action", () => {
  const run = fixture();
  for (const decision of [
    {
      decision: "approve" as const,
      revision: 2,
      fingerprint: run.proposal.fingerprint,
    },
    { decision: "approve" as const, revision: 1, fingerprint: "f".repeat(64) },
  ]) {
    assert.throws(
      () => decideRun(run, decision, now),
      (error: unknown) =>
        error instanceof DomainError && error.code === "STALE_APPROVAL",
    );
  }
  assert.equal(run.artifact, undefined);
});

test("each exact action gets a distinct fingerprint when its content changes", () => {
  const original = fixture();
  const changed = createSimulationRun(
    {
      ...input,
      brief: "Prepare a different release package for another audience.",
    },
    {
      id: "run-2",
      now,
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
    },
  );
  assert.notEqual(original.proposal.fingerprint, changed.proposal.fingerprint);
});

test("request contracts reject empty, oversized, and unexpected inputs", () => {
  assert.equal(
    createRunSchema.safeParse({ ...input, brief: "" }).success,
    false,
  );
  assert.equal(
    createRunSchema.safeParse({ ...input, brief: "x".repeat(6001) }).success,
    false,
  );
  assert.equal(
    createRunSchema.safeParse({ ...input, provider: "openai" }).success,
    false,
  );
});
