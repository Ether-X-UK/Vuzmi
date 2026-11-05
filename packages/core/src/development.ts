import { z } from "zod";
import type { DecisionInput, RunEvent, Usage } from "./index.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const imageSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const date = z.string().datetime();
export const DEVELOPMENT_PATH = "apps/web/src/api.ts" as const;
export const DEVELOPMENT_REGRESSION_PATHS = [
  DEVELOPMENT_PATH,
  "apps/web/src/draftSession.ts",
  "apps/web/src/proposalReview.ts",
] as const;
export const DEVELOPMENT_REGRESSION_CHECK_FILES = [
  "apps/web/test/api-session-expiry.test.ts",
  "apps/web/test/draft-session.test.ts",
  "apps/web/test/proposal-review.test.ts",
] as const;
export const DEVELOPMENT_REGRESSION_CHECK_NAMES = [
  "an unreadable 401 invalidates the session before body decoding",
  "a malformed 401 invalidates the session exactly once",
  "a stalled 401 body cannot postpone session invalidation",
  "a readable 401 preserves its structured error and expires once",
  "unreadable non-401 failures do not invalidate the session",
  "successful JSON is preserved without invalidating the session",
  "connection failure remains distinct from session expiry",
  "transient draft recovery preserves exact input and fences owner, origin, and run",
  "late save settlement cannot clear changed input or a replacement session",
  "sign-out awaits the active discard guard and cannot silently drop an inactive correction",
  "unchanged initial proposals retain normal exact-version decision behavior",
  "poll replacement preserves A and blocks both decisions until B is opened and acknowledged",
  "C arriving during B acknowledgment invalidates B without replacing its displayed text",
  "an acknowledged B is invalidated by either revision or fingerprint changes",
  "409 recovery stays blocked even if refresh fails or returns the same proposal",
  "captured requests remain bound to A while later observations require new review",
  "run switches reject old click/ack arguments and late older responses cannot reopen terminal review",
  "initial queued generation adopts its first proposal without treating it as a replacement",
  "a terminal rejection replaces the pinned document and cannot be acknowledged into another decision",
] as const;
export const DEVELOPMENT_CHECK_NAMES = [
  "unreadable 401 expires the session before body parsing",
  "malformed 401 expires the session before body parsing",
  "readable 401 expires the session once",
  "unreadable non-401 does not expire the session",
  "successful JSON response is preserved",
  "connection failure stays distinct from session expiry",
] as const;
export const DEVELOPMENT_COMMAND = [
  "/usr/local/bin/node",
  "--import",
  "tsx",
  "--test",
  "/opt/vuzmi/checks/web-api-status-authority.test.ts",
] as const;
const legacyCommandSchema = z.tuple([
  z.literal("/usr/local/bin/node"),
  z.literal("--import"),
  z.literal("tsx"),
  z.literal("--test"),
  z.literal("/opt/vuzmi/checks/web-api-status-authority.test.ts"),
]);
export const DEVELOPMENT_REGRESSION_COMMAND = [
  "/usr/local/bin/node",
  "--import",
  "tsx",
  "--test",
  "/opt/vuzmi/checks/web-client-regressions.test.ts",
] as const;
const commandSchema = z.union([
  legacyCommandSchema,
  z.tuple([
    z.literal(DEVELOPMENT_REGRESSION_COMMAND[0]),
    z.literal(DEVELOPMENT_REGRESSION_COMMAND[1]),
    z.literal(DEVELOPMENT_REGRESSION_COMMAND[2]),
    z.literal(DEVELOPMENT_REGRESSION_COMMAND[3]),
    z.literal(DEVELOPMENT_REGRESSION_COMMAND[4]),
  ]),
]);
function validText(text: string): boolean {
  return (
    !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text) &&
    new TextDecoder().decode(new TextEncoder().encode(text)) === text
  );
}
const codeText = z
  .string()
  .min(10)
  .max(16_000)
  .refine(
    (s) => validText(s) && new TextEncoder().encode(s).length <= 16_384,
    "Provide bounded valid UTF-8 code with LF line endings.",
  );
