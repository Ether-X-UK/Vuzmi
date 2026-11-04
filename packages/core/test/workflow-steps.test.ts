import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  attachEvidence,
  claimGeneration,
  completeGeneration,
  createQueuedRun,
  createRunSchema,
  createSimulationRun,
  decideRun,
  deriveRunSteps,
  exhaustGeneration,
  failGeneration,
  founderReleaseWorkflow,
  founderReleaseWorkflowRef,
  getRunWorkflowLabel,
  parseRunIntegrity,
  runSchema,
  workflowRegistry,
} from "../src/index.js";
import type { EvidenceSnapshot, Run, WorkflowStepId } from "../src/index.js";

const now = "2026-11-04T22:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceId = "10000000-0000-4000-8000-000000000001";
const input = {
  title: "Vuzmi founder release",
  brief:
    "Prepare a reviewed local release document, with proposed checks still unexecuted.",
  domain: "build" as const,
};
const usage = { inputTokens: 10, outputTokens: 20, durationMs: 30 };
const error = {
  code: "LOCAL_UNAVAILABLE",
  message: "The local model is unavailable.",
  retryable: true,
};
const evidence: EvidenceSnapshot = {
  status: "matched",
  query: input.brief,
  policy: "hybrid-v1",
  profile: null,
  retrievedAt: now,
  messages: [],
  items: [
    {
      citation: "S1",
      kind: "source",
      ownerId: sourceId,
      title: "Release policy",
      revision: 1,
      chunkIndex: 0,
      lineStart: 1,
      lineEnd: 1,
      text: "A release requires approval.",
      contentHash: sha("A release requires approval."),
      score: 0.8,
    },
  ],
};
function queued(grounded = false): Run {
  return createQueuedRun(
    {
      ...input,
      mode: "ollama",
      ...(grounded
        ? { knowledge: { sourceIds: [sourceId], memoryIds: [] } }
        : {}),
    },
    { id: "live-workflow", now, model: "fixture-local-model" },
  );
}
function simulation(): Run {
  return createSimulationRun(input, {
    id: "simulation-workflow",
    now,
    fingerprint: sha,
  });
}
function claim(run: Run, attemptId = "attempt-1"): Run {
  return claimGeneration(run, { attemptId, now })!;
}
function retrieve(run: Run, snapshot = evidence): Run {
  return attachEvidence(run, {
    attemptId: run.attemptId!,
    expectedRevision: run.revision,
    evidence: snapshot,
    now,
  })!;
}
function draft(run: Run): Run {
  return completeGeneration(run, {
    attemptId: run.attemptId!,
    expectedRevision: run.revision,
    content:
      "# Release draft\n\n- [ ] Run tests; no test was performed. [S1]\n",
    usage,
    now,
    fingerprint: sha,
  })!;
}
function decide(run: Run, decision: "approve" | "reject" = "approve"): Run {
  return decideRun(
    run,
    {
      decision,
      fingerprint: run.proposal!.fingerprint,
      revision: run.revision,
    },
    now,
    { id: "owner-1", name: "Fixture owner" },
  );
}
function step(run: Run, id: WorkflowStepId) {
  return deriveRunSteps(run).find((item) => item.id === id)!;
}
function assertCompletedRemainsCompleted(history: Run[]) {
  for (let index = 1; index < history.length; index++) {
    for (const item of deriveRunSteps(history[index - 1]!))
      if (item.status === "completed")
        assert.equal(
          step(history[index]!, item.id).status,
          "completed",
          `${item.id} must preserve its recorded completion`,
        );
  }
}

