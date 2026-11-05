import { z } from "zod";
import {
  parseDevelopmentIntegrity,
  DEVELOPMENT_REGRESSION_PATHS,
} from "./development.js";
import type { DevelopmentRun } from "./development.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().datetime();
export const DEVELOPMENT_APPLICATION_SCOPE =
  "Create the fixed local work branch from this exact approved package and pinned base. The active checkout and index stay unchanged. No code execution, push, PR, merge or deployment." as const;
export const developmentApplicationInputSchema = z
  .object({
    requestId: z.string().uuid(),
    packageSha256: hash,
    planFingerprint: hash,
  })
  .strict();
export type DevelopmentApplicationInput = z.infer<
  typeof developmentApplicationInputSchema
>;
export const developmentApplicationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    workspaceId: z.literal("local-workspace"),
    repository: z.literal("Ether-X-UK/Vuzmi"),
    repositoryIdentity: hash,
    baseCommit: oid,
    destinationRef: z
      .string()
      .regex(/^refs\/heads\/vuzmi\/development\/[0-9a-f-]{36}$/),
    packageSha256: hash,
    reviewFingerprint: hash,
    candidateFingerprint: hash,
    profileHash: hash,
    files: z
      .array(
        z
          .object({
            path: z.enum(DEVELOPMENT_REGRESSION_PATHS),
            beforeSha256: hash,
            afterSha256: hash,
          })
          .strict(),
      )
      .min(1)
      .max(3),
    scope: z.literal(DEVELOPMENT_APPLICATION_SCOPE),
    fingerprint: hash,
  })
  .strict();
export type DevelopmentApplicationPlan = z.infer<
  typeof developmentApplicationPlanSchema
>;
export function developmentApplicationPlanFingerprintInput(
  plan:
    | DevelopmentApplicationPlan
    | Omit<DevelopmentApplicationPlan, "fingerprint">,
): string {
  const { fingerprint: _ignored, ...value } =
    plan as DevelopmentApplicationPlan;
  return JSON.stringify(
    developmentApplicationPlanSchema.omit({ fingerprint: true }).parse(value),
  );
}
export class DevelopmentApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
type Hash = (text: string) => string;
export function createDevelopmentApplicationPlan(
  value: DevelopmentRun,
  repositoryIdentity: string,
  hash: Hash,
): DevelopmentApplicationPlan {
  const run = parseDevelopmentIntegrity(value, hash);
  if (
    run.status !== "completed" ||
    !run.artifact ||
    !run.candidate ||
    !run.reviewFingerprint ||
    run.decision?.decision !== "approve"
  )
    throw new DevelopmentApplicationError(
      "APPLICATION_NOT_APPROVED",
      "Only an exact approved development package can be applied.",
    );
  const unsigned = {
    schemaVersion: 1 as const,
    runId: run.id,
    workspaceId: run.workspaceId,
    repository: run.profile.repository,
    repositoryIdentity,
    baseCommit: run.profile.baseCommit,
    destinationRef: `refs/heads/vuzmi/development/${run.id}`,
    packageSha256: run.artifact.sha256,
    reviewFingerprint: run.reviewFingerprint,
    candidateFingerprint: run.candidate.fingerprint,
    profileHash: run.profile.profileHash,
    files: run.candidate.files.map((file) => ({
      path: file.path,
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
    })),
    scope: DEVELOPMENT_APPLICATION_SCOPE,
  };
  return developmentApplicationPlanSchema.parse({
    ...unsigned,
    fingerprint: hash(developmentApplicationPlanFingerprintInput(unsigned)),
  });
}
const appliedFileSchema = z
  .object({
    path: z.enum(DEVELOPMENT_REGRESSION_PATHS),
    beforeSha256: hash,
    afterSha256: hash,
    mode: z.enum(["100644", "100755"]),
  })
  .strict();
export const developmentApplicationPreparedSchema = z
  .object({
    treeOid: oid,
    commitOid: oid,
    files: z.array(appliedFileSchema).min(1).max(3),
  })
  .strict();
export type DevelopmentApplicationPrepared = z.infer<
  typeof developmentApplicationPreparedSchema
>;
export const developmentApplicationReceiptSchema = z
  .object({
    applicationId: z.string().uuid(),
    runId: z.string().uuid(),
    repositoryIdentity: hash,
    packageSha256: hash,
    baseCommit: oid,
    destinationRef: z
      .string()
      .regex(/^refs\/heads\/vuzmi\/development\/[0-9a-f-]{36}$/),
    treeOid: oid,
    commitOid: oid,
    files: z.array(appliedFileSchema).min(1).max(3),
    actor: z.string().min(1),
    authorizedAt: timestamp,
    appliedAt: timestamp,
  })
  .strict();
export type DevelopmentApplicationReceipt = z.infer<
  typeof developmentApplicationReceiptSchema
