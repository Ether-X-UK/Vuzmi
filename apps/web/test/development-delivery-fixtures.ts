import { randomUUID } from "node:crypto";
import {
  createDevelopmentDelivery,
  createDevelopmentDeliveryPlan,
  withDevelopmentDeliveryEvent,
  type DevelopmentDelivery,
  type DevelopmentDeliveryCi,
  type DevelopmentRun,
} from "@vuzmi/core";
import {
  fixtureHash,
  fixtureTime,
  uiAppliedApplication,
  uiApprovedRun,
} from "./development-ui-fixtures";

export function uiDeliveryPlan(run = uiApprovedRun(true)) {
  return createDevelopmentDeliveryPlan(
    run,
    uiAppliedApplication(run),
    {
      title: "Preserve original API error strings",
      body: "Validate each field before checking blank text; preserve the original nonempty strings.",
    },
    {
      repositoryId: 1234,
      repository: "Ether-X-UK/Vuzmi",
      visibility: "public",
      targetBranch: "main",
      targetSha: "d".repeat(40),
      observedAt: fixtureTime,
    },
    "f".repeat(64),
    fixtureHash,
  );
}
export function uiDelivery(run = uiApprovedRun(true)): DevelopmentDelivery {
  const plan = uiDeliveryPlan(run);
  return createDevelopmentDelivery(
    plan,
    {
      requestId: randomUUID(),
      planFingerprint: plan.fingerprint,
      packageSha256: plan.packageSha256,
      title: plan.title,
      body: plan.inputBody,
    },
    {
      id: randomUUID(),
      actor: { id: "fixture-owner" },
      now: fixtureTime,
      hash: fixtureHash,
    },
  );
}
export function uiPublishedDelivery(
  run: DevelopmentRun = uiApprovedRun(true),
): DevelopmentDelivery {
  const operation = uiDelivery(run),
    plan = operation.plan;
  return withDevelopmentDeliveryEvent(
    operation,
    "delivery.published",
    "Synthetic draft PR receipt. No GitHub requests occurred.",
    fixtureTime,
    {
      status: "published",
      receipt: {
        repositoryId: plan.repositoryId,
        repository: plan.repository,
        headRef: plan.destinationRef.slice("refs/heads/".length),
        headSha: plan.commitOid,
        baseBranch: "main",
        baseShaBefore: plan.targetSha,
        baseShaAfter: plan.targetSha,
        targetDrift: false,
        prNumber: 12,
        prUrl: "https://github.com/Ether-X-UK/Vuzmi/pull/12",
        title: plan.title,
        body: plan.body,
        draft: true,
        publishedAt: fixtureTime,
      },
    },
  );
}
export function uiDeliveryCi(headSha = "c".repeat(40)): DevelopmentDeliveryCi {
  return {
    observedAt: fixtureTime,
    headSha,
    currentHeadSha: headSha,
    currentBaseSha: null,
    targetDrift: false,
    state: "passed",
    truncated: false,
    reason: null,
    runs: [
      {
        id: 99,
        workflowName: "Synthetic named check",
        workflowId: 45,
        workflowPath: ".github/workflows/synthetic.yml",
        runAttempt: 1,
        baseSha: null,
        observedPrMergeSha: null,
        event: "pull_request",
        headSha,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/Ether-X-UK/Vuzmi/actions/runs/99",
      },
    ],
  };
}
