import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  claimGeneration,
  completeGeneration,
  createQueuedRun,
  decideRun,
  DomainError,
  exhaustGeneration,
  failGeneration,
  parseRunIntegrity,
} from "../src/index.js";
import type { Run, Usage } from "../src/index.js";

const now = "2026-11-04T21:00:00.000Z";
const later = "2026-11-04T21:01:00.000Z";
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const usage: Usage = { inputTokens: 140, outputTokens: 90, durationMs: 250 };
const content =
  "# Vuzmi release draft\n\n- [ ] Verify the release.\n\nNo deployment was performed.";
const error = {
  code: "UNAVAILABLE",
  message: "The local model service is unavailable.",
  retryable: true,
};

function queued(): Run {
  return createQueuedRun(
    {
      title: "Prepare Vuzmi alpha",
      brief:
        "Prepare a founder release document with unchecked acceptance criteria and risks.",
      domain: "build",
      mode: "ollama",
    },
    { id: "live-run", now, model: "existing-local-model:latest" },
  );
}

function generating(): Run {
  const run = claimGeneration(queued(), { attemptId: "attempt-1", now });
  assert.ok(run);
  return run;
}

function finish(
  run: Run,
  overrides: Partial<{
    attemptId: string;
    expectedRevision: number;
    content: string;
  }> = {},
): Run | undefined {
  return completeGeneration(run, {
    attemptId: run.attemptId!,
    expectedRevision: run.revision,
    content,
    usage,
    now: later,
    fingerprint,
    ...overrides,
  });
}

test("a real-mode draft requires claim, saved model output, and exact approval before a local artifact exists", () => {
  const initial = queued();
  assert.equal(initial.status, "queued");
  assert.equal(initial.mode, "ollama");
  assert.equal(initial.proposal, null);
  assert.equal(initial.route.executed, false);
  assert.equal(initial.artifact, undefined);
  const running = claimGeneration(initial, { attemptId: "attempt-1", now });
  assert.ok(running);
  assert.equal(running.status, "running");
  assert.equal(
    initial.status,
    "queued",
    "claiming must not mutate the previously persisted aggregate",
  );
  const waiting = finish(running);
  assert.ok(waiting?.proposal);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(waiting.route.executed, true);
  assert.equal(waiting.proposal.content, content);
  assert.deepEqual(waiting.usage, usage);
  assert.equal(
    waiting.artifact,
    undefined,
    "model output is not yet an approved artifact",
  );
  const decision = {
    decision: "approve" as const,
    revision: waiting.revision,
    fingerprint: waiting.proposal.fingerprint,
  };
  const completed = decideRun(waiting, decision, later);
  assert.equal(completed.status, "completed");
  assert.equal(completed.artifact?.content, content);
  assert.equal(completed.decision?.actor, "local-operator");
  assert.deepEqual(
    completed.events.map((event) => event.type),
    [
      "run.queued",
      "generation.started",
      "generation.completed",
      "approval.requested",
      "approval.approved",
      "artifact.saved",
    ],
  );
  assert.equal(
    decideRun(completed, decision, later),
    completed,
    "replay cannot create a second artifact or event",
  );
  assert.equal(parseRunIntegrity(completed, fingerprint).status, "completed");
});

test("queued and running missions cannot be approved before an exact draft exists", () => {
  for (const run of [queued(), generating()]) {
    assert.throws(
      () =>
        decideRun(
          run,
          {
            decision: "approve",
            revision: run.revision,
            fingerprint: "0".repeat(64),
          },
          now,
        ),
      (cause: unknown) =>
        cause instanceof DomainError && cause.code === "INVALID_STATE",
    );
    assert.equal(run.proposal, null);
    assert.equal(run.artifact, undefined);
  }
});

test("recovery fences both obsolete output and obsolete failure without stealing a live first attempt", () => {
  const original = generating();
  assert.equal(
    claimGeneration(original, { attemptId: "duplicate", now: later }),
    undefined,
  );
  const recovered = claimGeneration(original, {
    attemptId: "attempt-2",
    now: later,
    allowRecovery: true,
  });
  assert.ok(recovered);
  assert.equal(recovered.attemptId, "attempt-2");
  assert.equal(
    finish(recovered, {
      attemptId: original.attemptId!,
      expectedRevision: original.revision,
    }),
    undefined,
  );
  assert.equal(
    finish(recovered, { expectedRevision: original.revision }),
    undefined,
  );
  assert.equal(
    failGeneration(recovered, {
      attemptId: original.attemptId!,
      expectedRevision: original.revision,
      error,
      willRetry: false,
      now: later,
    }),
    undefined,
  );
  const waiting = finish(recovered);
  assert.equal(waiting?.status, "waiting_approval");
  assert.equal(waiting?.proposal?.content, content);
  assert.equal(
    claimGeneration(waiting!, {
      attemptId: "unnecessary-retry",
      now: later,
      allowRecovery: true,
    }),
    undefined,
  );
});

