import { z } from "zod";
import type { Run } from "./index.js";

export const workflowRefSchema = z
  .object({ id: z.literal("founder-release"), version: z.literal(1) })
  .strict();
export type WorkflowRef = z.infer<typeof workflowRefSchema>;
export const founderReleaseWorkflowRef: Readonly<WorkflowRef> = Object.freeze({
  id: "founder-release",
  version: 1,
});
export const founderReleaseWorkflow = Object.freeze({
  ...founderReleaseWorkflowRef,
  label: "Founder release preparation",
  steps: Object.freeze([
    Object.freeze({ id: "prepare" as const, label: "Record mission" }),
    Object.freeze({
      id: "retrieve" as const,
      label: "Retrieve selected evidence",
    }),
    Object.freeze({ id: "draft" as const, label: "Draft local brief" }),
    Object.freeze({ id: "review" as const, label: "Human review" }),
    Object.freeze({ id: "save" as const, label: "Save approved artifact" }),
  ]),
});
export const workflowRegistry = Object.freeze({
  "founder-release@1": founderReleaseWorkflow,
});
export type WorkflowStepId =
  (typeof founderReleaseWorkflow.steps)[number]["id"];
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled"
  | "blocked";
export interface WorkflowStep {
  id: WorkflowStepId;
  label: string;
  status: WorkflowStepStatus;
  detail: string;
  eventSequences: number[];
}

export function getRunWorkflowLabel(run: Run): string {
  return run.workflow
    ? `${founderReleaseWorkflow.label} · v${run.workflow.version}`
    : "Legacy workflow · version unknown";
}

