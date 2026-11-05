import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createDevelopmentRun,
  DEVELOPMENT_CHECK_NAMES,
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_PATH,
  developmentProfileFingerprintInput,
  validateDevelopmentCandidate,
  type DevelopmentCheck,
  type DevelopmentProfile,
  type DevelopmentRun,
} from "@vuzmi/core";
import {
  acknowledgeDevelopmentReview,
  captureDevelopmentDecision,
  confirmDevelopmentRefresh,
  createDevelopmentReview,
  developmentVersion,
  mergeDevelopmentRuns,
  openDevelopmentReview,
  receiveDevelopmentRun,
  requireDevelopmentRefresh,
} from "../src/developmentReview";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const now = "2026-11-05T12:00:00.000Z";
const profile: DevelopmentProfile = {
  id: "web-api-status-authority",
  version: 1,
  repository: "Ether-X-UK/Vuzmi",
  baseCommit: "a".repeat(40),
  files: [
    {
      path: DEVELOPMENT_PATH,
      sha256: hash("export const original = true;\n"),
      text: "export const original = true;\n",
    },
  ],
  command: [...DEVELOPMENT_COMMAND],
  acceptanceHash: "b".repeat(64),
  lockfileHash: "c".repeat(64),
  baseImage: `sha256:${"d".repeat(64)}`,
  platform: "linux/arm64",
  policyId: "owned-repository-offline-v1",
  profileHash: "e".repeat(64),
};
profile.profileHash = hash(developmentProfileFingerprintInput(profile));
function receipt(phase: "baseline" | "candidate"): DevelopmentCheck {
  return {
    executionId: `vuzmi-dev-fixture-${phase}`,
    phase,
    startedAt: now,
    finishedAt: now,
    imageId: profile.baseImage,
    baseImageId: profile.baseImage,
    profileHash: profile.profileHash,
    candidateFingerprint: phase === "candidate" ? "f".repeat(64) : null,
    status: phase === "baseline" ? "failed" : "passed",
    started: true,
    exitCode: phase === "baseline" ? 1 : 0,
    durationMs: 100,
    stdout: "Synthetic receipt for a review-state test.",
    stderr: "",
    truncated: false,
    logsSha256: "a".repeat(64),
    command: [...DEVELOPMENT_COMMAND],
    policyVerified: true,
    tests: DEVELOPMENT_CHECK_NAMES.map((name, index) => ({
      name,
      passed: phase === "candidate" || index >= 2,
    })),
  };
}
function fixture(
  revision = 7,
  fingerprint = "a".repeat(64),
  id = "72fdcf03-7338-4ebf-a6d3-ed5480423765",
): DevelopmentRun {
  const base = createDevelopmentRun(
    {
      requestId: "5fdc7ed3-63c5-4463-b47b-b7a98327a0cb",
      title: "Review fixture",
      brief: "Synthetic brief for review-state boundaries.",
      model: "fixture-local-model",
    },
    profile,
    { id, now, actor: "fixture-owner", hash },
  );
  return {
    ...base,
    revision,
    status: "waiting_approval",
    stage: "review",
    reviewFingerprint: fingerprint,
    routeExecuted: true,
    candidate: validateDevelopmentCandidate(
      {
        summary: "A synthetic permitted file replacement.",
        files: [
          {
            path: DEVELOPMENT_PATH,
            beforeSha256: profile.files[0].sha256,
            content: "export const corrected = true;\n",
          },
        ],
      },
      profile,
      hash,
    ),
    baseline: receipt("baseline"),
    checks: receipt("candidate"),
  };
}
function acknowledge(run: DevelopmentRun) {
  const opened = openDevelopmentReview(createDevelopmentReview(run), run.id);
  return acknowledgeDevelopmentReview(opened, developmentVersion(run)!);
}

test("first review requires deliberately opening and acknowledging the exact package", () => {
  const run = fixture(),
    state = createDevelopmentReview(run),
    shown = developmentVersion(run)!;
  assert.equal(captureDevelopmentDecision(state, shown, "approve"), null);
  assert.equal(
    captureDevelopmentDecision(
      acknowledgeDevelopmentReview(state, shown),
      shown,
      "approve",
    ),
    null,
  );
  const opened = openDevelopmentReview(state, run.id);
  assert.equal(captureDevelopmentDecision(opened, shown, "reject"), null);
  assert.deepEqual(
    captureDevelopmentDecision(acknowledge(run), shown, "approve"),
    {
      id: run.id,
      input: {
        decision: "approve",
        revision: run.revision,
        fingerprint: run.reviewFingerprint,
      },
    },
  );
});

