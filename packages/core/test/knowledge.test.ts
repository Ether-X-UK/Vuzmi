import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  sourceInputSchema,
  evidenceSelectionSchema,
  createRunSchema,
  createQueuedRun,
  claimGeneration,
  attachEvidence,
  completeGeneration,
  parseRunIntegrity,
} from "../src/index.js";
import type { EvidenceSnapshot } from "../src/index.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = "2026-11-04T22:00:00.000Z";
const sourceId = "10000000-0000-4000-8000-000000000001";
const selection = { sourceIds: [sourceId], memoryIds: [] };
const input = {
  title: "Evidence bound release",
  brief: "Prepare a release from the selected product evidence.",
  domain: "build" as const,
  mode: "ollama" as const,
  knowledge: selection,
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
      title: "Product scope",
      revision: 1,
      chunkIndex: 0,
      lineStart: 1,
      lineEnd: 1,
      text: "The alpha prepares a reviewed local artifact.",
      contentHash: sha("The alpha prepares a reviewed local artifact."),
      score: 0.8,
    },
  ],
};
test("knowledge contracts bound actual UTF-8 bytes and require explicit nonduplicate live selections", () => {
  assert.equal(
    sourceInputSchema.safeParse({
      title: "Source",
      format: "markdown",
      text: "x".repeat(65_537),
    }).success,
    false,
  );
  assert.equal(
    sourceInputSchema.safeParse({
      title: "Source",
      format: "text",
      text: "界".repeat(22_000),
    }).success,
    false,
  );
  assert.equal(
    evidenceSelectionSchema.safeParse({ sourceIds: [], memoryIds: [] }).success,
    false,
  );
  assert.equal(
    evidenceSelectionSchema.safeParse({
      sourceIds: [sourceId, sourceId],
      memoryIds: [],
    }).success,
    false,
  );
  assert.equal(
    createRunSchema.safeParse({ ...input, mode: "simulation" }).success,
    false,
  );
  assert.equal(createRunSchema.safeParse(input).success, true);
});
test("required evidence is fenced, retained unchanged across recovery, and protects acceptance", () => {
  const queued = createQueuedRun(input, {
    id: "evidence-run",
    now,
    model: "local-model",
  });
  const running = claimGeneration(queued, { attemptId: "a1", now })!;
  assert.throws(
    () =>
      completeGeneration(running, {
        attemptId: "a1",
        expectedRevision: running.revision,
        content: "Unsupported draft",
        usage: { inputTokens: null, outputTokens: null, durationMs: null },
        now,
        fingerprint: sha,
      }),
    /Required evidence/,
  );
  assert.equal(
    attachEvidence(running, {
      attemptId: "obsolete",
      expectedRevision: running.revision,
      evidence,
      now,
    }),
    undefined,
  );
  const attached = attachEvidence(running, {
    attemptId: "a1",
    expectedRevision: running.revision,
    evidence,
    now,
  })!;
  assert.deepEqual(attached.evidence, evidence);
  assert.equal(attached.revision, running.revision + 1);
  assert.equal(
    attachEvidence(attached, {
      attemptId: "a1",
      expectedRevision: attached.revision,
      evidence: { ...evidence, query: "changed" },
      now,
    }),
    attached,
  );
  const draft = completeGeneration(attached, {
    attemptId: "a1",
    expectedRevision: attached.revision,
    content: "Scope is a local artifact [S1].",
    usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
    now,
    fingerprint: sha,
  })!;
  assert.equal(parseRunIntegrity(draft, sha).status, "waiting_approval");
  const corrupted = structuredClone(draft);
  corrupted.evidence!.items[0]!.text = "Tampered excerpt";
  assert.throws(() => parseRunIntegrity(corrupted, sha), /evidence passage/);
});
