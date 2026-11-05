import { createHash, randomUUID } from "node:crypto";
import {
  createDevelopmentApplication,
  createDevelopmentApplicationPlan,
  createDevelopmentRun,
  decideDevelopmentRun,
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_PATH,
  DEVELOPMENT_REGRESSION_CHECK_FILES,
  DEVELOPMENT_REGRESSION_CHECK_NAMES,
  DEVELOPMENT_REGRESSION_COMMAND,
  DEVELOPMENT_REGRESSION_PATHS,
  developmentAcceptanceFingerprintInput,
  developmentCheckLogsInput,
  developmentCheckNames,
  developmentProfileFingerprintInput,
  developmentReviewFingerprint,
  validateDevelopmentCandidate,
  withDevelopmentEvent,
  withDevelopmentApplicationEvent,
  type DevelopmentApplication,
  type DevelopmentCheck,
  type DevelopmentProfile,
  type DevelopmentRun,
  type DevelopmentRuntime,
} from "@vuzmi/core";

export const fixtureHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const fixtureTime = "2026-11-05T12:00:00.000Z";
export function uiProfile(
  reusable = false,
  baseCommit = "a".repeat(40),
): DevelopmentProfile {
  const profile: DevelopmentProfile = {
    id: reusable ? "web-client-regressions" : "web-api-status-authority",
    version: 1,
    repository: "Ether-X-UK/Vuzmi",
    baseCommit,
    files: (reusable ? DEVELOPMENT_REGRESSION_PATHS : [DEVELOPMENT_PATH]).map(
      (path, index) => {
        const text = `export const source${index} = true;\n`;
        return { path, text, sha256: fixtureHash(text) };
      },
    ),
    command: reusable
      ? [...DEVELOPMENT_REGRESSION_COMMAND]
      : [...DEVELOPMENT_COMMAND],
    acceptanceHash: "b".repeat(64),
    lockfileHash: "c".repeat(64),
    baseImage: `sha256:${"d".repeat(64)}`,
    platform: "linux/arm64",
    policyId: "owned-repository-offline-v1",
    profileHash: "e".repeat(64),
    ...(reusable
      ? {
          sourceTree: "f".repeat(40),
          sourceArchiveSha256: "a".repeat(64),
          checkFiles: DEVELOPMENT_REGRESSION_CHECK_FILES.map((path) => ({
            path,
            sha256: "b".repeat(64),
          })),
          checkNames: [...DEVELOPMENT_REGRESSION_CHECK_NAMES],
          baselineExpectation: "green" as const,
          checkHarnessSha256: "f".repeat(64),
        }
      : {}),
  };
  if (reusable)
    profile.acceptanceHash = fixtureHash(
      developmentAcceptanceFingerprintInput(profile),
    );
  profile.profileHash = fixtureHash(
    developmentProfileFingerprintInput(profile),
  );
  return profile;
}
export function uiRuntime(
  profile = uiProfile(),
  profiles?: DevelopmentProfile[],
): DevelopmentRuntime {
  return {
    ready: true,
    checkedAt: fixtureTime,
    reason: null,
    profile,
    profiles,
    defaultModel: "fixture-local",
  };
}
export function uiWaitingRun(reusable = false): DevelopmentRun {
  const profile = uiProfile(reusable),
    id = randomUUID();
  let run = createDevelopmentRun(
    {
      requestId: randomUUID(),
      title: "Synthetic task fixture",
      brief: "Verify exact review and scope boundaries with synthetic data.",
      model: "fixture-local",
      profileHash: profile.profileHash,
    },
    profile,
    { id, actor: "fixture-owner", now: fixtureTime, hash: fixtureHash },
  );
  const file = profile.files[0];
  const candidate = validateDevelopmentCandidate(
    {
      summary: "A synthetic replacement for a review-state fixture.",
      files: [
        {
          path: file.path,
          beforeSha256: file.sha256,
          content: "export const corrected = true;\n",
        },
      ],
    },
    profile,
    fixtureHash,
  );
  const receipt = (phase: "baseline" | "candidate"): DevelopmentCheck => {
    const baselineFails = phase === "baseline" && !reusable;
    const logs = {
      stdout: "Synthetic trusted-check fixture. No process executed.\n",
      stderr: "",
      truncated: false,
    };
    return {
      executionId: `vuzmi-dev-${id}-${phase}`,
      phase,
      startedAt: fixtureTime,
      finishedAt: fixtureTime,
      imageId:
        phase === "baseline" ? profile.baseImage : `sha256:${"e".repeat(64)}`,
      baseImageId: profile.baseImage,
      profileHash: profile.profileHash,
      candidateFingerprint:
        phase === "candidate" ? candidate.fingerprint : null,
      status: baselineFails ? "failed" : "passed",
      started: true,
      exitCode: baselineFails ? 1 : 0,
      durationMs: 10,
      ...logs,
      logsSha256: fixtureHash(developmentCheckLogsInput(logs)),
      command: profile.command,
      policyVerified: true,
      tests: developmentCheckNames(profile).map((name, index) => ({
        name,
        passed: !baselineFails || index >= 2,
      })),
    };
  };
  run = withDevelopmentEvent(
    run,
    "fixture.checks",
    "Synthetic checks retained.",
    fixtureTime,
    {
      status: "running",
      stage: "checking",
      routeExecuted: true,
      modelDigest: "fixture-model-digest",
      usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
      candidate,
      baseline: receipt("baseline"),
      checks: receipt("candidate"),
    },
  );
  return withDevelopmentEvent(
    run,
    "development.review_requested",
    "Synthetic exact package awaits review.",
    fixtureTime,
    {
      status: "waiting_approval",
      stage: "review",
      reviewFingerprint: developmentReviewFingerprint(run, fixtureHash),
    },
  );
}
export function uiApprovedRun(reusable = false): DevelopmentRun {
  const run = uiWaitingRun(reusable);
  return decideDevelopmentRun(
    run,
    {
      decision: "approve",
      revision: run.revision,
      fingerprint: run.reviewFingerprint!,
    },
    fixtureTime,
    { id: "fixture-owner" },
    fixtureHash,
  );
}
export function uiApplication(run = uiApprovedRun()): DevelopmentApplication {
  const plan = createDevelopmentApplicationPlan(
    run,
    "a".repeat(64),
    fixtureHash,
  );
  return createDevelopmentApplication(
    plan,
    {
      requestId: randomUUID(),
      packageSha256: plan.packageSha256,
      planFingerprint: plan.fingerprint,
    },
    {
      id: randomUUID(),
      actor: { id: "fixture-owner" },
      now: fixtureTime,
      hash: fixtureHash,
    },
  );
}
export function uiAppliedApplication(
  run = uiApprovedRun(),
): DevelopmentApplication {
  let operation = uiApplication(run);
  const prepared = {
    treeOid: "b".repeat(40),
    commitOid: "c".repeat(40),
    files: operation.plan.files.map((file) => ({
      ...file,
      mode: "100644" as const,
    })),
  };
  operation = withDevelopmentApplicationEvent(
    operation,
    "application.started",
    "Synthetic operation claimed.",
    fixtureTime,
    {
      status: "running",
      workerId: randomUUID(),
      attemptId: randomUUID(),
      prepared,
    },
  );
  return withDevelopmentApplicationEvent(
    operation,
    "application.applied",
    "Synthetic local branch receipt retained.",
    fixtureTime,
    {
      status: "applied",
      receipt: {
        applicationId: operation.id,
        runId: run.id,
        repositoryIdentity: operation.plan.repositoryIdentity,
        packageSha256: operation.plan.packageSha256,
        baseCommit: operation.plan.baseCommit,
        destinationRef: operation.plan.destinationRef,
        ...prepared,
        actor: operation.actor,
        authorizedAt: operation.authorizedAt,
        appliedAt: fixtureTime,
      },
    },
  );
}
