import type {
  DevelopmentApplication,
  DevelopmentApplicationInput,
  DevelopmentApplicationPlan,
  DevelopmentRun,
} from "@vuzmi/core";

export type ApplicationPlanVersion = {
  runId: string;
  packageSha256: string;
  fingerprint: string;
};
export type ApplicationReviewState = {
  latest: DevelopmentApplicationPlan | null;
  displayed: DevelopmentApplicationPlan | null;
  opened: ApplicationPlanVersion | null;
  acknowledged: ApplicationPlanVersion | null;
  attempt: DevelopmentApplicationInput | null;
  refreshRequired: boolean;
};
export function applicationVersion(
  plan: DevelopmentApplicationPlan | null,
): ApplicationPlanVersion | null {
  return plan
    ? {
        runId: plan.runId,
        packageSha256: plan.packageSha256,
        fingerprint: plan.fingerprint,
      }
    : null;
}
export function sameApplicationVersion(
  a: ApplicationPlanVersion | null,
  b: ApplicationPlanVersion | null,
): boolean {
  return Boolean(
    a &&
    b &&
    a.runId === b.runId &&
    a.packageSha256 === b.packageSha256 &&
    a.fingerprint === b.fingerprint,
  );
}
export function initialApplicationReview(
  plan: DevelopmentApplicationPlan | null = null,
): ApplicationReviewState {
  return {
    latest: plan,
    displayed: plan,
    opened: null,
    acknowledged: null,
    attempt: null,
    refreshRequired: false,
  };
}
export function receiveApplicationPlan(
  state: ApplicationReviewState,
  plan: DevelopmentApplicationPlan,
): ApplicationReviewState {
  if (state.latest && state.latest.runId !== plan.runId)
    return initialApplicationReview(plan);
  return {
    ...state,
    latest: plan,
    displayed: state.displayed ?? plan,
    acknowledged: sameApplicationVersion(
      applicationVersion(state.displayed),
      applicationVersion(plan),
    )
      ? state.acknowledged
      : null,
  };
}
export function openApplicationPlan(
  state: ApplicationReviewState,
): ApplicationReviewState {
  if (!state.latest || state.refreshRequired) return state;
  const version = applicationVersion(state.latest);
  const sameAttempt =
    state.attempt?.packageSha256 === version!.packageSha256 &&
    state.attempt.planFingerprint === version!.fingerprint;
  return {
    ...state,
    displayed: state.latest,
    opened: version,
    acknowledged: null,
    attempt: sameAttempt ? state.attempt : null,
  };
}
export function acknowledgeApplicationPlan(
  state: ApplicationReviewState,
  shown: ApplicationPlanVersion,
): ApplicationReviewState {
  return !state.refreshRequired &&
    sameApplicationVersion(shown, state.opened) &&
    sameApplicationVersion(shown, applicationVersion(state.displayed)) &&
    sameApplicationVersion(shown, applicationVersion(state.latest))
    ? { ...state, acknowledged: shown }
    : state;
}
export function applicationDecisionReady(
  state: ApplicationReviewState,
  shown: ApplicationPlanVersion | null,
): boolean {
  return (
    !state.refreshRequired &&
    sameApplicationVersion(shown, state.opened) &&
    sameApplicationVersion(shown, state.acknowledged) &&
    sameApplicationVersion(shown, applicationVersion(state.displayed)) &&
    sameApplicationVersion(shown, applicationVersion(state.latest))
  );
}
export function captureApplicationRequest(
  state: ApplicationReviewState,
  shown: ApplicationPlanVersion | null,
  createId: () => string,
): {
  state: ApplicationReviewState;
  input: DevelopmentApplicationInput;
} | null {
  if (!applicationDecisionReady(state, shown)) return null;
  const input = state.attempt ?? {
    requestId: createId(),
    packageSha256: shown!.packageSha256,
    planFingerprint: shown!.fingerprint,
  };
  if (
    input.packageSha256 !== shown!.packageSha256 ||
    input.planFingerprint !== shown!.fingerprint
  )
    return null;
  return { state: { ...state, attempt: input }, input };
}
export function requireApplicationRefresh(
  state: ApplicationReviewState,
): ApplicationReviewState {
  return { ...state, opened: null, acknowledged: null, refreshRequired: true };
}
export function confirmApplicationRefresh(
  state: ApplicationReviewState,
): ApplicationReviewState {
  return { ...state, opened: null, acknowledged: null, refreshRequired: false };
}

/** Client correlation complements server integrity: a plan cannot describe another approved package/scope. */
export function applicationPlanMatchesRun(
  plan: DevelopmentApplicationPlan,
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
    plan.reviewFingerprint === run.reviewFingerprint &&
    plan.candidateFingerprint === run.candidate!.fingerprint &&
    plan.profileHash === run.profile.profileHash &&
    JSON.stringify(plan.files) ===
      JSON.stringify(
        run.candidate!.files.map(({ path, beforeSha256, afterSha256 }) => ({
          path,
          beforeSha256,
          afterSha256,
        })),
      )
  );
}
export function newerApplication(
  previous: DevelopmentApplication | null,
  incoming: DevelopmentApplication,
): DevelopmentApplication {
  if (!previous) return incoming;
  if (
    previous.id !== incoming.id ||
    previous.runId !== incoming.runId ||
    previous.plan.fingerprint !== incoming.plan.fingerprint
  )
    throw new Error(
      "The application response identifies a different authorization. Refresh this package’s saved application state.",
    );
  if (
    incoming.revision < previous.revision ||
    (previous.status === "applied" && incoming.status !== "applied")
  )
    return previous;
  return incoming;
}

export function applicationOperationMatchesRun(
  operation: DevelopmentApplication,
  run: DevelopmentRun,
): boolean {
  if (
    operation.runId !== run.id ||
    !applicationPlanMatchesRun(operation.plan, run)
  )
    return false;
  if (operation.status !== "applied") return !operation.receipt;
  const receipt = operation.receipt;
  return Boolean(
    receipt &&
    operation.prepared &&
    receipt.applicationId === operation.id &&
    receipt.runId === run.id &&
    receipt.repositoryIdentity === operation.plan.repositoryIdentity &&
    receipt.packageSha256 === operation.plan.packageSha256 &&
    receipt.baseCommit === operation.plan.baseCommit &&
    receipt.destinationRef === operation.plan.destinationRef &&
    receipt.commitOid === operation.prepared.commitOid &&
    receipt.treeOid === operation.prepared.treeOid &&
    JSON.stringify(receipt.files) ===
      JSON.stringify(operation.prepared.files) &&
    JSON.stringify(
      operation.prepared.files.map(({ mode: _mode, ...file }) => file),
    ) === JSON.stringify(operation.plan.files) &&
    receipt.actor === operation.actor &&
    receipt.authorizedAt === operation.authorizedAt,
  );
}
