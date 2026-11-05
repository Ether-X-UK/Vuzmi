import { createHash, randomUUID } from "node:crypto";
import {
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_CHECK_NAMES,
  DEVELOPMENT_PATH,
  developmentCheckLogsInput,
  developmentProfileFingerprintInput,
} from "@vuzmi/core";
import type {
  DevelopmentCheck,
  DevelopmentProfile,
  DevelopmentInput,
  DevelopmentPatchInput,
} from "@vuzmi/core";
import type { DevelopmentRunnerAdapter } from "../src/development-worker.js";

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const text =
  "export async function request() { return 'synthetic baseline'; }\n";
const unsigned = {
  id: "web-api-status-authority" as const,
  version: 1 as const,
  repository: "Ether-X-UK/Vuzmi" as const,
  baseCommit: "a7d088e4954f848da392eed91684dfb445d5ce45",
  files: [{ path: DEVELOPMENT_PATH, sha256: digest(text), text }] as const,
  command: DEVELOPMENT_COMMAND,
  acceptanceHash: "2".repeat(64),
  lockfileHash: "3".repeat(64),
  baseImage: `sha256:${"1".repeat(64)}`,
  platform: "linux/arm64" as const,
  policyId: "owned-repository-offline-v1" as const,
};
export const developmentFixtureProfile: DevelopmentProfile = {
  ...unsigned,
  files: [...unsigned.files],
  command: [...DEVELOPMENT_COMMAND],
  profileHash: digest(
    developmentProfileFingerprintInput({
      ...unsigned,
      files: [...unsigned.files],
      command: [...DEVELOPMENT_COMMAND],
    }),
  ),
};
export const developmentFixtureInput = (): DevelopmentInput => ({
  requestId: randomUUID(),
  title: "Repair web session expiry",
  brief:
    "Expire the owner session on status401 even when the JSON body is unreadable.",
  model: "qwen3.5:4b",
});
export const developmentFixturePatch: DevelopmentPatchInput = {
  summary:
    "A synthetic replacement used only to exercise durable workflow boundaries.",
  files: [
    {
      path: DEVELOPMENT_PATH,
      beforeSha256: digest(text),
      content:
        "export async function request() { return 'synthetic corrected response'; }\n",
    },
  ],
};
export const developmentFixtureReceipt = (
  input: Parameters<DevelopmentRunnerAdapter["run"]>[0],
  overrides: Partial<DevelopmentCheck> = {},
): DevelopmentCheck => {
  const now = new Date().toISOString();
  const receipt: DevelopmentCheck = {
    executionId: input.executionId,
    phase: input.phase,
    startedAt: now,
    finishedAt: now,
    imageId: developmentFixtureProfile.baseImage,
    baseImageId: developmentFixtureProfile.baseImage,
    profileHash: developmentFixtureProfile.profileHash,
    candidateFingerprint: input.candidate?.fingerprint ?? null,
    status: input.phase === "baseline" ? "failed" : "passed",
    started: true,
    exitCode: input.phase === "baseline" ? 1 : 0,
    durationMs: 1,
    stdout: "Synthetic fixture: no container or model was executed.",
    stderr: "",
    truncated: false,
    logsSha256: "0".repeat(64),
    command: [...DEVELOPMENT_COMMAND],
    policyVerified: true,
    tests: DEVELOPMENT_CHECK_NAMES.map((name, index) => ({
      name,
      passed: input.phase === "candidate" || index >= 2,
    })),
    ...overrides,
  };
  receipt.logsSha256 = digest(developmentCheckLogsInput(receipt));
  return receipt;
};
export const developmentFixtureRunner = (): DevelopmentRunnerAdapter => ({
  readiness: async () => ({
    ready: true,
    reason: "Synthetic isolated-test fixture.",
    profile: developmentFixtureProfile,
  }),
  run: async (input) => developmentFixtureReceipt(input),
  cleanup: async () => true,
});
