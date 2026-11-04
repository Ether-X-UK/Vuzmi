import { z } from "zod";

export const domainSchema = z.enum([
  "build",
  "operate",
  "support",
  "market",
  "sell",
]);
export type Domain = z.infer<typeof domainSchema>;
export const domainLabels: Record<Domain, string> = {
  build: "Build",
  operate: "Operate",
  support: "Support",
  market: "Market",
  sell: "Sell",
};
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const createRunSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    brief: z.string().trim().min(10).max(6000),
    domain: domainSchema.default("build"),
  })
  .strict();
export type CreateRunInput = z.infer<typeof createRunSchema>;
export const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
  })
  .strict();
export type DecisionInput = z.infer<typeof decisionSchema>;
export const runEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.string(),
  occurredAt: z.string().datetime(),
  message: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;
export const proposalSchema = z.object({
  kind: z.literal("save_local_artifact"),
  destination: z.literal("Local artifact library"),
  content: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const runSchema = z.object({
  id: z.string(),
  workspaceId: z.literal("local-workspace"),
  title: z.string(),
  brief: z.string(),
  domain: domainSchema,
  status: runStatusSchema,
  mode: z.literal("simulation"),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  route: z.object({
    policy: z.literal("local_only"),
    provider: z.literal("ollama"),
    model: z.null(),
    executed: z.literal(false),
    reason: z.string(),
  }),
  proposal: proposalSchema,
  events: z.array(runEventSchema),
  decision: z
    .object({
      decision: z.enum(["approve", "reject"]),
      fingerprint: z.string(),
      revision: z.number().int().positive(),
      actor: z.literal("local-operator"),
      decidedAt: z.string().datetime(),
    })
    .optional(),
  artifact: z
    .object({
      id: z.string(),
      content: z.string(),
      savedAt: z.string().datetime(),
    })
    .optional(),
});
export type Run = z.infer<typeof runSchema>;
export const storedStateSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(runSchema),
});
export type StoredState = z.infer<typeof storedStateSchema>;
export type WorkspaceSnapshot = {
  workspace: {
    id: "local-workspace";
    name: string;
    mode: "simulation";
    storage: "local_file";
    cloudExecution: false;
  };
  runs: Run[];
};

export class DomainError extends Error {
  constructor(
    public readonly code: "STALE_APPROVAL" | "ALREADY_DECIDED",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function simulationContent(input: CreateRunInput): string {
  return [
    `# ${input.title}`,
    "",
    "> LOCAL SIMULATION — deterministic template. No model, retrieval, repository inspection, tests, deployment, or external communication was performed.",
    "",
    "## Mission brief",
    input.brief,
    "",
    "## Proposed release preparation",
    "- Define the smallest user-visible outcome and record the acceptance criteria.",
    "- Gather the current product context and identify missing evidence.",
    "- Prepare a change plan, release notes, known limitations, and an infrastructure handoff.",
    "- Review the exact package before authorizing any subsequent action.",
    "",
    "## Checks still to perform",
    "- [ ] Inspect the actual changes and verify the scope.",
    "- [ ] Run the appropriate tests and record their real results.",
    "- [ ] Validate configuration, recovery, accessibility, and deployment prerequisites.",
    "- [ ] Review release copy and confirm who can approve deployment or publication.",
    "",
    "## Handoff boundary",
    "Approval saves this document to the local artifact library. It does not change code, ship a release, post an infrastructure issue, publish content, or contact customers.",
    "",
    "## Next foundation work",
    "Connect a verified local Ollama runtime, PostgreSQL-backed execution, and versioned knowledge before calling this a model-driven alpha workflow.",
  ].join("\n");
}

export function createSimulationRun(
  input: CreateRunInput,
  context: { id: string; now: string; fingerprint: (value: string) => string },
): Run {
  const action = {
    kind: "save_local_artifact" as const,
    destination: "Local artifact library" as const,
    content: simulationContent(input),
  };
  return {
    id: context.id,
    workspaceId: "local-workspace",
    ...input,
    status: "waiting_approval",
    mode: "simulation",
    revision: 1,
    createdAt: context.now,
    updatedAt: context.now,
    route: {
      policy: "local_only",
      provider: "ollama",
      model: null,
      executed: false,
      reason:
        "Local-only is the intended policy. This simulator made no provider request; cloud execution is disabled.",
    },
    proposal: {
      ...action,
      fingerprint: context.fingerprint(JSON.stringify(action)),
    },
    events: [
      {
        sequence: 1,
        type: "run.created",
        occurredAt: context.now,
        message: "Local simulation created from the mission brief.",
      },
      {
        sequence: 2,
        type: "simulation.prepared",
        occurredAt: context.now,
        message:
          "Deterministic release-preparation template assembled. No model was contacted.",
      },
      {
        sequence: 3,
        type: "approval.requested",
        occurredAt: context.now,
        message: "Exact local artifact is ready for review.",
      },
    ],
  };
}

export function decideRun(run: Run, input: DecisionInput, now: string): Run {
  if (run.decision) {
    if (
      run.decision.decision === input.decision &&
      run.decision.fingerprint === input.fingerprint &&
      run.decision.revision === input.revision
    )
      return run;
    throw new DomainError(
      "ALREADY_DECIDED",
      "This proposal has already been decided. Refresh the run to see its saved state.",
    );
  }
  if (
    input.revision !== run.revision ||
    input.fingerprint !== run.proposal.fingerprint
  ) {
    throw new DomainError(
      "STALE_APPROVAL",
      "The proposal has changed. Refresh and review the exact current result.",
    );
  }
  if (run.status !== "waiting_approval") {
    throw new DomainError(
      "ALREADY_DECIDED",
      "This run is not waiting for a decision.",
    );
  }
  const approved = input.decision === "approve";
  const next: Run = {
    ...run,
    status: approved ? "completed" : "cancelled",
    revision: run.revision + 1,
    updatedAt: now,
    decision: { ...input, actor: "local-operator", decidedAt: now },
    events: [
      ...run.events,
      {
        sequence: run.events.length + 1,
        type: approved ? "approval.approved" : "approval.rejected",
        occurredAt: now,
        message: approved
          ? "Local operator approved this exact artifact."
          : "Local operator rejected the proposal. No artifact was saved.",
      },
    ],
  };
  if (approved) {
    next.artifact = {
      id: `artifact-${run.id}`,
      content: run.proposal.content,
      savedAt: now,
    };
    next.events.push({
      sequence: next.events.length + 1,
      type: "artifact.saved",
      occurredAt: now,
      message:
        "Approved artifact saved in the local workspace. No external action was performed.",
    });
  }
  return next;
}
