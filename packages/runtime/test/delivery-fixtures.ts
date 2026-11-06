import { randomUUID } from "node:crypto";
import {
  createDevelopmentApplicationPlan,
  createDevelopmentApplication,
  withDevelopmentApplicationEvent,
  createDevelopmentDeliveryPlan,
  createDevelopmentDelivery,
} from "@vuzmi/core";
import type { DevelopmentRun } from "@vuzmi/core";
import {
  approvedApplicationFixture,
  applicationActor,
} from "./application-fixtures.js";
import { digest } from "./development-fixtures.js";
/** Synthetic aggregates only; no inference, checks, Git changes or GitHub request occurs. */
export function approvedDeliveryFixture(
  run: DevelopmentRun = approvedApplicationFixture(),
) {
  const now = "2026-11-06T12:00:00.000Z",
    applicationPlan = createDevelopmentApplicationPlan(
      run,
      "1".repeat(64),
      digest,
    );
  let application = createDevelopmentApplication(
    applicationPlan,
    {
      requestId: randomUUID(),
      packageSha256: applicationPlan.packageSha256,
      planFingerprint: applicationPlan.fingerprint,
    },
    { id: randomUUID(), actor: applicationActor, now, hash: digest },
  );
  const prepared = {
    treeOid: "2".repeat(40),
    commitOid: "3".repeat(40),
    files: applicationPlan.files.map((file) => ({
      ...file,
      mode: "100644" as const,
    })),
  };
  application = withDevelopmentApplicationEvent(
    application,
    "application.started",
    "Synthetic fixture claim.",
    now,
    { status: "running", workerId: randomUUID(), attemptId: randomUUID() },
  );
  application = withDevelopmentApplicationEvent(
    application,
    "application.prepared",
    "Synthetic fixture commit.",
    now,
    { prepared },
  );
  application = withDevelopmentApplicationEvent(
    application,
    "application.applied",
    "Synthetic fixture application receipt.",
    now,
    {
      status: "applied",
      receipt: {
        applicationId: application.id,
        runId: run.id,
        repositoryIdentity: applicationPlan.repositoryIdentity,
        packageSha256: applicationPlan.packageSha256,
        baseCommit: applicationPlan.baseCommit,
        destinationRef: applicationPlan.destinationRef,
        ...prepared,
        actor: application.actor,
        authorizedAt: application.authorizedAt,
        appliedAt: now,
      },
    },
  );
  const target = {
      repositoryId: 123,
      repository: "Ether-X-UK/Vuzmi" as const,
      visibility: "public" as const,
      targetBranch: "main" as const,
      targetSha: "4".repeat(40),
      observedAt: now,
    },
    text = {
      title: "Improve bounded API errors",
      body: "Preserve validated API strings and existing status handling.\n\nSynthetic delivery fixture.",
    },
    authorityIdentity = "5".repeat(64),
    plan = createDevelopmentDeliveryPlan(
      run,
      application,
      text,
      target,
      authorityIdentity,
      digest,
    ),
    input = {
      ...text,
      requestId: randomUUID(),
      packageSha256: plan.packageSha256,
      planFingerprint: plan.fingerprint,
    },
    operation = createDevelopmentDelivery(plan, input, {
      id: randomUUID(),
      actor: applicationActor,
      now,
      hash: digest,
    });
  const receipt = {
    repositoryId: 123,
    repository: "Ether-X-UK/Vuzmi" as const,
    headRef: plan.destinationRef.slice("refs/heads/".length),
    headSha: plan.commitOid,
    baseBranch: "main" as const,
    baseShaBefore: plan.targetSha,
    baseShaAfter: plan.targetSha,
    targetDrift: false,
    prNumber: 7,
    prUrl: "https://github.com/Ether-X-UK/Vuzmi/pull/7",
    title: plan.title,
    body: plan.body,
    draft: true as const,
    publishedAt: now,
  };
  return {
    run,
    application,
    target,
    text,
    authorityIdentity,
    plan,
    input,
    operation,
    receipt,
  };
}