>;
export const developmentApplicationSchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.literal("local-workspace"),
    runId: z.string().uuid(),
    requestId: z.string().uuid(),
    requestFingerprint: hash,
    plan: developmentApplicationPlanSchema,
    actor: z.string().min(1),
    actorName: z.string().optional(),
    authorizedAt: timestamp,
    status: z.enum([
      "queued",
      "running",
      "applied",
      "conflict",
      "unavailable",
      "unconfirmed",
    ]),
    revision: z.number().int().positive(),
    updatedAt: timestamp,
    events: z
      .array(
        z
          .object({
            sequence: z.number().int().positive(),
            type: z.string(),
            occurredAt: timestamp,
            message: z.string(),
          })
          .strict(),
      )
      .min(1),
    attemptId: z.string().uuid().optional(),
    workerId: z.string().uuid().optional(),
    prepared: developmentApplicationPreparedSchema.optional(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
    receipt: developmentApplicationReceiptSchema.optional(),
  })
  .strict();
export type DevelopmentApplication = z.infer<
  typeof developmentApplicationSchema
>;
export function developmentApplicationRequestFingerprintInput(
  input: DevelopmentApplicationInput,
  actor: string,
): string {
  return JSON.stringify({
    input: developmentApplicationInputSchema.parse(input),
    actor,
  });
}
export function createDevelopmentApplication(
  plan: DevelopmentApplicationPlan,
  input: DevelopmentApplicationInput,
  context: {
    id: string;
    actor: { id: string; name?: string };
    now: string;
    hash: Hash;
  },
): DevelopmentApplication {
  const request = developmentApplicationInputSchema.parse(input);
  if (
    request.packageSha256 !== plan.packageSha256 ||
    request.planFingerprint !== plan.fingerprint
  )
    throw new DevelopmentApplicationError(
      "STALE_APPLICATION_PLAN",
      "Review the exact current application plan before authorizing it.",
    );
  return parseDevelopmentApplicationIntegrity(
    {
      id: context.id,
      workspaceId: plan.workspaceId,
      runId: plan.runId,
      requestId: request.requestId,
      requestFingerprint: context.hash(
        developmentApplicationRequestFingerprintInput(
          request,
          context.actor.id,
        ),
      ),
      plan,
      actor: context.actor.id,
      ...(context.actor.name ? { actorName: context.actor.name } : {}),
      authorizedAt: context.now,
      status: "queued",
      revision: 1,
      updatedAt: context.now,
      events: [
        {
          sequence: 1,
          type: "application.authorized",
          occurredAt: context.now,
          message:
            "Owner separately authorized this exact package, pinned base and fixed local work branch.",
        },
      ],
    },
    context.hash,
  );
}
export function withDevelopmentApplicationEvent(
  run: DevelopmentApplication,
  type: string,
  message: string,
  now: string,
  changes: Partial<
    Pick<
      DevelopmentApplication,
      "status" | "attemptId" | "workerId" | "prepared" | "error" | "receipt"
    >
  >,
): DevelopmentApplication {
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
export function parseDevelopmentApplicationIntegrity(
  value: unknown,
  hash: Hash,
): DevelopmentApplication {
  const run = developmentApplicationSchema.parse(value),
    plan = run.plan;
  const invalid = () => {
    throw new DevelopmentApplicationError(
      "APPLICATION_INTEGRITY",
      "The retained application authorization or receipt is inconsistent.",
    );
  };
  if (
    plan.runId !== run.runId ||
    plan.workspaceId !== run.workspaceId ||
    plan.destinationRef !== `refs/heads/vuzmi/development/${run.runId}` ||
    hash(developmentApplicationPlanFingerprintInput(plan)) !==
      plan.fingerprint ||
    hash(
      developmentApplicationRequestFingerprintInput(
        {
          requestId: run.requestId,
          packageSha256: plan.packageSha256,
          planFingerprint: plan.fingerprint,
        },
        run.actor,
      ),
    ) !== run.requestFingerprint ||
    run.events.some((event, index) => event.sequence !== index + 1) ||
    run.events[0].type !== "application.authorized" ||
    run.events[0].occurredAt !== run.authorizedAt ||
    run.revision !== run.events.length ||
    new Set(plan.files.map((file) => file.path)).size !== plan.files.length ||
    plan.files.some((file) => file.beforeSha256 === file.afterSha256) ||
    run.updatedAt !== run.events.at(-1)!.occurredAt
  )
    invalid();
  if (
    run.prepared &&
    JSON.stringify(
      run.prepared.files.map(({ mode: _mode, ...file }) => file),
    ) !== JSON.stringify(plan.files)
  )
    invalid();
  if (run.status === "applied") {
    const receipt = run.receipt;
    if (
      !receipt ||
      !run.prepared ||
      receipt.applicationId !== run.id ||
      receipt.runId !== run.runId ||
      receipt.repositoryIdentity !== plan.repositoryIdentity ||
      receipt.packageSha256 !== plan.packageSha256 ||
      receipt.baseCommit !== plan.baseCommit ||
      receipt.destinationRef !== plan.destinationRef ||
      receipt.treeOid !== run.prepared.treeOid ||
      receipt.commitOid !== run.prepared.commitOid ||
      JSON.stringify(receipt.files) !== JSON.stringify(run.prepared.files) ||
      receipt.actor !== run.actor ||
      receipt.authorizedAt !== run.authorizedAt ||
      !run.events.some(
        (event) =>
          event.type === "application.applied" &&
          event.occurredAt === receipt.appliedAt,
      )
    )
      invalid();
  } else if (run.receipt) invalid();
  if (run.status === "running" && (!run.attemptId || !run.workerId)) invalid();
  return run;
}
