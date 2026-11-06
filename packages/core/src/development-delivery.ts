import { z } from "zod";
import {
  parseDevelopmentIntegrity,
  DEVELOPMENT_REGRESSION_PATHS,
} from "./development.js";
import type { DevelopmentRun } from "./development.js";
import { parseDevelopmentApplicationIntegrity } from "./development-application.js";
import type { DevelopmentApplication } from "./development-application.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.string().datetime();
const boundedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) =>
        !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value) &&
        new TextDecoder().decode(new TextEncoder().encode(value)) === value &&
        new TextEncoder().encode(value).length <= maximum,
      "Control characters are unsupported.",
    );
export const DEVELOPMENT_DELIVERY_SCOPE =
  "Publish this exact local application commit and its history to the fixed public Vuzmi branch, then create one draft pull request with this exact title and body targeting main. This may notify repository subscribers. No merge, deployment, comment, workflow dispatch or follow-up write." as const;
export const DEVELOPMENT_DELIVERY_DISCLOSURE =
  "GitHub receives the committed source and history, exact commit message, author and committer metadata, retained application and actor identifiers, and the reviewed pull request title and body. These become public. Repository subscribers may be notified." as const;
export const developmentDeliveryTextSchema = z
  .object({
    title: boundedText(160)
      .min(3)
      .refine((value) => !/[\r\n]/u.test(value) && value.trim().length >= 3),
    body: boundedText(16_000)
      .min(1)
      .refine(
        (value) =>
          value.trim().length > 0 && !value.includes("<!-- vuzmi-delivery:"),
      ),
  })
  .strict();
export type DevelopmentDeliveryText = z.infer<
  typeof developmentDeliveryTextSchema
>;
export const developmentDeliveryInputSchema = developmentDeliveryTextSchema
  .extend({
    requestId: z.string().uuid(),
    packageSha256: hash,
    planFingerprint: hash,
  })
  .strict();
export type DevelopmentDeliveryInput = z.infer<
  typeof developmentDeliveryInputSchema
>;
export const developmentDeliveryTargetSchema = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    repository: z.literal("Ether-X-UK/Vuzmi"),
    visibility: z.literal("public"),
    targetBranch: z.literal("main"),
    targetSha: oid,
    observedAt: timestamp,
  })
  .strict();
export type DevelopmentDeliveryTarget = z.infer<
  typeof developmentDeliveryTargetSchema
>;
const person = z
  .object({
    name: z.literal("Vuzmi Local"),
    email: z.literal("local@vuzmi.invalid"),
    date: timestamp,
  })
  .strict();