test("polled replacement stays separate from displayed A; a B acknowledgment cannot authorize C", () => {
  const a = fixture(),
    b = fixture(8, "b".repeat(64)),
    c = fixture(9, "c".repeat(64));
  const replaced = receiveDevelopmentRun(acknowledge(a), b);
  assert.equal(replaced.displayed, a);
  assert.equal(replaced.latest, b);
  assert.equal(
    captureDevelopmentDecision(replaced, developmentVersion(a), "approve"),
    null,
  );
  const openedB = openDevelopmentReview(replaced, a.id);
  const arrivedC = receiveDevelopmentRun(openedB, c);
  assert.equal(arrivedC.displayed, b);
  assert.equal(
    acknowledgeDevelopmentReview(arrivedC, developmentVersion(b)!).acknowledged,
    null,
  );
  const openedC = openDevelopmentReview(arrivedC, a.id);
  assert.ok(
    captureDevelopmentDecision(
      acknowledgeDevelopmentReview(openedC, developmentVersion(c)!),
      developmentVersion(c),
      "reject",
    ),
  );
});

test("a revision change invalidates acknowledgment even if the review fingerprint is unchanged", () => {
  const a = fixture(),
    changed = fixture(8);
  const state = receiveDevelopmentRun(acknowledge(a), changed);
  assert.equal(state.acknowledged, null);
  assert.equal(
    captureDevelopmentDecision(state, developmentVersion(changed), "approve"),
    null,
  );
});

test("route identity resets synchronously and can never reuse another run acknowledgment", () => {
  const a = fixture(),
    other = fixture(7, "a".repeat(64), "2d68beea-8f2e-4a63-bd07-c5b933ed19ac");
  const state = receiveDevelopmentRun(acknowledge(a), other);
  assert.equal(state.displayed.id, other.id);
  assert.equal(state.opened, null);
  assert.equal(
    captureDevelopmentDecision(state, developmentVersion(other), "approve"),
    null,
  );
  assert.equal(openDevelopmentReview(state, a.id), state);
});

test("uncertain decisions need explicit refresh and a new open/ack, not a background poll", () => {
  const run = fixture();
  const uncertain = requireDevelopmentRefresh(acknowledge(run));
  const polled = receiveDevelopmentRun(uncertain, { ...run });
  assert.equal(polled.refreshRequired, true);
  assert.equal(openDevelopmentReview(polled, run.id), polled);
  assert.equal(
    captureDevelopmentDecision(polled, developmentVersion(run), "approve"),
    null,
  );
  const refreshed = confirmDevelopmentRefresh(polled, run);
  assert.equal(refreshed.refreshRequired, false);
  assert.equal(
    captureDevelopmentDecision(refreshed, developmentVersion(run), "approve"),
    null,
  );
  const opened = openDevelopmentReview(refreshed, run.id);
  assert.ok(
    captureDevelopmentDecision(
      acknowledgeDevelopmentReview(opened, developmentVersion(run)!),
      developmentVersion(run),
      "approve",
    ),
  );
});

test("terminal observations disable decisions and stale polling cannot reopen them", () => {
  const run = fixture();
  const finished: DevelopmentRun = {
    ...run,
    status: "completed",
    stage: "finished",
    revision: 8,
  };
  const state = receiveDevelopmentRun(acknowledge(run), finished);
  assert.equal(state.displayed, finished);
  assert.equal(
    captureDevelopmentDecision(state, developmentVersion(run), "approve"),
    null,
  );
  assert.equal(receiveDevelopmentRun(state, run), state);
  assert.equal(receiveDevelopmentRun(state, { ...run, revision: 9 }), state);
});

test("a captured in-flight decision keeps exact A arguments after a later B arrives", () => {
  const a = fixture(),
    b = fixture(8, "b".repeat(64));
  const state = acknowledge(a),
    captured = captureDevelopmentDecision(
      state,
      developmentVersion(a),
      "approve",
    )!;
  const replacement = receiveDevelopmentRun(state, b);
  assert.equal(captured.input.revision, a.revision);
  assert.equal(captured.input.fingerprint, a.reviewFingerprint);
  assert.equal(
    captureDevelopmentDecision(replacement, developmentVersion(b), "approve"),
    null,
  );
});

test("list merges preserve newer and terminal records against stale responses", () => {
  const a = fixture(),
    b = fixture(8, "b".repeat(64));
  assert.equal(mergeDevelopmentRuns([b], [a])[0], b);
  const terminal: DevelopmentRun = {
    ...b,
    status: "cancelled",
    stage: "finished",
    revision: 9,
  };
  assert.equal(
    mergeDevelopmentRuns([terminal], [{ ...b, revision: 10 }])[0],
    terminal,
  );
  const invalidBaseline = {
    ...a,
    baseline: { ...a.baseline!, tests: a.baseline!.tests.slice(1) },
  };
  assert.equal(developmentVersion(invalidBaseline), null);
});