test("new missions pin one immutable founder-release definition without changing action fingerprints or accepting workflow input", () => {
  assert.ok(Object.isFrozen(workflowRegistry));
  assert.ok(Object.isFrozen(founderReleaseWorkflow));
  assert.ok(Object.isFrozen(founderReleaseWorkflow.steps));
  assert.ok(founderReleaseWorkflow.steps.every(Object.isFrozen));
  assert.equal(workflowRegistry["founder-release@1"], founderReleaseWorkflow);
  assert.deepEqual(founderReleaseWorkflowRef, {
    id: "founder-release",
    version: 1,
  });
  for (const run of [simulation(), queued(), queued(true)])
    assert.deepEqual(run.workflow, founderReleaseWorkflowRef);
  const run = simulation();
  assert.equal(
    run.proposal!.fingerprint,
    sha(
      JSON.stringify({
        kind: run.proposal!.kind,
        destination: run.proposal!.destination,
        content: run.proposal!.content,
      }),
    ),
  );
  const approved = decide(run);
  assert.equal(approved.decision!.fingerprint, run.proposal!.fingerprint);
  assert.equal(approved.decision!.revision, run.revision);
  assert.deepEqual(approved.workflow, run.workflow);
  assert.equal(
    createRunSchema.safeParse({ ...input, workflow: founderReleaseWorkflowRef })
      .success,
    false,
    "No workflow builder or API input is introduced.",
  );
  assert.throws(() => {
    (founderReleaseWorkflow as unknown as { version: number }).version = 2;
  }, TypeError);
});

test("grounded live steps advance only as actual retrieval, draft, human approval and artifact events are persisted", () => {
  const initial = queued(true),
    running = claim(initial),
    grounded = retrieve(running),
    waiting = draft(grounded),
    approved = decide(waiting);
  assert.equal(step(initial, "prepare").status, "completed");
  assert.equal(step(initial, "retrieve").status, "pending");
  assert.equal(step(initial, "draft").status, "pending");
  assert.equal(step(running, "retrieve").status, "running");
  assert.equal(step(running, "draft").status, "pending");
  assert.equal(step(grounded, "retrieve").status, "completed");
  assert.equal(step(grounded, "draft").status, "running");
  assert.equal(step(waiting, "draft").status, "completed");
  assert.equal(step(waiting, "review").status, "waiting_approval");
  assert.equal(step(waiting, "save").status, "pending");
  assert.equal(approved.artifact!.content, waiting.proposal!.content);
  assert.deepEqual(
    deriveRunSteps(approved).map((item) => item.status),
    ["completed", "completed", "completed", "completed", "completed"],
  );
  assert.deepEqual(step(grounded, "retrieve").eventSequences, [
    grounded.events.find((event) => event.type === "retrieval.completed")!
      .sequence,
  ]);
  for (const item of deriveRunSteps(approved)) {
    assert.ok(item.eventSequences.length > 0);
    assert.ok(
      item.eventSequences.every((sequence) =>
        approved.events.some((event) => event.sequence === sequence),
      ),
    );
  }
  assertCompletedRemainsCompleted([
    initial,
    running,
    grounded,
    waiting,
    approved,
  ]);
  assert.match(
    step(approved, "draft").detail,
    /checks.*have not been executed/,
  );
  assert.match(
    step(approved, "save").detail,
    /No external send, publication, or deployment/,
  );
});

test("simulation stays an explicit template and a rejection never becomes an approved local save", () => {
  const waiting = simulation(),
    rejected = decide(waiting, "reject");
  assert.deepEqual(
    deriveRunSteps(waiting).map((item) => item.status),
    ["completed", "skipped", "completed", "waiting_approval", "pending"],
  );
  assert.match(step(waiting, "draft").label, /deterministic template/);
  assert.match(
    step(waiting, "draft").detail,
    /No model.*tests.*deployment ran/,
  );
  assert.deepEqual(step(waiting, "draft").eventSequences, [2]);
  assert.deepEqual(
    deriveRunSteps(rejected).map((item) => item.status),
    ["completed", "skipped", "completed", "cancelled", "cancelled"],
  );
  assert.equal(rejected.artifact, undefined);
  assert.equal(rejected.route.executed, false);
  assertCompletedRemainsCompleted([waiting, rejected]);
});

