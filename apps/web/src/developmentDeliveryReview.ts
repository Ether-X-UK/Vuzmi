import type {
  DevelopmentDelivery,
  DevelopmentDeliveryInput,
  DevelopmentDeliveryPlan,
  DevelopmentDeliveryCi,
  DevelopmentRun,
} from "@vuzmi/core";

export type DeliveryDraft = { title: string; body: string };
export type DeliveryVersion = {
  runId: string;
  packageSha256: string;
  fingerprint: string;
};
type DeliverySnapshot = { plan: DevelopmentDeliveryPlan; draft: DeliveryDraft };
export type DeliveryReviewState = {
  draft: DeliveryDraft;
  latest: DeliverySnapshot | null;
  displayed: DeliverySnapshot | null;
  opened: DeliveryVersion | null;
  acknowledged: DeliveryVersion | null;
  attempt: DevelopmentDeliveryInput | null;
  refreshRequired: boolean;
};
export const sameDeliveryDraft = (a: DeliveryDraft, b: DeliveryDraft) =>
  a.title === b.title && a.body === b.body;
export function deliveryVersion(
  plan?: DevelopmentDeliveryPlan | null,
): DeliveryVersion | null {
  return plan
    ? {
        runId: plan.runId,
        packageSha256: plan.packageSha256,
        fingerprint: plan.fingerprint,
      }
    : null;
}
export function sameDeliveryVersion(
  a: DeliveryVersion | null,
  b: DeliveryVersion | null,
): boolean {
  return Boolean(
    a &&
    b &&
    a.runId === b.runId &&
    a.packageSha256 === b.packageSha256 &&
    a.fingerprint === b.fingerprint,
  );
}
export function initialDeliveryReview(
  draft: DeliveryDraft,
): DeliveryReviewState {
  return {
    draft,
    latest: null,
    displayed: null,
    opened: null,
    acknowledged: null,
    attempt: null,
    refreshRequired: false,
  };
}
export function editDeliveryDraft(
  state: DeliveryReviewState,
  draft: DeliveryDraft,
): DeliveryReviewState {
  if (sameDeliveryDraft(state.draft, draft)) return state;
  return { ...state, draft, opened: null, acknowledged: null };
}
/** A late plan for text that has since been edited cannot replace the latest snapshot. */
export function receiveDeliveryPlan(
  state: DeliveryReviewState,
  plan: DevelopmentDeliveryPlan,
  draft: DeliveryDraft,
): DeliveryReviewState {
  if (!sameDeliveryDraft(state.draft, draft)) return state;
  const snapshot = { plan, draft: { ...draft } };
  if (state.latest && state.latest.plan.runId !== plan.runId)
    return {
      ...initialDeliveryReview(state.draft),
      latest: snapshot,
      displayed: snapshot,
    };
  return {
    ...state,
    latest: snapshot,
    displayed: state.displayed ?? snapshot,
    acknowledged: sameDeliveryVersion(
      deliveryVersion(state.displayed?.plan),
      deliveryVersion(plan),
    )
      ? state.acknowledged
      : null,
  };
}
export function openDeliveryPlan(
  state: DeliveryReviewState,
): DeliveryReviewState {
  if (
    state.refreshRequired ||
    !state.latest ||
    !sameDeliveryDraft(state.draft, state.latest.draft)
  )
    return state;
  const version = deliveryVersion(state.latest.plan)!;
  const matchingAttempt =
    state.attempt?.packageSha256 === version.packageSha256 &&
    state.attempt.planFingerprint === version.fingerprint &&
    sameDeliveryDraft(state.attempt, state.latest.draft);
  return {
    ...state,
    displayed: state.latest,
    opened: version,
    acknowledged: null,
    attempt: matchingAttempt ? state.attempt : null,
  };
}
export function acknowledgeDeliveryPlan(
  state: DeliveryReviewState,
  shown: DeliveryVersion,
): DeliveryReviewState {
  return !state.refreshRequired &&
    state.displayed &&
    state.latest &&
    sameDeliveryDraft(state.draft, state.displayed.draft) &&
    sameDeliveryDraft(state.draft, state.latest.draft) &&
    sameDeliveryVersion(shown, state.opened) &&
    sameDeliveryVersion(shown, deliveryVersion(state.displayed.plan)) &&
    sameDeliveryVersion(shown, deliveryVersion(state.latest.plan))
    ? { ...state, acknowledged: shown }
    : state;
}
export function deliveryDecisionReady(
  state: DeliveryReviewState,
  shown: DeliveryVersion | null,
): boolean {
  return Boolean(
    !state.refreshRequired &&
    state.displayed &&
    state.latest &&
    sameDeliveryDraft(state.draft, state.displayed.draft) &&
    sameDeliveryDraft(state.draft, state.latest.draft) &&
    sameDeliveryVersion(shown, state.opened) &&
    sameDeliveryVersion(shown, state.acknowledged) &&
    sameDeliveryVersion(shown, deliveryVersion(state.displayed.plan)) &&
    sameDeliveryVersion(shown, deliveryVersion(state.latest.plan)),
  );
}
export function captureDeliveryRequest(
  state: DeliveryReviewState,
  shown: DeliveryVersion | null,
  createId: () => string,
): { state: DeliveryReviewState; input: DevelopmentDeliveryInput } | null {
  if (!deliveryDecisionReady(state, shown)) return null;
  const input = state.attempt ?? {
    requestId: createId(),
    packageSha256: shown!.packageSha256,
    planFingerprint: shown!.fingerprint,
    ...state.displayed!.draft,
  };
  if (
    input.packageSha256 !== shown!.packageSha256 ||
    input.planFingerprint !== shown!.fingerprint ||
    !sameDeliveryDraft(input, state.displayed!.draft)
  )
    return null;
  return { state: { ...state, attempt: input }, input };
}
export function requireDeliveryRefresh(
  state: DeliveryReviewState,
): DeliveryReviewState {
  return { ...state, opened: null, acknowledged: null, refreshRequired: true };
}
export function confirmDeliveryRefresh(
  state: DeliveryReviewState,
): DeliveryReviewState {
  return { ...state, opened: null, acknowledged: null, refreshRequired: false };
}