test("retry failures preserve visible history and terminal failures cannot generate or approve", () => {
  const first = generating();
  const retry = failGeneration(first, {
    attemptId: first.attemptId!,
    expectedRevision: first.revision,
    error,
    willRetry: true,
    now: later,
  });
  assert.ok(retry);
  assert.equal(retry.status, "queued");
  assert.equal(retry.error?.code, "UNAVAILABLE");
  assert.equal(retry.events.at(-1)?.type, "generation.retry_scheduled");
  assert.equal(parseRunIntegrity(retry, fingerprint).status, "queued");
  const next = claimGeneration(retry, {
    attemptId: "attempt-retry",
    now: later,
  });
  assert.ok(next);
  assert.equal(
    next.error,
    undefined,
    "a new attempt clears its current error, while events preserve history",
  );
  const terminal = failGeneration(next, {
    attemptId: next.attemptId!,
    expectedRevision: next.revision,
    error,
    willRetry: false,
    now: later,
  });
  assert.ok(terminal);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.proposal, null);
  assert.equal(terminal.artifact, undefined);
  assert.equal(terminal.events.at(-1)?.type, "generation.failed");
  assert.equal(
    claimGeneration(terminal, {
      attemptId: "after-terminal",
      now: later,
      allowRecovery: true,
    }),
    undefined,
  );
  assert.equal(finish(terminal), undefined);
});

test("exhaustion terminates queued or abandoned running work, preserving completed drafts", () => {
  for (const run of [queued(), generating()]) {
    const exhausted = exhaustGeneration(run, { error, now: later });
    assert.ok(exhausted);
    assert.equal(exhausted.status, "failed");
    assert.equal(exhausted.error?.retryable, false);
    assert.equal(exhausted.events.at(-1)?.type, "generation.exhausted");
    assert.equal(finish(exhausted), undefined);
    assert.equal(
      claimGeneration(exhausted, {
        attemptId: "beyond-budget",
        now: later,
        allowRecovery: true,
      }),
      undefined,
    );
    assert.equal(parseRunIntegrity(exhausted, fingerprint).status, "failed");
  }
  const waiting = finish(generating());
  assert.ok(waiting);
  assert.equal(
    exhaustGeneration(waiting, { error, now: later }),
    undefined,
    "an old failed queue job cannot invalidate a saved proposal",
  );
});

test("empty or oversized output cannot become an approvable proposal", () => {
  const run = generating();
  for (const invalid of ["  \n", "x".repeat(100_001)]) {
    assert.throws(
      () => finish(run, { content: invalid }),
      (cause: unknown) =>
        cause instanceof DomainError && cause.code === "INVALID_STATE",
    );
  }
  assert.equal(run.status, "running");
  assert.equal(run.proposal, null);
});

test("persisted tampering is detected at content, event, model, artifact, and approval boundaries", () => {
  const waiting = finish(generating());
  assert.ok(waiting?.proposal);
  const completed = decideRun(
    waiting,
    {
      decision: "approve",
      revision: waiting.revision,
      fingerprint: waiting.proposal.fingerprint,
    },
    later,
  );
  const corruptions: Array<() => unknown> = [
    () => ({
      ...waiting,
      proposal: {
        ...waiting.proposal,
        content: "Content changed after review",
      },
    }),
    () => ({
      ...waiting,
      events: waiting.events.map((event, index) =>
        index === 0 ? { ...event, sequence: 9 } : event,
      ),
    }),
    () => ({ ...waiting, route: { ...waiting.route, model: null } }),
    () => ({ ...completed, artifact: undefined }),
    () => ({
      ...completed,
      artifact: { ...completed.artifact, content: "Another artifact" },
    }),
    () => ({
      ...completed,
      decision: { ...completed.decision, revision: completed.revision },
    }),
    () => ({ ...waiting, status: "queued" }),
  ];
  for (const corrupt of corruptions)
    assert.throws(() => parseRunIntegrity(corrupt(), fingerprint));
  assert.equal(
    parseRunIntegrity(waiting, fingerprint).proposal?.content,
    content,
  );
});