export const developmentInputSchema = z
  .object({
    requestId: z.string().uuid(),
    title: z.string().trim().min(3).max(120),
    brief: z.string().trim().min(10).max(3000),
    model: z.string().trim().min(1).max(200),
    issueNumber: z.number().int().positive().max(10_000_000).optional(),
    profileHash: hashSchema.optional(),
  })
  .strict();
export type DevelopmentInput = z.infer<typeof developmentInputSchema>;
export const developmentFileSchema = z
  .object({
    path: z.enum(DEVELOPMENT_REGRESSION_PATHS),
    sha256: hashSchema,
    text: codeText,
  })
  .strict();
const profileShape = z
  .object({
    id: z.enum(["web-api-status-authority", "web-client-regressions"]),
    version: z.literal(1),
    repository: z.literal("Ether-X-UK/Vuzmi"),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    files: z.array(developmentFileSchema).min(1).max(3),
    command: commandSchema,
    acceptanceHash: hashSchema,
    lockfileHash: hashSchema,
    baseImage: imageSchema,
    platform: z.enum(["linux/arm64", "linux/amd64"]),
    policyId: z.literal("owned-repository-offline-v1"),
    profileHash: hashSchema,
    sourceTree: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    sourceArchiveSha256: hashSchema.optional(),
    checkFiles: z
      .array(
        z
          .object({
            path: z.enum(DEVELOPMENT_REGRESSION_CHECK_FILES),
            sha256: hashSchema,
          })
          .strict(),
      )
      .length(3)
      .optional(),
    checkNames: z.array(z.string().min(1).max(200)).length(19).optional(),
    baselineExpectation: z.literal("green").optional(),
    checkHarnessSha256: hashSchema.optional(),
  })
  .strict();
export const developmentProfileSchema = profileShape.superRefine(
  (profile, ctx) => {
    const legacy = profile.id === "web-api-status-authority";
    const expectedCommand = legacy
      ? DEVELOPMENT_COMMAND
      : DEVELOPMENT_REGRESSION_COMMAND;
    const paths = legacy ? [DEVELOPMENT_PATH] : DEVELOPMENT_REGRESSION_PATHS;
    if (
      JSON.stringify(profile.command) !== JSON.stringify(expectedCommand) ||
      JSON.stringify(profile.files.map((f) => f.path)) !== JSON.stringify(paths)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "The registered profile must retain its exact permitted paths and command.",
      });
    if (legacy) {
      if (
        [
          profile.sourceTree,
          profile.sourceArchiveSha256,
          profile.checkFiles,
          profile.checkNames,
          profile.baselineExpectation,
          profile.checkHarnessSha256,
        ].some((value) => value !== undefined)
      )
        ctx.addIssue({
          code: "custom",
          message: "Legacy profile semantics cannot be changed.",
        });
    } else if (
      !profile.sourceTree ||
      !profile.sourceArchiveSha256 ||
      profile.baselineExpectation !== "green" ||
      !profile.checkHarnessSha256 ||
      JSON.stringify(profile.checkFiles?.map((f) => f.path)) !==
        JSON.stringify(DEVELOPMENT_REGRESSION_CHECK_FILES) ||
      JSON.stringify(profile.checkNames) !==
        JSON.stringify(DEVELOPMENT_REGRESSION_CHECK_NAMES)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Reusable profiles require the complete immutable source and regression manifest.",
      });
    if (
      profile.files.reduce(
        (bytes, f) => bytes + new TextEncoder().encode(f.text).length,
        0,
      ) > 24_576
    )
      ctx.addIssue({
        code: "custom",
        message: "The complete source context exceeds the profile byte budget.",
      });
  },
);
export type DevelopmentProfile = z.infer<typeof developmentProfileSchema>;
export function developmentProfileFingerprintInput(
  value: Omit<DevelopmentProfile, "profileHash"> | DevelopmentProfile,
): string {
  const { profileHash: _hash, ...unsigned } = value as DevelopmentProfile;
  const parsed = profileShape.omit({ profileHash: true }).parse(unsigned);
  return JSON.stringify(parsed);
}
export function developmentCheckNames(
  profile: DevelopmentProfile,
): readonly string[] {
  return profile.id === "web-api-status-authority"
    ? DEVELOPMENT_CHECK_NAMES
    : DEVELOPMENT_REGRESSION_CHECK_NAMES;
}
export function developmentAcceptanceFingerprintInput(
  profile: Pick<
    DevelopmentProfile,
    "checkFiles" | "checkNames" | "command" | "checkHarnessSha256"
  >,
): string {
  return JSON.stringify({
    version: 1,
    files: profile.checkFiles,
    names: profile.checkNames,
    command: profile.command,
    harnessSha256: profile.checkHarnessSha256,
  });
}
export const developmentIssueSchema = z
  .object({
    id: z.number().int().positive().safe(),
    number: z.number().int().positive().max(10_000_000),
    title: z.string().min(1).max(256),
    body: z.string().max(8000),
    url: z
      .string()
      .regex(/^https:\/\/github\.com\/Ether-X-UK\/Vuzmi\/issues\/[1-9][0-9]*$/),
    updatedAt: date,
    fetchedAt: date,
  })
  .strict();
