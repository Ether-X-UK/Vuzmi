import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_REGRESSION_PATHS,
  DEVELOPMENT_REGRESSION_CHECK_FILES,
  DEVELOPMENT_REGRESSION_CHECK_NAMES,
  DEVELOPMENT_REGRESSION_COMMAND,
  developmentProfileSchema,
  developmentAcceptanceFingerprintInput,
  developmentProfileFingerprintInput,
  developmentBaselineAccepted,
  developmentBaselineReproduced,
  developmentCandidatePassed,
  developmentCheckLogsInput,
  createDevelopmentRun,
  validateDevelopmentCandidate,
  developmentReviewFingerprint,
  decideDevelopmentRun,
  parseDevelopmentIntegrity,
  withDevelopmentEvent,
  type DevelopmentProfile,
  type DevelopmentCheck,
} from "../src/index.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const now = "2026-11-05T20:00:00.000Z";
function profile(): DevelopmentProfile {
  const unsigned = {
    id: "web-client-regressions" as const,
    version: 1 as const,
    repository: "Ether-X-UK/Vuzmi" as const,
    baseCommit: "a".repeat(40),
    files: DEVELOPMENT_REGRESSION_PATHS.map((path, i) => {
      const text = `export const fixture${i} = "before";\n`;
      return { path, sha256: hash(text), text };
    }),
    command: [
      ...DEVELOPMENT_REGRESSION_COMMAND,
    ] as DevelopmentProfile["command"],
    acceptanceHash: "0".repeat(64),
    lockfileHash: "b".repeat(64),
    baseImage: `sha256:${"c".repeat(64)}`,
    platform: "linux/arm64" as const,
    policyId: "owned-repository-offline-v1" as const,
    sourceTree: "d".repeat(40),
    sourceArchiveSha256: "e".repeat(64),
    checkFiles: DEVELOPMENT_REGRESSION_CHECK_FILES.map((path) => ({
      path,
      sha256: "f".repeat(64),
    })),
    checkNames: [...DEVELOPMENT_REGRESSION_CHECK_NAMES],
    baselineExpectation: "green" as const,
    checkHarnessSha256: "1".repeat(64),
  };
  unsigned.acceptanceHash = hash(
    developmentAcceptanceFingerprintInput(unsigned),
  );
  return developmentProfileSchema.parse({
    ...unsigned,
    profileHash: hash(developmentProfileFingerprintInput(unsigned)),
  });
}
function patch(p: DevelopmentProfile) {
  return {
    summary: "Change two synthetic declarations for an owned task.",
    files: [p.files[2], p.files[0]].map((file) => ({
      path: file.path,
      beforeSha256: file.sha256,
      content: file.text.replace("before", "after"),
    })),
  };
}
function receipt(
  p: DevelopmentProfile,
  phase: "baseline" | "candidate",
  candidate: string | null,
): DevelopmentCheck {
  const logs = {
    stdout: "Synthetic fixture; no process executed.",
    stderr: "",
    truncated: false,
  };
  return {
    executionId: `vuzmi-dev-${randomUUID()}-${phase}`,
    phase,
    startedAt: now,
    finishedAt: now,
    imageId: p.baseImage,
    baseImageId: p.baseImage,
    profileHash: p.profileHash,
    candidateFingerprint: candidate,
    status: "passed",
    started: true,
    exitCode: 0,
    durationMs: 1,
    ...logs,
    logsSha256: hash(developmentCheckLogsInput(logs)),
    command: p.command,
    policyVerified: true,
    tests: DEVELOPMENT_REGRESSION_CHECK_NAMES.map((name) => ({
      name,
      passed: true,
    })),
  };
}

test("reusable profiles reject command, path, legacy-policy and incomplete-manifest substitutions", () => {
  const p = profile();
  assert.equal(hash(developmentProfileFingerprintInput(p)), p.profileHash);
  for (const bad of [
    { ...p, command: DEVELOPMENT_COMMAND },
    { ...p, sourceTree: undefined },
    { ...p, checkHarnessSha256: undefined },
    { ...p, baselineExpectation: undefined },
    { ...p, checkNames: p.checkNames!.slice(1) },
    { ...p, files: [...p.files].reverse() },
    { ...p, id: "web-api-status-authority" },
    { ...p, checkFiles: [...p.checkFiles!].reverse() },
  ])
    assert.equal(developmentProfileSchema.safeParse(bad).success, false);
});

