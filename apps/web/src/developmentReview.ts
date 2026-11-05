import {
  developmentBaselineAccepted,
  developmentCandidatePassed,
  type DecisionInput,
  type DevelopmentRun,
} from "@vuzmi/core";

export type DevelopmentVersion = {
  id: string;
  revision: number;
  fingerprint: string;
};
export type DevelopmentReviewState = {
  latest: DevelopmentRun;
  displayed: DevelopmentRun;
  opened: DevelopmentVersion | null;
  acknowledged: DevelopmentVersion | null;
  refreshRequired: boolean;
};
export function developmentVersion(
  run: DevelopmentRun,
): DevelopmentVersion | null {
  return run.status === "waiting_approval" &&
    run.reviewFingerprint &&
    run.candidate &&
    run.baseline &&
    developmentBaselineAccepted(run.baseline, run.profile) &&
    run.checks &&
    developmentCandidatePassed(run.checks, run.profile)
    ? { id: run.id, revision: run.revision, fingerprint: run.reviewFingerprint }
    : null;
}
export function sameDevelopmentVersion(
  a: DevelopmentVersion | null,
  b: DevelopmentVersion | null,
): boolean {
  return Boolean(
    a &&
    b &&
    a.id === b.id &&
    a.revision === b.revision &&
    a.fingerprint === b.fingerprint,
  );
}
export function createDevelopmentReview(
  run: DevelopmentRun,
): DevelopmentReviewState {
  return {
    latest: run,
    displayed: run,
    opened: null,
    acknowledged: null,
    refreshRequired: false,
  };
}
const terminal = (run: DevelopmentRun) =>
  ["completed", "cancelled", "failed"].includes(run.status);
export function receiveDevelopmentRun(
  state: DevelopmentReviewState,
  run: DevelopmentRun,
): DevelopmentReviewState {
  if (run.id !== state.latest.id) return createDevelopmentReview(run);
  if (
    run.revision < state.latest.revision ||
    (terminal(state.latest) && !terminal(run))
  )
    return state;
  if (!developmentVersion(run) || !developmentVersion(state.displayed))
    return createDevelopmentReview(run);
  if (
    !sameDevelopmentVersion(
      developmentVersion(run),
      developmentVersion(state.displayed),
    )
  )
    return { ...state, latest: run, acknowledged: null };
  return { ...state, latest: run };
}
export function openDevelopmentReview(
  state: DevelopmentReviewState,
  id: string,
): DevelopmentReviewState {
  const version = developmentVersion(state.latest);
  return version && version.id === id && !state.refreshRequired
    ? { ...state, displayed: state.latest, opened: version, acknowledged: null }
    : state;
}
export function acknowledgeDevelopmentReview(
  state: DevelopmentReviewState,
  shown: DevelopmentVersion,
): DevelopmentReviewState {
  return !state.refreshRequired &&
    sameDevelopmentVersion(shown, state.opened) &&
    sameDevelopmentVersion(shown, developmentVersion(state.displayed)) &&
    sameDevelopmentVersion(shown, developmentVersion(state.latest))
    ? { ...state, acknowledged: shown }
    : state;
}
export function requireDevelopmentRefresh(
  state: DevelopmentReviewState,
): DevelopmentReviewState {
  return { ...state, opened: null, acknowledged: null, refreshRequired: true };
}
export function confirmDevelopmentRefresh(
  state: DevelopmentReviewState,
  run: DevelopmentRun,
): DevelopmentReviewState {
  const received = receiveDevelopmentRun(state, run);
  return {
    ...received,
    opened: null,
    acknowledged: null,
    refreshRequired: false,
  };
}
export function captureDevelopmentDecision(
  state: DevelopmentReviewState,
  shown: DevelopmentVersion | null,
  decision: DecisionInput["decision"],
): { id: string; input: DecisionInput } | null {
  return !state.refreshRequired &&
    sameDevelopmentVersion(shown, state.opened) &&
    sameDevelopmentVersion(shown, state.acknowledged) &&
    sameDevelopmentVersion(shown, developmentVersion(state.displayed)) &&
    sameDevelopmentVersion(shown, developmentVersion(state.latest))
    ? {
        id: shown!.id,
        input: {
          decision,
          revision: shown!.revision,
          fingerprint: shown!.fingerprint,
        },
      }
    : null;
}
export function mergeDevelopmentRuns(
  current: DevelopmentRun[],
  incoming: DevelopmentRun[],
): DevelopmentRun[] {
  const result = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const previous = result.get(run.id);
    if (
      !previous ||
      (run.revision >= previous.revision &&
        (!terminal(previous) || terminal(run)))
    )
      result.set(run.id, run);
  }
  return Array.from(result.values()).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