export type DevelopmentIssue = z.infer<typeof developmentIssueSchema>;
export const developmentPatchInputSchema = z
  .object({
    summary: z.string().trim().min(10).max(1200),
    files: z
      .array(
        z
          .object({
            path: z.enum(DEVELOPMENT_REGRESSION_PATHS),
            beforeSha256: hashSchema,
            content: codeText,
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type DevelopmentPatchInput = z.infer<typeof developmentPatchInputSchema>;
export const developmentCandidateSchema = z
  .object({
    summary: z.string().min(10).max(1200),
    files: z
      .array(
        z
          .object({
            path: z.enum(DEVELOPMENT_REGRESSION_PATHS),
            beforeSha256: hashSchema,
            afterSha256: hashSchema,
            content: codeText,
          })
          .strict(),
      )
      .min(1)
      .max(3),
    diff: z.string().min(1).max(120_000),
    fingerprint: hashSchema,
  })
  .strict();
export type DevelopmentCandidate = z.infer<typeof developmentCandidateSchema>;
export const developmentCheckSchema = z
  .object({
    executionId: z.string().regex(/^vuzmi-dev-[a-z0-9-]{1,140}$/),
    phase: z.enum(["baseline", "candidate"]),
    startedAt: date,
    finishedAt: date,
    imageId: imageSchema,
    baseImageId: imageSchema,
    profileHash: hashSchema,
    candidateFingerprint: hashSchema.nullable(),
    status: z.enum([
      "passed",
      "failed",
      "timed_out",
      "oom_killed",
      "cancelled",
      "unavailable",
    ]),
    started: z.boolean(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
    stdout: z.string().max(65_536),
    stderr: z.string().max(65_536),
    truncated: z.boolean(),
    logsSha256: hashSchema,
    command: commandSchema,
    policyVerified: z.boolean(),
    tests: z
      .array(
        z.object({ name: z.string().max(200), passed: z.boolean() }).strict(),
      )
      .max(20),
  })
  .strict();
export type DevelopmentCheck = z.infer<typeof developmentCheckSchema>;
export type CheckReceipt = DevelopmentCheck;
export const developmentRuntimeSchema = z
  .object({
    ready: z.boolean(),
    checkedAt: date,
    reason: z.string().nullable(),
    profile: developmentProfileSchema.nullable(),
    defaultModel: z.string(),
    profiles: z.array(developmentProfileSchema).max(16).optional(),
  })
  .strict();
export type DevelopmentRuntime = z.infer<typeof developmentRuntimeSchema>;
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  durationMs: z.number().nonnegative().nullable(),
});
const eventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.string(),
  occurredAt: date,
  message: z.string(),
});
const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  revision: z.number().int().positive(),
  fingerprint: hashSchema,
  actor: z.string().min(1),
  actorName: z.string().optional(),
  decidedAt: date,
});
export const developmentReviewSchema = z.object({
  kind: z.literal("save_local_development_package"),
  workflow: z.object({
    id: z.literal("development-patch"),
    version: z.literal(1),
  }),
  runId: z.string().uuid(),
  workspaceId: z.literal("local-workspace"),
  title: z.string(),
  brief: z.string(),
  issue: developmentIssueSchema.nullable(),
  profile: developmentProfileSchema,
  model: z.string(),
  modelDigest: z.string().nullable(),
  usage: usageSchema.nullable(),
  candidate: developmentCandidateSchema,
  baseline: developmentCheckSchema,
  checks: developmentCheckSchema,
  scope: z.literal(
    "Save this reviewed local package. The actual checkout is unchanged.",
  ),
});
export type DevelopmentReview = z.infer<typeof developmentReviewSchema>;
export const developmentPackageSchema = z.object({
  schemaVersion: z.literal(1),
  review: developmentReviewSchema,
  approval: decisionSchema,
  events: z.array(eventSchema),
  savedAt: date,
});
export type DevelopmentPackage = z.infer<typeof developmentPackageSchema>;
export const developmentRunSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.literal("local-workspace"),
  workflow: z.object({
    id: z.literal("development-patch"),
    version: z.literal(1),
  }),
  requestId: z.string().uuid(),
  requestFingerprint: hashSchema,
  createdBy: z.string(),
  title: z.string(),
  brief: z.string(),
  issue: developmentIssueSchema.nullable(),
  profile: developmentProfileSchema,
  model: z.string(),
  modelDigest: z.string().nullable(),
  usage: usageSchema.nullable(),
  routeExecuted: z.boolean(),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
  ]),
  stage: z.enum(["baseline", "generating", "checking", "review", "finished"]),
  revision: z.number().int().positive(),
  createdAt: date,
  updatedAt: date,
  events: z.array(eventSchema),
  candidate: developmentCandidateSchema.nullable(),
  baseline: developmentCheckSchema.nullable(),
  checks: developmentCheckSchema.nullable(),
  reviewFingerprint: hashSchema.nullable(),
  attemptId: z.string().uuid().optional(),
  workerId: z.string().optional(),
  execution: z
    .object({ id: z.string(), phase: z.enum(["baseline", "candidate"]) })
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  decision: decisionSchema.optional(),
  artifact: z
    .object({ content: z.string(), sha256: hashSchema, savedAt: date })
    .optional(),
});
export type DevelopmentRun = z.infer<typeof developmentRunSchema>;
export class DevelopmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
type Hash = (text: string) => string;
export function developmentCheckLogsInput(
  receipt: Pick<DevelopmentCheck, "stdout" | "stderr" | "truncated">,
): string {
  return JSON.stringify({
    stdout: receipt.stdout,
    stderr: receipt.stderr,
    truncated: receipt.truncated,
  });
}
function unifiedFile(path: string, before: string, after: string): string {
  const lines = (text: string, sign: string) => {
    const split = text.split("\n");
    if (text.endsWith("\n")) split.pop();
    return {
      count: split.length,
      body:
        split.map((line) => sign + line).join("\n") +
        "\n" +
        (text.endsWith("\n") ? "" : "\\ No newline at end of file\n"),
    };
  };
  const left = lines(before, "-"),
    right = lines(after, "+");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${left.count} +1,${right.count} @@\n${left.body}${right.body}`;
}
export function validateDevelopmentCandidate(
  value: unknown,
  profile: DevelopmentProfile,
  hash: Hash,
): DevelopmentCandidate {
  const result = developmentPatchInputSchema.safeParse(value);
  if (!result.success)
    throw new DevelopmentError(
      "INVALID_PATCH",
      "The model did not return a bounded replacement for the permitted file.",
      422,
    );
  profile = developmentProfileSchema.parse(profile);
  if (
    hash(developmentProfileFingerprintInput(profile)) !== profile.profileHash ||
    profile.files.some((file) => hash(file.text) !== file.sha256) ||
    (profile.id === "web-client-regressions" &&
      hash(developmentAcceptanceFingerprintInput(profile)) !==
        profile.acceptanceHash)
  )
    throw new DevelopmentError(
      "DEVELOPMENT_INTEGRITY",
      "The exact source profile or its trusted regression manifest could not be verified.",
    );
  const byPath = new Map(profile.files.map((file) => [file.path, file]));
  const paths = new Set<string>();
  if (
    result.data.files.some((file) => {
      const base = byPath.get(file.path);
      const invalid =
        !base ||
        paths.has(file.path) ||
        file.beforeSha256 !== base.sha256 ||
        hash(base.text) !== base.sha256 ||
        file.content === base.text;
      paths.add(file.path);
      return invalid;
    }) ||
    result.data.files.reduce(
      (bytes, f) => bytes + new TextEncoder().encode(f.content).length,
      0,
    ) > 24_576
  )
    throw new DevelopmentError(
      "INVALID_PATCH",
      "The proposed changes are empty, duplicated, oversized or do not match the pinned permitted files.",
      422,
    );
  const files = profile.files.flatMap((base) => {
    const file = result.data.files.find((file) => file.path === base.path);
    return file ? [{ ...file, afterSha256: hash(file.content) }] : [];
  });
  const unsigned = {
    summary: result.data.summary,
    files,
    diff: files
      .map((file) =>
        unifiedFile(file.path, byPath.get(file.path)!.text, file.content),
      )
      .join(""),
  };
  return developmentCandidateSchema.parse({
    ...unsigned,
    fingerprint: hash(JSON.stringify(unsigned)),
  });
}
export function createDevelopmentRun(
  input: DevelopmentInput,
  profile: DevelopmentProfile,
  context: {
    id: string;
    now: string;
    actor: string;
    issue?: DevelopmentIssue | null;
    hash: Hash;
  },
): DevelopmentRun {
  const value = developmentInputSchema.parse(input);
  if (value.profileHash && value.profileHash !== profile.profileHash)
    throw new DevelopmentError(
      "DEVELOPMENT_PROFILE_CHANGED",
      "The displayed source profile does not match the pinned task. Review the exact context before starting.",
      409,
    );
  return developmentRunSchema.parse({
    id: context.id,
    workspaceId: "local-workspace",
    workflow: { id: "development-patch", version: 1 },
    requestId: value.requestId,
    requestFingerprint: context.hash(JSON.stringify(value)),
    createdBy: context.actor,
    title: value.title,
    brief: value.brief,
    issue: context.issue ?? null,
    profile,
    model: value.model,
    modelDigest: null,
    usage: null,
    routeExecuted: false,
    status: "queued",
    stage: "baseline",
    revision: 1,
    createdAt: context.now,
    updatedAt: context.now,
    events: [
      {
        sequence: 1,
        type: "development.queued",
        occurredAt: context.now,
        message:
          "Pinned task and permitted code context were queued for isolated development checks.",
      },
    ],
    candidate: null,
    baseline: null,
    checks: null,
    reviewFingerprint: null,
  });
}
type Transition = Partial<
  Pick<
    DevelopmentRun,
    | "status"
    | "stage"
    | "attemptId"
    | "workerId"
    | "execution"
    | "baseline"
    | "candidate"
    | "checks"
    | "modelDigest"
    | "usage"
    | "error"
    | "reviewFingerprint"
    | "routeExecuted"
  >
>;
export function withDevelopmentEvent(
  run: DevelopmentRun,
  type: string,
  message: string,
  now: string,
  changes: Transition,
): DevelopmentRun {
  return {
    ...run,
    ...changes,
    revision: run.revision + 1,
    updatedAt: now,
    events: [
      ...run.events,
      { sequence: run.events.length + 1, type, message, occurredAt: now },
    ],
  };
}
export function developmentReview(run: DevelopmentRun): DevelopmentReview {
  if (
    !run.candidate ||
    !run.baseline ||
    !run.checks ||
    !developmentCandidatePassed(run.checks, run.profile) ||
    !developmentBaselineAccepted(run.baseline, run.profile) ||
    !run.routeExecuted ||
    !run.modelDigest ||
    !run.usage ||
    run.execution
  )
    throw new DevelopmentError(
      "DEVELOPMENT_NOT_REVIEWABLE",
      "A validated patch, the registered baseline result and passing isolated candidate checks are required.",
    );
  return developmentReviewSchema.parse({
    kind: "save_local_development_package",
    workflow: run.workflow,
    runId: run.id,
    workspaceId: run.workspaceId,
    title: run.title,
    brief: run.brief,
    issue: run.issue,
    profile: run.profile,
    model: run.model,
    modelDigest: run.modelDigest,
    usage: run.usage,
    candidate: run.candidate,
    baseline: run.baseline,
    checks: run.checks,
    scope:
      "Save this reviewed local package. The actual checkout is unchanged.",
  });
}
export function developmentBaselineReproduced(
  check: DevelopmentCheck,
): boolean {
  return (
    check.phase === "baseline" &&
    check.status === "failed" &&
    check.started &&
    check.policyVerified &&
    !check.truncated &&
    check.exitCode !== null &&
    check.exitCode !== 0 &&
    check.tests.length === DEVELOPMENT_CHECK_NAMES.length &&
    DEVELOPMENT_CHECK_NAMES.every(
      (name, index) =>
        check.tests.filter((t) => t.name === name && t.passed === index >= 2)
          .length === 1,
    )
  );
}
function passingDevelopmentCheck(
  check: DevelopmentCheck,
  names: readonly string[],
): boolean {
  return (
    check.status === "passed" &&
    check.started &&
    check.policyVerified &&
    !check.truncated &&
    check.exitCode === 0 &&
    check.tests.length === names.length &&
    names.every(
      (name) =>
        check.tests.filter((t) => t.name === name && t.passed).length === 1,
    )
  );
}
export function developmentBaselineAccepted(
  check: DevelopmentCheck,
  profile: DevelopmentProfile,
): boolean {
  return profile.id === "web-api-status-authority"
    ? developmentBaselineReproduced(check)
    : check.phase === "baseline" &&
        passingDevelopmentCheck(check, developmentCheckNames(profile));
}
export function developmentCandidatePassed(
  check: DevelopmentCheck,
  profile?: DevelopmentProfile,
): boolean {
  return (
    check.phase === "candidate" &&
    passingDevelopmentCheck(
      check,
      profile ? developmentCheckNames(profile) : DEVELOPMENT_CHECK_NAMES,
    )
  );
}
export const developmentReviewFingerprint = (
  run: DevelopmentRun,
  hash: Hash,
): string => hash(JSON.stringify(developmentReview(run)));
export function decideDevelopmentRun(
  run: DevelopmentRun,
  input: DecisionInput,
  now: string,
  actor: { id: string; name?: string },
  hash: Hash,
): DevelopmentRun {
  run = parseDevelopmentIntegrity(run, hash);
  if (run.decision) {
    if (
      run.decision.revision === input.revision &&
      run.decision.fingerprint === input.fingerprint &&
      run.decision.decision === input.decision &&
      run.decision.actor === actor.id
    )
      return run;
    throw new DevelopmentError(
      "ALREADY_DECIDED",
      "This development package already has a different decision.",
    );
  }
  if (
    run.status !== "waiting_approval" ||
    run.revision !== input.revision ||
    run.reviewFingerprint !== input.fingerprint ||
    developmentReviewFingerprint(run, hash) !== input.fingerprint
  )
    throw new DevelopmentError(
      "STALE_APPROVAL",
      "Review the current exact development package before deciding.",
    );
  const approval = {
    ...input,
    actor: actor.id,
    ...(actor.name ? { actorName: actor.name } : {}),
    decidedAt: now,
  };
  const event = (type: string, message: string, offset: number): RunEvent => ({
    sequence: run.events.length + offset,
    type,
    message,
    occurredAt: now,
  });
  const events = [
    ...run.events,
    event(
      input.decision === "approve"
        ? "development.approved"
        : "development.rejected",
      input.decision === "approve"
        ? "Owner approved the exact local development package."
        : "Owner rejected the development package; no approved artifact was saved.",
      1,
    ),
  ];
  if (input.decision === "approve")
    events.push(
      event(
        "development.artifact_saved",
        "The reviewed patch and observed checks were saved locally; the actual checkout is unchanged.",
        2,
      ),
    );
  const next: DevelopmentRun = {
    ...run,
    status: input.decision === "approve" ? "completed" : "cancelled",
    stage: "finished",
    revision: run.revision + 1,
    updatedAt: now,
    decision: approval,
    events,
  };
  if (input.decision === "approve") {
    const content =
      JSON.stringify(
        developmentPackageSchema.parse({
          schemaVersion: 1,
          review: developmentReview(run),
          approval,
          events,
          savedAt: now,
        }),
        null,
        2,
      ) + "\n";
    next.artifact = { content, sha256: hash(content), savedAt: now };
  }
  return next;
}
export function parseDevelopmentIntegrity(
  value: unknown,
  hash: Hash,
): DevelopmentRun {
  const run = developmentRunSchema.parse(value);
  const invalid = () => {
    throw new DevelopmentError(
      "DEVELOPMENT_INTEGRITY",
      "The retained development package or its evidence could not be verified.",
    );
  };
  if (
    hash(developmentProfileFingerprintInput(run.profile)) !==
      run.profile.profileHash ||
    run.profile.files.some((file) => hash(file.text) !== file.sha256) ||
    (run.profile.id === "web-client-regressions" &&
      hash(developmentAcceptanceFingerprintInput(run.profile)) !==
        run.profile.acceptanceHash) ||
    run.events.some((e, i) => e.sequence !== i + 1)
  )
    invalid();
  if (run.candidate) {
    const candidate = validateDevelopmentCandidate(
      {
        summary: run.candidate.summary,
        files: run.candidate.files.map(({ afterSha256: _, ...file }) => file),
      },
      run.profile,
      hash,
    );
    if (JSON.stringify(candidate) !== JSON.stringify(run.candidate)) invalid();
  }
  for (const receipt of [run.baseline, run.checks]) {
    if (!receipt) continue;
    if (
      hash(developmentCheckLogsInput(receipt)) !== receipt.logsSha256 ||
      receipt.profileHash !== run.profile.profileHash ||
      receipt.baseImageId !== run.profile.baseImage ||
      JSON.stringify(receipt.command) !== JSON.stringify(run.profile.command)
    )
      invalid();
    if (
      receipt.phase === "baseline"
        ? receipt !== run.baseline || receipt.candidateFingerprint !== null
        : receipt !== run.checks ||
          receipt.candidateFingerprint !== run.candidate?.fingerprint
    )
      invalid();
    if (
      receipt.phase === "baseline" &&
      receipt.imageId !== run.profile.baseImage
    )
      invalid();
    if (
      receipt.status === "passed" &&
      (!receipt.started ||
        !receipt.policyVerified ||
        receipt.exitCode !== 0 ||
        receipt.truncated ||
        receipt.tests.length !== developmentCheckNames(run.profile).length ||
        developmentCheckNames(run.profile).some(
          (name) =>
            receipt.tests.filter((t) => t.name === name && t.passed).length !==
            1,
        ))
    )
      invalid();
  }
  if (["waiting_approval", "completed", "cancelled"].includes(run.status)) {
    if (
      !run.reviewFingerprint ||
      developmentReviewFingerprint(run, hash) !== run.reviewFingerprint ||
      run.execution
    )
      invalid();
  }
  if (run.status === "cancelled" && run.decision?.decision !== "reject")
    invalid();
  if (!["completed", "cancelled"].includes(run.status) && run.decision)
    invalid();
  if (run.status === "completed") {
    if (
      !run.artifact ||
      run.decision?.decision !== "approve" ||
      hash(run.artifact.content) !== run.artifact.sha256
    )
      invalid();
    const pkg = developmentPackageSchema.parse(
      JSON.parse(run.artifact!.content),
    );
    if (
      JSON.stringify(pkg.review) !== JSON.stringify(developmentReview(run)) ||
      JSON.stringify(pkg.approval) !== JSON.stringify(run.decision) ||
      JSON.stringify(pkg.events) !== JSON.stringify(run.events) ||
      pkg.savedAt !== run.artifact!.savedAt
    )
      invalid();
  } else if (run.artifact) invalid();
  if (
    run.decision &&
    (run.decision.fingerprint !== run.reviewFingerprint ||
      run.decision.revision !== run.revision - 1)
  )
    invalid();
  return run;
}
