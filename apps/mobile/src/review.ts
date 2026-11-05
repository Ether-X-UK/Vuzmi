import type { Run } from "@vuzmi/core";
export interface ProposalVersion {
  runId: string;
  revision: number;
  fingerprint: string;
}
export interface NativeReview {
  observed: ProposalVersion | null;
  opened: ProposalVersion | null;
  acknowledged: ProposalVersion | null;
  changed: boolean;
  refreshRequired: boolean;
}
export function proposalVersion(run: Run): ProposalVersion | null {
  return run.status === "waiting_approval" && run.proposal
    ? {
        runId: run.id,
        revision: run.revision,
        fingerprint: run.proposal.fingerprint,
      }
    : null;
}
function same(a: ProposalVersion | null, b: ProposalVersion | null): boolean {
  return (
    a === b ||
    Boolean(
      a &&
      b &&
      a.runId === b.runId &&
      a.revision === b.revision &&
      a.fingerprint === b.fingerprint,
    )
  );
}
export function initialNativeReview(run: Run): NativeReview {
  return {
    observed: proposalVersion(run),
    opened: null,
    acknowledged: null,
    changed: false,
    refreshRequired: false,
  };
}
export function observeNativeReview(
  state: NativeReview,
  run: Run,
): NativeReview {
  const version = proposalVersion(run);
  if (same(state.observed, version)) return state;
  return {
    observed: version,
    opened: null,
    acknowledged: null,
    changed: version !== null,
    refreshRequired: version !== null && state.refreshRequired,
  };
}
export function requireNativeRereview(
  state: NativeReview,
  run: Run,
): NativeReview {
  return {
    ...observeNativeReview(state, run),
    changed: proposalVersion(run) !== null,
    refreshRequired: proposalVersion(run) !== null,
    opened: null,
    acknowledged: null,
  };
}
/** Only a deliberately started post-conflict read confirms an unknown outcome. */
export function confirmNativeReview(
  state: NativeReview,
  run: Run,
): NativeReview {
  return { ...observeNativeReview(state, run), refreshRequired: false };
}
export function openNativeDocument(
  state: NativeReview,
  run: Run,
): NativeReview {
  const current = observeNativeReview(state, run);
  return {
    ...current,
    opened: current.refreshRequired ? null : proposalVersion(run),
  };
}
export function acknowledgeNativeReview(
  state: NativeReview,
  run: Run,
): NativeReview {
  const current = observeNativeReview(state, run),
    version = proposalVersion(run);
  if (!version || !canAcknowledgeNativeReview(current, run)) return current;
  return { ...current, changed: false, acknowledged: version };
}
export function canAcknowledgeNativeReview(
  state: NativeReview,
  run: Run,
): boolean {
  const current = observeNativeReview(state, run),
    version = proposalVersion(run);
  return Boolean(
    version &&
    current.changed &&
    !current.refreshRequired &&
    same(current.opened, version),
  );
}
export function canDecideNativeReview(state: NativeReview, run: Run): boolean {
  const current = observeNativeReview(state, run);
  return (
    proposalVersion(run) !== null &&
    !current.changed &&
    !current.refreshRequired
  );
}
/** Capture the exact CAS before asynchronous transport; future props cannot retarget it. */
export function captureNativeDecision(
  state: NativeReview,
  run: Run,
): Run | undefined {
  if (!canDecideNativeReview(state, run) || !run.proposal) return undefined;
  return { ...run, proposal: { ...run.proposal } };
}