test("insufficient retrieval remains failed despite a retrieval.completed event and blocks all unexecuted downstream work", () => {
  const running = claim(queued(true));
  const insufficient = retrieve(running, {
    ...evidence,
    status: "insufficient",
    items: [],
  });
  assert.ok(
    insufficient.events.some((event) => event.type === "retrieval.completed"),
  );
  assert.equal(step(insufficient, "retrieve").status, "failed");
  assert.equal(step(insufficient, "draft").status, "blocked");
  const failed = failGeneration(insufficient, {
    attemptId: insufficient.attemptId!,
    expectedRevision: insufficient.revision,
    error: {
      code: "INSUFFICIENT_EVIDENCE",
      message: "Required evidence is insufficient.",
      retryable: false,
    },
    willRetry: false,
    now,
  })!;
  assert.deepEqual(
    deriveRunSteps(failed).map((item) => item.status),
    ["completed", "failed", "blocked", "blocked", "blocked"],
  );
  assert.equal(failed.proposal, null);
  assert.equal(failed.route.executed, false);
  assert.ok(
    !deriveRunSteps(failed).some(
      (item) =>
        ["draft", "review", "save"].includes(item.id) &&
        item.status === "completed",
    ),
  );
});

test("retry and exhaustion preserve earlier completed evidence while failed generation cannot imply review or save", () => {
  const initial = queued(true),
    running = claim(initial),
    grounded = retrieve(running);
  const retry = failGeneration(grounded, {
    attemptId: grounded.attemptId!,
    expectedRevision: grounded.revision,
    error,
    willRetry: true,
    now,
  })!;
  assert.equal(step(retry, "retrieve").status, "completed");
  assert.equal(step(retry, "draft").status, "pending");
  const recovered = claim(retry, "attempt-2"),
    waiting = draft(recovered),
    approved = decide(waiting);
  assertCompletedRemainsCompleted([
    initial,
    running,
    grounded,
    retry,
    recovered,
    waiting,
    approved,
  ]);
  const failed = exhaustGeneration(recovered, { error, now })!;
  assert.deepEqual(
    deriveRunSteps(failed).map((item) => item.status),
    ["completed", "completed", "failed", "blocked", "blocked"],
  );
  const abandoned = exhaustGeneration(queued(), { error, now })!;
  assert.deepEqual(
    deriveRunSteps(abandoned).map((item) => item.status),
    ["completed", "skipped", "failed", "blocked", "blocked"],
  );
  const neverRetrieved = exhaustGeneration(queued(true), { error, now })!;
  assert.deepEqual(
    deriveRunSteps(neverRetrieved).map((item) => item.status),
    ["completed", "failed", "blocked", "blocked", "blocked"],
  );
});

test("status, proposal prose and route flags cannot substitute for actual completion events", () => {
  const approved = decide(draft(claim(queued())));
  const noEvents = { ...approved, events: [] };
  assert.ok(
    !deriveRunSteps(noEvents).some((item) => item.status === "completed"),
  );
  const missingSave = {
    ...approved,
    events: approved.events.filter((event) => event.type !== "artifact.saved"),
  };
  assert.notEqual(step(missingSave, "save").status, "completed");
  const missingDraft = {
    ...approved,
    events: approved.events.filter(
      (event) => event.type !== "generation.completed",
    ),
  };
  assert.notEqual(step(missingDraft, "draft").status, "completed");
  const missingRetrieval = {
    ...decide(draft(retrieve(claim(queued(true))))),
    events: [],
  };
  assert.notEqual(step(missingRetrieval, "retrieve").status, "completed");
});

test("legacy reads remain version unknown without inventing metadata or mutating stored history", () => {
  const legacy = decide(simulation());
  delete legacy.workflow;
  const serialized = JSON.stringify(legacy);
  const parsed = runSchema.parse(JSON.parse(serialized));
  assert.equal(parsed.workflow, undefined);
  assert.equal(parseRunIntegrity(parsed, sha).workflow, undefined);
  assert.equal(
    getRunWorkflowLabel(parsed),
    "Legacy workflow · version unknown",
  );
  const first = deriveRunSteps(parsed),
    second = deriveRunSteps(parsed);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(parsed), serialized);
  assert.match(getRunWorkflowLabel(simulation()), /v1/);
});