test("multi-file replacement is canonical, scoped and requires every returned file to change", () => {
  const p = profile(),
    proposal = patch(p);
  const candidate = validateDevelopmentCandidate(proposal, p, hash);
  assert.deepEqual(
    candidate.files.map((f) => f.path),
    [p.files[0].path, p.files[2].path],
  );
  assert.equal((candidate.diff.match(/^diff --git /gm) ?? []).length, 2);
  assert.deepEqual(
    validateDevelopmentCandidate(
      { ...proposal, files: [...proposal.files].reverse() },
      p,
      hash,
    ),
    candidate,
  );
  const corruptContext = structuredClone(p);
  corruptContext.files[1].text +=
    "// Unapproved context outside the changed subset.\n";
  assert.throws(() =>
    validateDevelopmentCandidate(proposal, corruptContext, hash),
  );
  for (const files of [
    [proposal.files[0], proposal.files[0]],
    [{ ...proposal.files[0], path: "packages/core/src/index.ts" }],
    [{ ...proposal.files[0], beforeSha256: "0".repeat(64) }],
    [{ ...proposal.files[0], content: p.files[2].text }],
    [{ ...proposal.files[0], content: "invalid\ud800 text" }],
    [
      ...proposal.files,
      {
        path: p.files[1].path,
        beforeSha256: p.files[1].sha256,
        content: p.files[1].text,
      },
    ],
  ])
    assert.throws(() =>
      validateDevelopmentCandidate({ ...proposal, files }, p, hash),
    );
});

test("aggregate replacement budgets cannot be bypassed with individually bounded files", () => {
  const p = profile();
  assert.throws(() =>
    validateDevelopmentCandidate(
      {
        summary: "Oversized aggregate replacement fixture.",
        files: p.files.map((f) => ({
          path: f.path,
          beforeSha256: f.sha256,
          content: "a".repeat(9000),
        })),
      },
      p,
      hash,
    ),
  );
  assert.equal(
    developmentProfileSchema.safeParse({
      ...p,
      files: p.files.map((f) => ({ ...f, text: "a".repeat(9000) })),
    }).success,
    false,
  );
});

test("green baseline and candidate require all nineteen registered results with intact execution policy", () => {
  const p = profile(),
    baseline = receipt(p, "baseline", null),
    checks = receipt(p, "candidate", "a".repeat(64));
  assert.equal(developmentBaselineAccepted(baseline, p), true);
  assert.equal(developmentBaselineReproduced(baseline), false);
  assert.equal(developmentCandidatePassed(checks, p), true);
  assert.equal(developmentCandidatePassed(checks), false);
  for (const mutation of [
    { status: "failed" as const, exitCode: 1 },
    { truncated: true },
    { policyVerified: false },
    { tests: baseline.tests.slice(1) },
    { tests: [...baseline.tests, baseline.tests[0]] },
    {
      tests: baseline.tests.map((t, i) =>
        i === 2 ? { ...t, passed: false } : t,
      ),
    },
    {
      tests: baseline.tests.map((t, i) =>
        i === 2 ? { ...t, name: "model invented check" } : t,
      ),
    },
  ])
    assert.equal(
      developmentBaselineAccepted({ ...baseline, ...mutation }, p),
      false,
    );
});

test("approval binds the whole reusable context and preserves the saved artifact across parsing", () => {
  const p = profile(),
    candidate = validateDevelopmentCandidate(patch(p), p, hash);
  let run = createDevelopmentRun(
    {
      requestId: randomUUID(),
      title: "Owned reusable task",
      brief: "A bounded synthetic task requiring two changes.",
      model: "fixture-local",
      profileHash: p.profileHash,
    },
    p,
    { id: randomUUID(), now, actor: "fixture-owner", hash },
  );
  run = withDevelopmentEvent(
    run,
    "fixture.checks",
    "Synthetic results only.",
    now,
    {
      status: "running",
      stage: "checking",
      candidate,
      routeExecuted: true,
      modelDigest: "fixture-digest",
      usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      baseline: receipt(p, "baseline", null),
      checks: receipt(p, "candidate", candidate.fingerprint),
    },
  );
  run = withDevelopmentEvent(
    run,
    "fixture.review",
    "Synthetic review only.",
    now,
    {
      status: "waiting_approval",
      stage: "review",
      reviewFingerprint: developmentReviewFingerprint(run, hash),
    },
  );
  const saved = decideDevelopmentRun(
    run,
    {
      decision: "approve",
      revision: run.revision,
      fingerprint: run.reviewFingerprint!,
    },
    now,
    { id: "fixture-owner" },
    hash,
  );
  assert.equal(
    parseDevelopmentIntegrity(JSON.parse(JSON.stringify(saved)), hash).artifact!
      .content,
    saved.artifact!.content,
  );
  const altered = structuredClone(saved);
  altered.profile.files[1].text += "// unapproved context\n";
  assert.throws(() => parseDevelopmentIntegrity(altered, hash));
  const alteredChecks = structuredClone(saved);
  alteredChecks.checks!.tests[0].passed = false;
  assert.throws(() => parseDevelopmentIntegrity(alteredChecks, hash));
});