/** Read-only display projection, never a scheduler or second mutable workflow state. */
export function deriveRunSteps(run: Run): WorkflowStep[] {
  const sequences = (...types: string[]) =>
    run.events
      .filter((event) => types.includes(event.type))
      .map((event) => event.sequence);
  const has = (type: string) => run.events.some((event) => event.type === type);
  const ended = ["completed", "cancelled", "failed"].includes(run.status);
  const failureTypes = ["generation.failed", "generation.exhausted"];
  const failureSequences = sequences(...failureTypes);
  const make = (
    id: WorkflowStepId,
    status: WorkflowStepStatus,
    detail: string,
    eventSequences: number[],
    label?: string,
  ): WorkflowStep => ({
    id,
    label:
      label ??
      founderReleaseWorkflow.steps.find((step) => step.id === id)!.label,
    status,
    detail,
    eventSequences,
  });
  const prepared = has("run.created") || has("run.queued");
  const prepare = make(
    "prepare",
    prepared ? "completed" : ended ? "blocked" : "pending",
    prepared
      ? "The mission brief was recorded locally. This does not verify any proposed checks."
      : "No mission-recorded event is available in this history.",
    sequences("run.created", "run.queued"),
  );

  const retrievalRecorded = has("retrieval.completed");
  const matched = Boolean(
    run.knowledge && retrievalRecorded && run.evidence?.status === "matched",
  );
  let retrieve: WorkflowStep;
  if (!run.knowledge) {
    retrieve = make(
      "retrieve",
      "skipped",
      "No evidence was selected; retrieval was not required or performed.",
      [],
    );
  } else if (matched) {
    retrieve = make(
      "retrieve",
      "completed",
      "Selected evidence passages were recorded. Their claims still require review.",
      sequences("retrieval.completed"),
    );
  } else if (retrievalRecorded && run.evidence?.status === "insufficient") {
    retrieve = make(
      "retrieve",
      "failed",
      "Required evidence was insufficient. This does not authorize ungrounded generation.",
      sequences("retrieval.completed", ...failureTypes),
    );
  } else if (run.status === "failed") {
    retrieve = make(
      "retrieve",
      "failed",
      "Required retrieval did not complete successfully before the mission failed.",
      failureSequences,
    );
  } else if (ended) {
    retrieve = make(
      "retrieve",
      "blocked",
      "No successful retrieval event and evidence snapshot are recorded.",
      sequences("retrieval.completed"),
    );
  } else {
    const working = run.status === "running" && has("generation.started");
    retrieve = make(
      "retrieve",
      working ? "running" : "pending",
      working
        ? "The worker is preparing required evidence; no successful retrieval is recorded yet."
        : "Required retrieval awaits the worker or a bounded retry.",
      sequences("generation.started", "generation.retry_scheduled"),
    );
  }

  const simulation = run.mode === "simulation";
  const draftLabel = simulation
    ? "Prepare deterministic template"
    : "Draft local brief";
  const draftCompleted = Boolean(
    run.proposal &&
      (simulation
        ? has("simulation.prepared") && !run.route.executed
        : has("generation.completed") && run.route.executed),
  );
  let draft: WorkflowStep;
  if (draftCompleted) {
    draft = make(
      "draft",
      "completed",
      simulation
        ? "A deterministic local template was assembled. No model, retrieval, repository inspection, tests, or deployment ran."
        : "A local model draft was recorded. Proposed checks and external actions have not been executed.",
      sequences(
        simulation ? "simulation.prepared" : "generation.started",
        "generation.completed",
        "generation.retry_scheduled",
      ),
      draftLabel,
    );
  } else if (run.knowledge && !matched) {
    const blocked =
      retrieve.status === "failed" || retrieve.status === "blocked";
    draft = make(
      "draft",
      blocked ? "blocked" : "pending",
      blocked
        ? "Draft generation is blocked because required evidence was not established."
        : "Draft generation awaits successful required retrieval.",
      failureSequences,
      draftLabel,
    );
  } else if (run.status === "failed") {
    draft = make(
      "draft",
      "failed",
      "No accepted draft was recorded before local execution failed.",
      sequences(
        "generation.started",
        "generation.retry_scheduled",
        ...failureTypes,
      ),
      draftLabel,
    );
  } else if (ended) {
    draft = make(
      "draft",
      "blocked",
      "No draft completion event with accepted output is recorded.",
      sequences("generation.started", ...failureTypes),
      draftLabel,
    );
  } else {
    const working = run.status === "running" && has("generation.started");
    draft = make(
      "draft",
      working ? "running" : "pending",
      working
        ? "Local draft preparation is in progress; no completed output is recorded."
        : "No completed draft is recorded; local execution awaits the worker or retry.",
      sequences("generation.started", "generation.retry_scheduled"),
      draftLabel,
    );
  }

  const approved =
    has("approval.approved") && run.decision?.decision === "approve";
  const rejected =
    has("approval.rejected") && run.decision?.decision === "reject";
  let review: WorkflowStep;
  if (approved || rejected) {
    review = make(
      "review",
      approved ? "completed" : "cancelled",
      approved
        ? "A human approved the exact recorded action fingerprint and revision."
        : "A human rejected the proposal. No local save was authorized.",
      sequences("approval.requested", "approval.approved", "approval.rejected"),
    );
  } else if (has("approval.requested") && run.status === "waiting_approval") {
    review = make(
      "review",
      "waiting_approval",
      "The exact draft awaits a human decision; no approval is implied.",
      sequences("approval.requested"),
    );
  } else {
    review = make(
      "review",
      ended ? "blocked" : "pending",
      ended
        ? "No human decision event was recorded before the mission ended."
        : "Human review awaits an accepted draft.",
      failureSequences,
    );
  }
  const saved = Boolean(
    has("artifact.saved") &&
      approved &&
      run.artifact &&
      run.proposal &&
      run.artifact.content === run.proposal.content,
  );
  const save = saved
    ? make(
        "save",
        "completed",
        "The exact approved document was saved locally. No external send, publication, or deployment occurred.",
        sequences("approval.approved", "artifact.saved"),
      )
    : rejected
      ? make(
          "save",
          "cancelled",
          "The rejected proposal was not saved as an approved artifact.",
          sequences("approval.rejected"),
        )
      : make(
          "save",
          ended ? "blocked" : "pending",
          ended
            ? "No confirmed approved artifact-save event is recorded."
            : "A local artifact can be saved only after exact human approval.",
          failureSequences,
        );
  return [prepare, retrieve, draft, review, save];
}
