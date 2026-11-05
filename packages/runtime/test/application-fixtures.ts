import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  createDevelopmentRun,
  withDevelopmentEvent,
  validateDevelopmentCandidate,
  developmentReviewFingerprint,
  decideDevelopmentRun,
  developmentProfileFingerprintInput,
} from "@vuzmi/core";
import type { DevelopmentProfile, DevelopmentRun } from "@vuzmi/core";
import {
  developmentFixtureInput,
  developmentFixtureProfile,
  developmentFixturePatch,
  developmentFixtureReceipt,
  digest,
} from "./development-fixtures.js";
export const applicationActor = {
  id: "application-fixture-owner",
  name: "Synthetic owner",
};
export function approvedApplicationFixture(
  profile: DevelopmentProfile = developmentFixtureProfile,
): DevelopmentRun {
  const now = "2026-11-05T20:00:00.000Z",
    runId = randomUUID(),
    attemptId = randomUUID();
  let run = createDevelopmentRun(developmentFixtureInput(), profile, {
    id: runId,
    now,
    actor: applicationActor.id,
    hash: digest,
  });
  const candidate = validateDevelopmentCandidate(
    developmentFixturePatch,
    profile,
    digest,
  );
  const receipt = (phase: "baseline" | "candidate") =>
    developmentFixtureReceipt(
      {
        runId,
        attemptId,
        phase,
        executionId: `vuzmi-dev-${runId}-${attemptId}-${phase}`,
        ...(phase === "candidate" ? { candidate } : {}),
      },
      {
        profileHash: profile.profileHash,
        baseImageId: profile.baseImage,
        imageId: profile.baseImage,
      },
    );
  run = withDevelopmentEvent(
    run,
    "fixture.checks",
    "Synthetic receipt fixture; no inference or check process ran.",
    now,
    {
      status: "running",
      stage: "checking",
      candidate,
      baseline: receipt("baseline"),
      checks: receipt("candidate"),
      routeExecuted: true,
      modelDigest: "synthetic-digest",
      usage: { inputTokens: 1, outputTokens: 2, durationMs: 1 },
    },
  );
  run = withDevelopmentEvent(
    run,
    "development.review_requested",
    "Synthetic package awaits fixture review.",
    now,
    {
      status: "waiting_approval",
      stage: "review",
      reviewFingerprint: developmentReviewFingerprint(run, digest),
    },
  );
  return decideDevelopmentRun(
    run,
    {
      decision: "approve",
      revision: run.revision,
      fingerprint: run.reviewFingerprint!,
    },
    now,
    applicationActor,
    digest,
  );
}
export const gitFixtureCommand = (
  path: string,
  args: string[],
  input?: string,
) =>
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-C",
      path,
      ...args,
    ],
    {
      input,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@vuzmi.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@vuzmi.invalid",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
export async function applicationGitFixture() {
  const directory = await mkdtemp(join(tmpdir(), "vuzmi-application-test-"));
  gitFixtureCommand(directory, ["init", "--initial-branch=main"]);
  gitFixtureCommand(directory, [
    "remote",
    "add",
    "origin",
    "git@github.com:Ether-X-UK/Vuzmi.git",
  ]);
  const file = developmentFixtureProfile.files[0];
  await mkdir(dirname(join(directory, file.path)), { recursive: true });
  await writeFile(join(directory, file.path), file.text);
  await writeFile(
    join(directory, "untouched.txt"),
    "Preserve this unrelated tracked file.\n",
  );
  gitFixtureCommand(directory, ["add", "."]);
  gitFixtureCommand(directory, [
    "commit",
    "-m",
    "Synthetic application baseline",
  ]);
  const baseCommit = gitFixtureCommand(directory, ["rev-parse", "HEAD"]).trim();
  const unsigned = { ...developmentFixtureProfile, baseCommit };
  const profile = {
    ...unsigned,
    profileHash: digest(developmentProfileFingerprintInput(unsigned)),
  };
  const snapshot = async () => ({
    head: gitFixtureCommand(directory, ["rev-parse", "HEAD"]),
    status: gitFixtureCommand(directory, ["status", "--porcelain=v1", "-uall"]),
    index: await readFile(join(directory, ".git/index")),
    file: await readFile(join(directory, file.path)),
    untouched: await readFile(join(directory, "untouched.txt")),
  });
  return {
    directory,
    profile,
    run: approvedApplicationFixture(profile),
    snapshot,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
