import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  attachEvidence,
  claimGeneration,
  completeGeneration,
  createQueuedRun,
  createSimulationRun,
  decideRun,
} from "../src/index.js";
import type { EvidenceSnapshot, Run } from "../src/index.js";
import {
  approvedPackageFilename,
  approvedPackageSchema,
  approvedPackageSummary,
  createApprovedPackage,
  OutboxError,
  outboxRetentionDisclosure,
} from "../src/outbox.js";

const now = "2026-11-04T20:00:00.000Z";
const approvedAt = "2026-11-04T20:05:00.000Z";
const sha = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const actor = { id: "immutable-owner-id", name: "Workspace owner" };
const input = {
  title: "Vuzmi release",
  brief: "Prepare a reviewed local release readiness artifact.",
  domain: "build" as const,
};
const sourceId = "10000000-0000-4000-8000-000000000001";
const evidence: EvidenceSnapshot = {
  status: "matched",
  query: "Vuzmi release",
  policy: "hybrid-v1",
  profile: null,
  retrievedAt: now,
  messages: ["Claims still require human review."],
  items: [
    {
      citation: "S1",
      kind: "source",
      ownerId: sourceId,
      title: "Release policy",
      revision: 3,
      chunkIndex: 0,
      lineStart: 1,
      lineEnd: 1,
      text: "Release café requires approval.",
      contentHash: sha("Release café requires approval."),
      score: 0.9,
    },
  ],
};
function simulation(id = "run-1"): Run {
  return createSimulationRun(input, { id, now, fingerprint: sha });
}
function approve(run: Run): Run {
  return decideRun(
    run,
    {
      decision: "approve",
      fingerprint: run.proposal!.fingerprint,
      revision: run.revision,
    },
    approvedAt,
    actor,
  );
}
function live(): Run {
  const queued = createQueuedRun(
    {
      ...input,
      mode: "ollama",
      knowledge: { sourceIds: [sourceId], memoryIds: [] },
    },
    { id: "live-run", now, model: "fixture-local-model" },
  );
  const running = claimGeneration(queued, { attemptId: "attempt-1", now })!;
  const grounded = attachEvidence(running, {
    attemptId: running.attemptId!,
    expectedRevision: running.revision,
    evidence,
    now,
  })!;
  const waiting = completeGeneration(grounded, {
    attemptId: grounded.attemptId!,
    expectedRevision: grounded.revision,
    content: "# Release café 🚀\r\n\r\n  Exact spaces remain. [S1]  \r\n\n",
    usage: { inputTokens: 11, outputTokens: 17, durationMs: 33 },
    now,
    fingerprint: sha,
  })!;
  return approve(waiting);
}

test("approved package preserves exact UTF-8 content and original approval separately from document digest", async () => {
  const run = live();
  const original = JSON.stringify(run);
  const value = await createApprovedPackage(run);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.workspaceId, "local-workspace");
  assert.equal(value.documents.length, 1);
  assert.equal(value.documents[0].content, run.artifact!.content);
  assert.equal(value.documents[0].sha256, sha(run.artifact!.content));
  assert.equal(
    value.documents[0].byteLength,
    Buffer.byteLength(run.artifact!.content, "utf8"),
  );
  assert.equal(value.documents[0].filename, "release-readiness.md");
  assert.equal(value.approval.actionFingerprint, run.decision!.fingerprint);
  assert.notEqual(value.approval.actionFingerprint, value.documents[0].sha256);
  assert.equal(value.approval.revision, run.decision!.revision);
  assert.equal(value.approval.actor, actor.id);
  assert.equal(value.approval.actorName, actor.name);
  assert.equal(value.approval.decidedAt, approvedAt);
  assert.deepEqual(value.route, run.route);
  assert.deepEqual(value.usage, run.usage);
  assert.deepEqual(value.evidence, evidence);
  assert.deepEqual(value.events, run.events);
  assert.equal(value.retention.disclosure, outboxRetentionDisclosure);
  assert.equal(
    JSON.stringify(run),
    original,
    "export must not mutate the approved aggregate",
  );
  assert.equal(
    JSON.stringify(await createApprovedPackage(JSON.parse(original))),
    JSON.stringify(value),
  );
  assert.deepEqual(
    approvedPackageSchema.parse(JSON.parse(JSON.stringify(value))),
    value,
  );
});

test("simulation provenance remains explicit and package/summary filenames are safe, bounded and stable", async () => {
  const run = approve(simulation('.. /\\\r\n;"é'.repeat(50)));
  const value = await createApprovedPackage(run);
  assert.equal(value.mode, "simulation");
  assert.equal(value.route.executed, false);
  assert.equal(value.route.model, null);
  assert.equal(value.usage, null);
  assert.equal(value.evidence, null);
  assert.match(value.documents[0].content, /LOCAL SIMULATION/);
  const filename = approvedPackageFilename(value);
  assert.match(filename, /^vuzmi-[A-Za-z0-9_-]+-[a-f0-9]{12}\.json$/);
  assert.ok(filename.length <= 100);
  assert.equal(approvedPackageSummary(value).filename, filename);
  assert.equal(
    approvedPackageSummary(value).documentSha256,
    value.documents[0].sha256,
  );
  assert.equal(
    JSON.stringify(await createApprovedPackage(run)),
    JSON.stringify(value),
  );
});

test("pending, queued, failed and rejected runs cannot be exported", async () => {
  const waiting = simulation();
  const queued = createQueuedRun(
    { ...input, mode: "ollama" },
    { id: "queued-run", now, model: "local-model" },
  );
  const rejected = decideRun(
    waiting,
    {
      decision: "reject",
      fingerprint: waiting.proposal!.fingerprint,
      revision: waiting.revision,
    },
    approvedAt,
    actor,
  );
  for (const run of [
    waiting,
    queued,
    { ...queued, status: "failed" as const },
    rejected,
  ]) {
    await assert.rejects(
      createApprovedPackage(run),
      (error: unknown) =>
        error instanceof OutboxError && error.code === "OUTBOX_NOT_APPROVED",
    );
  }
});

test("tampered artifact, action approval, evidence or event data fails closed", async () => {
  const approved = live();
  const invalid: Run[] = [
    {
      ...approved,
      artifact: {
        ...approved.artifact!,
        content: approved.artifact!.content.trim(),
      },
    },
    {
      ...approved,
      decision: { ...approved.decision!, fingerprint: "0".repeat(64) },
    },
    {
      ...approved,
      decision: { ...approved.decision!, revision: approved.revision },
    },
    {
      ...approved,
      evidence: {
        ...approved.evidence!,
        items: [
          {
            ...approved.evidence!.items[0]!,
            text: "Unreviewed replacement excerpt",
          },
        ],
      },
    },
    {
      ...approved,
      events: approved.events.map((event, index) =>
        index === 0 ? { ...event, sequence: 100 } : event,
      ),
    },
    { ...approved, workspaceId: "other-workspace" } as unknown as Run,
  ];
  for (const run of invalid)
    await assert.rejects(
      createApprovedPackage(run),
      (error: unknown) =>
        error instanceof OutboxError &&
        error.code === "OUTBOX_INVALID_ARTIFACT",
    );
});
