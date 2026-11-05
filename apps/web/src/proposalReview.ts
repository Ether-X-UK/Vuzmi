import type { DecisionInput, Run } from "@vuzmi/core";

export type ProposalVersion = {
  runId: string;
  revision: number;
  fingerprint: string;
};

export type ProposalReview = {
  latest: Run;
  displayed: Run;
  acknowledged: ProposalVersion | null;
  opened: ProposalVersion | null;
  required: boolean;
};

export function proposalVersion(run: Run): ProposalVersion | null {
  return run.status === "waiting_approval" && run.proposal
    ? {
        runId: run.id,
        revision: run.revision,
        fingerprint: run.proposal.fingerprint,
      }
    : null;
}

export function sameProposalVersion(
  a: ProposalVersion | null,
  b: ProposalVersion | null,
): boolean {
  return Boolean(
    a &&
      b &&
      a.runId === b.runId &&
      a.revision === b.revision &&
      a.fingerprint === b.fingerprint,
  );
}

const terminal = (run: Run) =>
  ["completed", "cancelled", "failed"].includes(run.status);

export function createProposalReview(run: Run): ProposalReview {
  return {
    latest: run,
    displayed: run,
    acknowledged: proposalVersion(run),
    opened: null,
    required: false,
  };
}

/** Polling updates the server record, never a waiting document already under review. */
export function receiveProposalRun(
  state: ProposalReview,
  incoming: Run,
): ProposalReview {
  if (incoming.id !== state.latest.id) return createProposalReview(incoming);
  if (incoming.revision < state.latest.revision) return state;
  if (terminal(state.latest) && !terminal(incoming)) return state;
  if (!proposalVersion(incoming)) return createProposalReview(incoming);
  if (!proposalVersion(state.displayed)) return createProposalReview(incoming);
  if (
    !sameProposalVersion(
      proposalVersion(state.displayed),
      proposalVersion(incoming),
    )
  ) {
    return { ...state, latest: incoming, acknowledged: null, required: true };
  }
  return state.latest === incoming ? state : { ...state, latest: incoming };
}

export function openUpdatedProposal(
  state: ProposalReview,
  expectedRunId: string,
): ProposalReview {
  const version = proposalVersion(state.latest);
  if (!version || version.runId !== expectedRunId) return state;
  return {
    ...state,
    displayed: state.latest,
    opened: version,
    acknowledged: null,
    required: true,
  };
}

/** An acknowledgment of B cannot authorize C, even if C arrives during the click. */
export function acknowledgeProposal(
  state: ProposalReview,
  shown: ProposalVersion,
): ProposalReview {
  if (
    !sameProposalVersion(shown, state.opened) ||
    !sameProposalVersion(shown, proposalVersion(state.displayed)) ||
    !sameProposalVersion(shown, proposalVersion(state.latest))
  )
    return state;
  return { ...state, acknowledged: shown, required: false };
}

export function requireProposalReview(state: ProposalReview): ProposalReview {
  return proposalVersion(state.latest)
    ? { ...state, acknowledged: null, opened: null, required: true }
    : state;
}

/** Capture immutable compare-and-swap arguments from the version actually shown. */
export function captureReviewedDecision(
  state: ProposalReview,
  shown: ProposalVersion | null,
  decision: DecisionInput["decision"],
): { runId: string; input: DecisionInput } | null {
  if (
    state.required ||
    !sameProposalVersion(shown, state.acknowledged) ||
    !sameProposalVersion(shown, proposalVersion(state.displayed)) ||
    !sameProposalVersion(shown, proposalVersion(state.latest))
  )
    return null;
  return {
    runId: shown!.runId,
    input: {
      decision,
      revision: shown!.revision,
      fingerprint: shown!.fingerprint,
    },
  };
}
