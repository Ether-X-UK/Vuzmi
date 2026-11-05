import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  attachEvidence,
  claimGeneration,
  completeGeneration,
  createApprovedPackage,
  createQueuedRun,
  decideRun,
  extractDraftBody,
  githubFileUrl,
  githubOriginSchema,
  githubPreviewFingerprintInput,
  githubPreviewInputSchema,
  parseRunIntegrity,
  renderDraftDocument,
  type EvidenceSnapshot,
  type GithubOrigin,
} from "../src/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = "2026-11-05T15:00:00.000Z";
const text = "Vuzmi saves reviewed local artifacts.";
const sourceId = "10000000-0000-4000-8000-000000000001";
const origin: GithubOrigin = {
  kind: "github-public",
  repositoryId: 1234,
  owner: "Ether-X-UK",
  repository: "Vuzmi",
  path: "docs/PRODUCT.md",
  gitHashAlgorithm: "sha1",
  commitOid: "a".repeat(40),
  blobOid: "b".repeat(40),
  rawSha256: sha(text),
  rawBytes: Buffer.byteLength(text),
  normalizedSha256: sha(text),
  normalizedBytes: Buffer.byteLength(text),
  normalizationVersion: "plain-text-v1",
  fetchedAt: now,
};
const evidence: EvidenceSnapshot = {
  status: "matched",
  query: "Vuzmi artifacts",
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
      text,
      contentHash: sha(text),
      score: 0.8,
    },
  ],
};

test("GitHub contracts require bounded exact paths, fixed repository and immutable SHA-1 commits", () => {
  const input = {
    title: "Product policy",
    commit: "a".repeat(40),
    path: "docs/PRODUCT.md",
  };
  assert.ok(githubPreviewInputSchema.safeParse(input).success);
  for (const path of [
    "../README.md",
    "/README.md",
    "docs//A.md",
    "docs/./A.md",
    "a%2fb.md",
    "a\\b.md",
    "https://host/a.md",
    "a/b/c/d/e/f/g/h/i.md",
    "a.svg",
  ])
    assert.equal(
      githubPreviewInputSchema.safeParse({ ...input, path }).success,
      false,
      path,
    );
  for (const commit of ["main", "a".repeat(7), "a".repeat(64)])
    assert.equal(
      githubPreviewInputSchema.safeParse({ ...input, commit }).success,
      false,
    );
  assert.equal(
    githubOriginSchema.safeParse({ ...origin, owner: "other" }).success,
    false,
  );
  assert.equal(
    githubOriginSchema.safeParse({ ...origin, rawBytes: 65_537 }).success,
    false,
  );
  assert.equal(
    githubFileUrl(origin),
    `https://github.com/Ether-X-UK/Vuzmi/blob/${"a".repeat(40)}/docs/PRODUCT.md`,
  );
});

test("preview fingerprint binds identity, expiry, title, text and every origin field", () => {
  const preview = {
    previewId: sourceId,
    expiresAt: now,
    title: "Product policy",
    format: "markdown" as const,
    text,
    origin,
  };
  const fingerprint = sha(githubPreviewFingerprintInput(preview));
  const variants = [
    { ...preview, previewId: "20000000-0000-4000-8000-000000000001" },
    { ...preview, expiresAt: "2026-11-05T16:00:00.000Z" },
    { ...preview, title: "Changed policy" },
    { ...preview, text: text + " Changed." },
    { ...preview, origin: { ...origin, blobOid: "c".repeat(40) } },
    { ...preview, origin: { ...origin, rawSha256: "c".repeat(64) } },
  ];
  for (const variant of variants)
    assert.notEqual(sha(githubPreviewFingerprintInput(variant)), fingerprint);
  assert.equal(
    sha(githubPreviewFingerprintInput({ ...preview, fingerprint })),
    fingerprint,
  );
});

test("legacy canonical reference bytes remain fixed when no GitHub origin exists", () => {
  const document = renderDraftDocument("Reviewed local plan. [S1]", evidence);
  assert.equal(
    sha(document),
    "fdfba053fa4fe718b26b2c02bef792dcb1a6a9bee7d567fae57ef316be4a2a40",
  );
  assert.equal(
    extractDraftBody(document, evidence),
    "Reviewed local plan. [S1]",
  );
  assert.equal(document.includes('"origin"'), false);
});

test("GitHub provenance survives run recovery and approved export, with appendix tampering rejected", async () => {
  const retained = { ...evidence, items: [{ ...evidence.items[0]!, origin }] };
  let run = claimGeneration(
    createQueuedRun(
      {
        title: "Provenance release",
        brief: "Prepare an evidence grounded local release plan.",
        domain: "build",
        mode: "ollama",
        knowledge: { sourceIds: [sourceId], memoryIds: [] },
      },
      { id: "provenance-run", now, model: "fixture-local-model" },
    ),
    { attemptId: "a1", now },
  )!;
  run = attachEvidence(run, {
    attemptId: "a1",
    expectedRevision: run.revision,
    evidence: retained,
    now,
  })!;
  run = completeGeneration(run, {
    attemptId: "a1",
    expectedRevision: run.revision,
    now,
    fingerprint: sha,
    content: renderDraftDocument("Reviewed local plan. [S1]", retained),
    usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
  })!;
  run = decideRun(
    run,
    {
      decision: "approve",
      fingerprint: run.proposal!.fingerprint,
      revision: run.revision,
    },
    now,
    { id: "fixture-owner", name: "Fixture owner" },
  );
  const restored = parseRunIntegrity(JSON.parse(JSON.stringify(run)), sha);
  const exported = await createApprovedPackage(restored);
  assert.deepEqual(exported.evidence!.items[0]!.origin, origin);
  assert.equal(
    exported.documents[0].sha256,
    sha(exported.documents[0].content),
  );
  assert.ok(exported.documents[0].content.includes(origin.commitOid));
  assert.ok(exported.documents[0].content.includes(origin.rawSha256));
  for (const nextOrigin of [
    { ...origin, commitOid: "c".repeat(40) },
    undefined,
  ]) {
    const tampered = {
      ...run,
      evidence: {
        ...retained,
        items: [{ ...retained.items[0]!, origin: nextOrigin }],
      },
    };
    assert.throws(() => parseRunIntegrity(tampered, sha), /reference record/);
    await assert.rejects(
      createApprovedPackage(tampered),
      /differs from its recorded integrity/,
    );
  }
});
