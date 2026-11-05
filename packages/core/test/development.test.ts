import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  DEVELOPMENT_PATH,
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_CHECK_NAMES,
  createDevelopmentRun,
  developmentProfileFingerprintInput,
  developmentCheckLogsInput,
  validateDevelopmentCandidate,
  withDevelopmentEvent,
  developmentReviewFingerprint,
  developmentReview,
  decideDevelopmentRun,
  parseDevelopmentIntegrity,
  developmentPackageSchema,
  type DevelopmentProfile,
  type DevelopmentCheck,
  type DevelopmentRun,
} from "../src/index.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = "2026-11-05T16:00:00.000Z";
const text = 'export const fixture = "before";\n';
const profileBase = {
  id: "web-api-status-authority" as const,
  version: 1 as const,
  repository: "Ether-X-UK/Vuzmi" as const,
  baseCommit: "a".repeat(40),
  files: [{ path: DEVELOPMENT_PATH, sha256: hash(text), text }] as [
    DevelopmentProfile["files"][0],
  ],
  command: [...DEVELOPMENT_COMMAND] as DevelopmentProfile["command"],
  acceptanceHash: "b".repeat(64),
  lockfileHash: "c".repeat(64),
  baseImage: `sha256:${"d".repeat(64)}`,
  platform: "linux/arm64" as const,
  policyId: "owned-repository-offline-v1" as const,
};
const profile: DevelopmentProfile = {
  ...profileBase,
  profileHash: hash(developmentProfileFingerprintInput(profileBase)),
};
const input = () => ({
  requestId: randomUUID(),
  title: "Fix fixture handling",
  brief: "Repair the owned API session expiry task.",
  model: "fixture-local",
});
function waiting(): DevelopmentRun {
  let run = createDevelopmentRun(input(), profile, {
    id: randomUUID(),
    now,
    actor: "fixture-owner",
    hash,
  });
  const candidate = validateDevelopmentCandidate(
    {
      summary: "Replace the fixture declaration.",
      files: [
        {
          path: DEVELOPMENT_PATH,
          beforeSha256: hash(text),
          content: 'export const fixture = "after";\n',
        },
      ],
    },
    profile,
    hash,
  );
  const receipt = (phase: "baseline" | "candidate"): DevelopmentCheck => {
    const logs = {
      stdout: "Synthetic sealed-check fixture; no process executed.\n",
      stderr: "",
      truncated: false,
    };
    return {
      executionId: `vuzmi-dev-${randomUUID()}-${phase}`,
      phase,
      startedAt: now,
      finishedAt: now,
      imageId:
        phase === "baseline" ? profile.baseImage : `sha256:${"e".repeat(64)}`,
      baseImageId: profile.baseImage,
      profileHash: profile.profileHash,
      candidateFingerprint: phase === "baseline" ? null : candidate.fingerprint,
      status: phase === "baseline" ? "failed" : "passed",
      started: true,
      exitCode: phase === "baseline" ? 1 : 0,
      durationMs: 10,
      ...logs,
      logsSha256: hash(developmentCheckLogsInput(logs)),
      command: profile.command,
      policyVerified: true,
      tests: DEVELOPMENT_CHECK_NAMES.map((name, i) => ({
        name,
        passed: phase === "candidate" || i >= 2,
      })),
    };
  };
  run = withDevelopmentEvent(
    run,
    "fixture.checks",
    "Synthetic check receipts retained.",
    now,
    {
      status: "running",
      stage: "checking",
      routeExecuted: true,
      modelDigest: "fixture-digest",
      usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      candidate,
      baseline: receipt("baseline"),
      checks: receipt("candidate"),
    },
  );
  return withDevelopmentEvent(
    run,
    "development.review_requested",
    "Exact fixture package requires review.",
    now,
    {
      status: "waiting_approval",
      stage: "review",
      reviewFingerprint: developmentReviewFingerprint(run, hash),
    },
  );
}
test("development proposal permits only the exact bounded baseline replacement and produces a real unified diff", () => {
  const proposal = {
    summary: "Replace the fixture declaration.",
    files: [
      {
        path: DEVELOPMENT_PATH,
        beforeSha256: hash(text),
        content: 'export const fixture = "after";\n',
      },
    ],
  };
  const candidate = validateDevelopmentCandidate(proposal, profile, hash);
  assert.match(candidate.diff, /--- a\/apps\/web\/src\/api.ts/);
  assert.match(candidate.diff, /-export const fixture = "before";/);
  assert.match(candidate.diff, /\+export const fixture = "after";/);
  assert.equal(candidate.files[0].afterSha256, hash(proposal.files[0].content));
  for (const bad of [
    { ...proposal, command: "curl attacker.invalid" },
    { ...proposal, files: [{ ...proposal.files[0], path: "../api.ts" }] },
    {
      ...proposal,
      files: [{ ...proposal.files[0], beforeSha256: "0".repeat(64) }],
    },
    { ...proposal, files: [{ ...proposal.files[0], content: text }] },
    {
      ...proposal,
      files: [{ ...proposal.files[0], content: "bad\u0000".repeat(10) }],
    },
    {
      ...proposal,
      files: [{ ...proposal.files[0], content: "bad\ud800".repeat(10) }],
    },
    {
      ...proposal,
      files: [{ ...proposal.files[0], content: "界".repeat(6000) }],
    },
    { ...proposal, files: [proposal.files[0], proposal.files[0]] },
  ])
    assert.throws(() => validateDevelopmentCandidate(bad, profile, hash));
  const noNewline = validateDevelopmentCandidate(
    {
      ...proposal,
      files: [
        { ...proposal.files[0], content: 'export const fixture = "after";' },
      ],
    },
    profile,
    hash,
  );
  assert.match(noNewline.diff, /\\ No newline at end of file/);
});
test("review and artifact bind actual baseline/candidate receipts, model and immutable scope; exact decisions replay", () => {
  const run = waiting();
  assert.deepEqual(
    parseDevelopmentIntegrity(JSON.parse(JSON.stringify(run)), hash),
    run,
  );
  const decision = {
    decision: "approve" as const,
    revision: run.revision,
    fingerprint: run.reviewFingerprint!,
  };
  const approved = decideDevelopmentRun(
    run,
    decision,
    now,
    { id: "fixture-owner", name: "Fixture owner" },
    hash,
  );
  const restored = parseDevelopmentIntegrity(
    JSON.parse(JSON.stringify(approved)),
    hash,
  );
  const pkg = developmentPackageSchema.parse(
    JSON.parse(restored.artifact!.content),
  );
  assert.deepEqual(pkg.review, developmentReview(run));
  assert.equal(pkg.approval.actor, "fixture-owner");
  assert.equal(
    pkg.review.scope,
    "Save this reviewed local package. The actual checkout is unchanged.",
  );
  assert.equal(approved.artifact!.sha256, hash(approved.artifact!.content));
  assert.deepEqual(
    decideDevelopmentRun(
      approved,
      decision,
      now,
      { id: "fixture-owner" },
      hash,
    ),
    approved,
  );
  assert.throws(() =>
    decideDevelopmentRun(
      run,
      { ...decision, revision: run.revision - 1 },
      now,
      { id: "fixture-owner" },
      hash,
    ),
  );
  assert.throws(() =>
    decideDevelopmentRun(
      approved,
      decision,
      now,
      { id: "different-owner" },
      hash,
    ),
  );
  const rejected = decideDevelopmentRun(
    run,
    { ...decision, decision: "reject" },
    now,
    { id: "fixture-owner" },
    hash,
  );
  assert.equal(rejected.status, "cancelled");
  assert.equal(rejected.artifact, undefined);
});
test("false or incomplete passing checks, altered profiles/logs/diffs and terminal artifacts fail integrity", () => {
  const run = waiting();
  const variants = [
    { ...run, checks: { ...run.checks!, policyVerified: false } },
    { ...run, checks: { ...run.checks!, tests: [] } },
    { ...run, checks: { ...run.checks!, stdout: "Replaced logs" } },
    {
      ...run,
      checks: { ...run.checks!, candidateFingerprint: "0".repeat(64) },
    },
    { ...run, baseline: { ...run.baseline!, status: "passed" } },
    {
      ...run,
      baseline: {
        ...run.baseline!,
        tests: run.baseline!.tests.map((x) => ({ ...x, passed: false })),
      },
    },
    { ...run, profile: { ...run.profile, baseCommit: "f".repeat(40) } },
    { ...run, candidate: { ...run.candidate!, diff: "Replaced patch" } },
    { ...run, routeExecuted: false },
    { ...run, execution: { id: "late-container", phase: "candidate" } },
  ];
  for (const value of variants)
    assert.throws(() => parseDevelopmentIntegrity(value, hash));
  const approved = decideDevelopmentRun(
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
  assert.throws(() =>
    parseDevelopmentIntegrity(
      {
        ...approved,
        artifact: {
          ...approved.artifact!,
          content: approved.artifact!.content + " ",
        },
      },
      hash,
    ),
  );
});