export const developmentDeliveryPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.literal("local-workspace"),
    runId: z.string().uuid(),
    applicationId: z.string().uuid(),
    applicationPlanFingerprint: hash,
    packageSha256: hash,
    repositoryIdentity: hash,
    repositoryId: z.number().int().positive().safe(),
    repository: z.literal("Ether-X-UK/Vuzmi"),
    visibility: z.literal("public"),
    targetBranch: z.literal("main"),
    targetSha: oid,
    targetObservedAt: timestamp,
    authorityIdentity: hash.nullable(),
    destinationRef: z
      .string()
      .regex(/^refs\/heads\/vuzmi\/development\/[0-9a-f-]{36}$/),
    baseCommit: oid,
    treeOid: oid,
    commitOid: oid,
    files: z
      .array(
        z
          .object({
            path: z.enum(DEVELOPMENT_REGRESSION_PATHS),
            beforeSha256: hash,
            afterSha256: hash,
            mode: z.enum(["100644", "100755"]),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    commit: z
      .object({ message: z.string(), author: person, committer: person })
      .strict(),
    title: developmentDeliveryTextSchema.shape.title,
    inputBody: developmentDeliveryTextSchema.shape.body,
    body: boundedText(17_000),
    marker: z.string(),
    scope: z.literal(DEVELOPMENT_DELIVERY_SCOPE),
    disclosure: z.literal(DEVELOPMENT_DELIVERY_DISCLOSURE),
    fingerprint: hash,
  })
  .strict();
export type DevelopmentDeliveryPlan = z.infer<
  typeof developmentDeliveryPlanSchema
>;
export class DevelopmentDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
type Hash = (value: string) => string;
export function developmentDeliveryPlanFingerprintInput(
  plan: DevelopmentDeliveryPlan | Omit<DevelopmentDeliveryPlan, "fingerprint">,
): string {
  // Observation time is informative. A fresh unchanged repository/main SHA must
  // preserve the reviewed effect fingerprint; identities, payload and authority remain bound.
  const {
    fingerprint: _fingerprint,
    targetObservedAt: _observed,
    ...value
  } = plan as DevelopmentDeliveryPlan;
  return JSON.stringify(
    developmentDeliveryPlanSchema
      .omit({ fingerprint: true, targetObservedAt: true })
      .parse(value),
  );
}
export function developmentDeliveryCommitMetadata(
  application: DevelopmentApplication,
): DevelopmentDeliveryPlan["commit"] {
  const actorHex = Array.from(
    new TextEncoder().encode(application.actor),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const date = new Date(
    Math.floor(Date.parse(application.authorizedAt) / 1000) * 1000,
  ).toISOString();
  const identity = {
    name: "Vuzmi Local" as const,
    email: "local@vuzmi.invalid" as const,
    date,
  };
  return {
    message: `Vuzmi approved development package ${application.runId}\n\nApplication: ${application.id}\nActor: ${actorHex}\nPackage-SHA256: ${application.plan.packageSha256}\nPlan-SHA256: ${application.plan.fingerprint}\n`,
    author: identity,
    committer: { ...identity },
  };
}
export function createDevelopmentDeliveryPlan(
  value: DevelopmentRun,
  applicationValue: DevelopmentApplication,
  text: DevelopmentDeliveryText,
  targetValue: DevelopmentDeliveryTarget,
  authorityIdentity: string | null,
  hash: Hash,
): DevelopmentDeliveryPlan {
  const run = parseDevelopmentIntegrity(value, hash),
    application = parseDevelopmentApplicationIntegrity(applicationValue, hash),
    input = developmentDeliveryTextSchema.parse(text),
    target = developmentDeliveryTargetSchema.parse(targetValue);
  if (
    run.status !== "completed" ||
    !run.artifact ||
    !run.candidate ||
    run.decision?.decision !== "approve" ||
    application.status !== "applied" ||
    !application.receipt ||
    application.runId !== run.id ||
    application.workspaceId !== run.workspaceId ||
    application.plan.packageSha256 !== run.artifact.sha256 ||
    application.plan.candidateFingerprint !== run.candidate.fingerprint ||
    application.plan.reviewFingerprint !== run.reviewFingerprint ||
    application.plan.baseCommit !== run.profile.baseCommit
  )
    throw new DevelopmentDeliveryError(
      "DELIVERY_NOT_APPLIED",
      "Only an exact approved package with its verified local application receipt can be published.",
    );
  const marker = `<!-- vuzmi-delivery:${run.id}:${application.id}:${run.artifact.sha256} -->`;
  const receipt = application.receipt;
  const unsigned = {
    schemaVersion: 1 as const,
    workspaceId: run.workspaceId,
    runId: run.id,
    applicationId: application.id,
    applicationPlanFingerprint: application.plan.fingerprint,
    packageSha256: run.artifact.sha256,
    repositoryIdentity: application.plan.repositoryIdentity,
    repositoryId: target.repositoryId,
    repository: target.repository,
    visibility: target.visibility,
    targetBranch: target.targetBranch,
    targetSha: target.targetSha,
    targetObservedAt: target.observedAt,
    authorityIdentity,
    destinationRef: receipt.destinationRef,
    baseCommit: receipt.baseCommit,
    treeOid: receipt.treeOid,
    commitOid: receipt.commitOid,
    files: receipt.files,
    commit: developmentDeliveryCommitMetadata(application),
    title: input.title,
    inputBody: input.body,
    body: `${input.body}\n\n${marker}`,
    marker,
    scope: DEVELOPMENT_DELIVERY_SCOPE,
    disclosure: DEVELOPMENT_DELIVERY_DISCLOSURE,
  };
  return developmentDeliveryPlanSchema.parse({
    ...unsigned,
    fingerprint: hash(developmentDeliveryPlanFingerprintInput(unsigned)),
  });
}
export const developmentDeliveryPhaseSchema = z.enum([
  "reserved",
  "blob",
  "tree",
  "commit",
  "branch",
  "pull_request",
]);
export type DevelopmentDeliveryPhase = z.infer<
  typeof developmentDeliveryPhaseSchema
>;
export const developmentDeliveryReceiptSchema = z
  .object({
    repositoryId: z.number().int().positive().safe(),
    repository: z.literal("Ether-X-UK/Vuzmi"),
    headRef: z.string(),
    headSha: oid,
    baseBranch: z.literal("main"),
    baseShaBefore: oid,
    baseShaAfter: oid,
    targetDrift: z.boolean(),
    prNumber: z.number().int().positive().safe(),
    prUrl: z
      .string()
      .regex(/^https:\/\/github\.com\/Ether-X-UK\/Vuzmi\/pull\/[1-9][0-9]*$/),
    title: z.string(),
    body: z.string(),
    draft: z.literal(true),
    publishedAt: timestamp,
  })
  .strict();
export type DevelopmentDeliveryReceipt = z.infer<
  typeof developmentDeliveryReceiptSchema
>;
export const developmentDeliveryCiSchema = z
  .object({
    observedAt: timestamp,
    headSha: oid,
    currentHeadSha: oid.nullable(),
    currentBaseSha: oid.nullable(),
    targetDrift: z.boolean(),
    state: z.enum([
      "waiting",
      "running",
      "passed",
      "failed",
      "unavailable",
      "stale",
    ]),
    truncated: z.boolean(),
    reason: z.string().max(600).nullable(),
    runs: z
      .array(
        z
          .object({
            id: z.number().int().positive().safe(),
            workflowName: z.string().max(300),
            workflowId: z.number().int().positive().safe(),
            workflowPath: z.string().max(300),
            runAttempt: z.number().int().positive().safe(),
            baseSha: oid.nullable(),
            observedPrMergeSha: oid.nullable(),
            event: z.string().max(100),
            headSha: oid,
            status: z.string().max(100),
            conclusion: z.string().max(100).nullable(),
            url: z
              .string()
              .regex(
                /^https:\/\/github\.com\/Ether-X-UK\/Vuzmi\/actions\/runs\/[1-9][0-9]*$/,
              ),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type DevelopmentDeliveryCi = z.infer<typeof developmentDeliveryCiSchema>;
export const developmentDeliverySchema = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.literal("local-workspace"),
    runId: z.string().uuid(),
    requestId: z.string().uuid(),
    requestFingerprint: hash,
    plan: developmentDeliveryPlanSchema,
    actor: z.string().min(1),
    actorName: z.string().optional(),
    authorizedAt: timestamp,
    status: z.enum([
      "queued",
      "running",
      "published",
      "unconfirmed",
      "conflict",
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
    workerId: z.string().uuid().optional(),
    attemptId: z.string().uuid().optional(),
    phase: developmentDeliveryPhaseSchema.optional(),
    error: z
      .object({ code: z.string(), message: z.string().max(600) })
      .strict()
      .optional(),
    receipt: developmentDeliveryReceiptSchema.optional(),
    ci: developmentDeliveryCiSchema.optional(),
  })
  .strict();
export type DevelopmentDelivery = z.infer<typeof developmentDeliverySchema>;
export function developmentDeliveryRequestFingerprintInput(
  input: DevelopmentDeliveryInput,
  actor: string,
): string {
  return JSON.stringify({
    input: developmentDeliveryInputSchema.parse(input),
    actor,
  });
}
export function createDevelopmentDelivery(
  plan: DevelopmentDeliveryPlan,
  input: DevelopmentDeliveryInput,
  context: {
    id: string;
    actor: { id: string; name?: string };
    now: string;
    hash: Hash;
  },
): DevelopmentDelivery {
  const request = developmentDeliveryInputSchema.parse(input);
  if (
    !plan.authorityIdentity ||
    request.planFingerprint !== plan.fingerprint ||
    request.packageSha256 !== plan.packageSha256 ||
    request.title !== plan.title ||
    request.body !== plan.inputBody
  )
    throw new DevelopmentDeliveryError(
      "STALE_DELIVERY_PLAN",
      "Review the exact current GitHub delivery plan and connected authority before authorizing publication.",
    );
  return parseDevelopmentDeliveryIntegrity(
    {
      id: context.id,
      workspaceId: plan.workspaceId,
      runId: plan.runId,
      requestId: request.requestId,
      requestFingerprint: context.hash(
        developmentDeliveryRequestFingerprintInput(request, context.actor.id),
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
          type: "delivery.authorized",
          occurredAt: context.now,
          message:
            "Owner separately authorized the exact public branch and draft pull request plan.",
        },
      ],
    },
    context.hash,
  );
}
export function withDevelopmentDeliveryEvent(
  operation: DevelopmentDelivery,
  type: string,
  message: string,
  now: string,
  changes: Partial<
    Pick<
      DevelopmentDelivery,
      "status" | "workerId" | "attemptId" | "phase" | "error" | "receipt" | "ci"
    >
  >,
): DevelopmentDelivery {
  return {
    ...operation,
    ...changes,
    revision: operation.revision + 1,
    updatedAt: now,
    events: [
      ...operation.events,
      { sequence: operation.events.length + 1, type, message, occurredAt: now },
    ],
  };
}
export function parseDevelopmentDeliveryIntegrity(
  value: unknown,
  hash: Hash,
): DevelopmentDelivery {
  const operation = developmentDeliverySchema.parse(value),
    plan = operation.plan;
  const invalid = () => {
    throw new DevelopmentDeliveryError(
      "DELIVERY_INTEGRITY",
      "The retained GitHub delivery plan, authorization or receipt is inconsistent.",
    );
  };
  if (
    plan.workspaceId !== operation.workspaceId ||
    plan.runId !== operation.runId ||
    plan.destinationRef !== `refs/heads/vuzmi/development/${operation.runId}` ||
    plan.marker !==
      `<!-- vuzmi-delivery:${operation.runId}:${plan.applicationId}:${plan.packageSha256} -->` ||
    plan.body !== `${plan.inputBody}\n\n${plan.marker}` ||
    hash(developmentDeliveryPlanFingerprintInput(plan)) !== plan.fingerprint ||
    hash(
      developmentDeliveryRequestFingerprintInput(
        {
          requestId: operation.requestId,
          packageSha256: plan.packageSha256,
          planFingerprint: plan.fingerprint,
          title: plan.title,
          body: plan.inputBody,
        },
        operation.actor,
      ),
    ) !== operation.requestFingerprint ||
    !plan.authorityIdentity ||
    operation.events.some((event, index) => event.sequence !== index + 1) ||
    operation.revision !== operation.events.length ||
    operation.events[0].type !== "delivery.authorized" ||
    operation.events[0].occurredAt !== operation.authorizedAt ||
    operation.updatedAt !== operation.events.at(-1)!.occurredAt ||
    new Set(plan.files.map((file) => file.path)).size !== plan.files.length
  )
    invalid();
  if (
    operation.status === "running" &&
    (!operation.workerId || !operation.attemptId || !operation.phase)
  )
    invalid();
  if (operation.receipt) {
    const r = operation.receipt;
    if (
      operation.status !== "published" ||
      r.repositoryId !== plan.repositoryId ||
      r.prUrl !== `https://github.com/Ether-X-UK/Vuzmi/pull/${r.prNumber}` ||
      r.headRef !== plan.destinationRef.slice("refs/heads/".length) ||
      r.headSha !== plan.commitOid ||
      r.title !== plan.title ||
      r.body !== plan.body ||
      r.baseShaBefore !== plan.targetSha ||
      r.targetDrift !== (r.baseShaAfter !== r.baseShaBefore) ||
      !operation.events.some(
        (event) =>
          event.type === "delivery.published" &&
          event.occurredAt === r.publishedAt,
      )
    )
      invalid();
  } else if (operation.status === "published") invalid();
  if (
    operation.ci &&
    (!operation.receipt || operation.ci.headSha !== plan.commitOid)
  )
    invalid();
  if (
    operation.ci?.state === "passed" &&
    (operation.ci.truncated ||
      !operation.ci.runs.length ||
      operation.ci.currentHeadSha !== plan.commitOid ||
      operation.ci.targetDrift ||
      operation.ci.runs.some(
        (run) =>
          run.headSha !== plan.commitOid ||
          run.status !== "completed" ||
          run.conclusion !== "success",
      ))
  )
    invalid();
  return operation;
}