export function deliveryPlanMatchesRun(
  plan: DevelopmentDeliveryPlan,
  run: DevelopmentRun,
): boolean {
  return (
    run.status === "completed" &&
    run.decision?.decision === "approve" &&
    Boolean(run.artifact && run.candidate) &&
    plan.runId === run.id &&
    plan.workspaceId === run.workspaceId &&
    plan.repository === run.profile.repository &&
    plan.packageSha256 === run.artifact!.sha256 &&
    plan.baseCommit === run.profile.baseCommit &&
    plan.destinationRef === `refs/heads/vuzmi/development/${run.id}` &&
    JSON.stringify(
      plan.files.map(({ path, beforeSha256, afterSha256 }) => ({
        path,
        beforeSha256,
        afterSha256,
      })),
    ) ===
      JSON.stringify(
        run.candidate!.files.map(({ path, beforeSha256, afterSha256 }) => ({
          path,
          beforeSha256,
          afterSha256,
        })),
      )
  );
}
export function deliveryOperationMatchesRun(
  operation: DevelopmentDelivery,
  run: DevelopmentRun,
): boolean {
  if (
    operation.runId !== run.id ||
    !deliveryPlanMatchesRun(operation.plan, run)
  )
    return false;
  const receipt = operation.receipt;
  if (operation.status === "published") {
    if (
      !receipt ||
      receipt.repositoryId !== operation.plan.repositoryId ||
      receipt.headSha !== operation.plan.commitOid ||
      receipt.headRef !==
        operation.plan.destinationRef.slice("refs/heads/".length) ||
      receipt.title !== operation.plan.title ||
      receipt.body !== operation.plan.body ||
      receipt.baseShaBefore !== operation.plan.targetSha ||
      receipt.draft !== true
    )
      return false;
  } else if (receipt) return false;
  return (
    !operation.ci ||
    Boolean(receipt && operation.ci.headSha === operation.plan.commitOid)
  );
}
export function newerDelivery(
  previous: DevelopmentDelivery | null,
  incoming: DevelopmentDelivery,
): DevelopmentDelivery {
  if (!previous) return incoming;
  if (
    previous.id !== incoming.id ||
    previous.runId !== incoming.runId ||
    previous.plan.fingerprint !== incoming.plan.fingerprint
  )
    throw new Error(
      "The delivery response identifies another authorization. Refresh this package’s recorded delivery status.",
    );
  if (
    incoming.revision < previous.revision ||
    (previous.status === "published" && incoming.status !== "published")
  )
    return previous;
  if (
    previous.receipt &&
    JSON.stringify(previous.receipt) !== JSON.stringify(incoming.receipt)
  )
    throw new Error(
      "The response changed an already recorded publication receipt. Retaining the last verified receipt.",
    );
  return incoming;
}

/** Never turn an empty result or another commit's green workflow into passing evidence. */
export function deliveryCiState(
  ci: DevelopmentDeliveryCi,
  expectedHead: string,
): DevelopmentDeliveryCi["state"] {
  if (
    ci.targetDrift ||
    ci.headSha !== expectedHead ||
    (ci.currentHeadSha !== null && ci.currentHeadSha !== expectedHead) ||
    ci.runs.some((run) => run.headSha !== expectedHead)
  )
    return "stale";
  if (ci.state === "unavailable" || ci.state === "stale") return ci.state;
  if (ci.runs.length === 0) return "waiting";
  if (ci.state === "passed" && ci.truncated) return "unavailable";
  return ci.state;
}
