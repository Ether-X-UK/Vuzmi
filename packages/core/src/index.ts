import { z } from "zod";
import {
  evidenceSelectionSchema,
  evidenceSnapshotSchema,
} from "./knowledge.js";
import { founderReleaseWorkflowRef, workflowRefSchema } from "./workflow.js";
import { extractDraftBody } from "./document.js";
import {
  draftRevisionSchema,
  validateDraftRevisionIntegrity,
} from "./draft-revision.js";
export * from "./knowledge.js";
export * from "./auth.js";
export * from "./outbox.js";
export * from "./workflow.js";
export * from "./document.js";
export * from "./draft-revision.js";

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
    mode: z.enum(["simulation", "ollama"]).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    knowledge: evidenceSelectionSchema.optional(),
  })
  .strict()
  .refine(
    (value) => !value.knowledge || value.mode === "ollama",
    "Required knowledge is supported only for local model missions.",
  );
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
  mode: z.enum(["simulation", "ollama"]),
  workflow: workflowRefSchema.optional(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  route: z.object({
    policy: z.literal("local_only"),
    provider: z.literal("ollama"),
    model: z.string().nullable(),
    executed: z.boolean(),
    reason: z.string(),
  }),
  proposal: proposalSchema.nullable(),
  events: z.array(runEventSchema),
  knowledge: evidenceSelectionSchema.optional(),
  evidence: evidenceSnapshotSchema.optional(),
  draftRevisions: z.array(draftRevisionSchema).max(10).optional(),
  attemptId: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      durationMs: z.number().nonnegative().nullable(),
    })
    .optional(),
  error: z
    .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
    .optional(),
  decision: z
    .object({
      decision: z.enum(["approve", "reject"]),
      fingerprint: z.string(),
      revision: z.number().int().positive(),
      actor: z.string().min(1),
      actorName: z.string().min(1).optional(),
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
export type Proposal = z.infer<typeof proposalSchema>;
export type Usage = NonNullable<Run["usage"]>;
export const storedStateSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(runSchema),
});
export type StoredState = z.infer<typeof storedStateSchema>;
export type WorkspaceSnapshot = {
  workspace: {
    id: "local-workspace";
    name: string;
    mode: "simulation" | "local";
    storage: "local_file" | "postgres";
    cloudExecution: false;
  };
  runs: Run[];
};

export const localModelSchema = z.object({
  name: z.string(),
  digest: z.string(),
  sizeBytes: z.number().nonnegative(),
  parameterSize: z.string().nullable(),
  quantization: z.string().nullable(),
  capabilities: z.array(z.string()),
  contextLength: z.number().nullable(),
});
export const runtimeInfoSchema = z.object({
  storage: z.enum(["local_file", "postgres"]),
  liveAvailable: z.boolean(),
  checkedAt: z.string().datetime(),
  worker: z.object({
    state: z.enum(["ready", "offline", "not_configured"]),
    lastSeenAt: z.string().datetime().nullable(),
  }),
  ollama: z.object({
    reachable: z.boolean(),
    models: z.array(localModelSchema),
    configuredModel: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>;

export class DomainError extends Error {
  constructor(
    public readonly code:
      | "STALE_APPROVAL"
      | "ALREADY_DECIDED"
      | "INVALID_STATE",
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
    "## Verification boundary",
    "This run used the deterministic simulation. Inspect Model control and choose Local Ollama for an actual model call; select ready knowledge explicitly when grounded output is required.",
  ].join("\n");
}

export function createSimulationRun(
  input: CreateRunInput,
  context: { id: string; now: string; fingerprint: (value: string) => string },
): Run & { mode: "simulation"; proposal: Proposal } {
  const action = {
    kind: "save_local_artifact" as const,
    destination: "Local artifact library" as const,
    content: simulationContent(input),
  };
  return {
    id: context.id,
    workspaceId: "local-workspace",
    title: input.title,
    brief: input.brief,
    domain: input.domain,
    status: "waiting_approval",
    mode: "simulation",
    workflow: { ...founderReleaseWorkflowRef },
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

export function decideRun(
  run: Run,
  input: DecisionInput,
  now: string,
  actor?: { id: string; name: string },
): Run {
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
  if (!run.proposal || run.status !== "waiting_approval") {
    throw new DomainError(
      "INVALID_STATE",
      "This run has no proposal ready for a decision.",
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
    decision: {
      ...input,
      actor: actor?.id ?? "local-operator",
      ...(actor ? { actorName: actor.name } : {}),
      decidedAt: now,
    },
    events: [
      ...run.events,
      {
        sequence: run.events.length + 1,
        type: approved ? "approval.approved" : "approval.rejected",
        occurredAt: now,
        message: approved
          ? `${actor ? "Workspace owner" : "Local operator"} approved this exact artifact.`
          : `${actor ? "Workspace owner" : "Local operator"} rejected the proposal. No artifact was saved.`,
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

type RunContext = { id: string; now: string; model: string };
type CompletionContext = {
  attemptId: string;
  expectedRevision: number;
  content: string;
  usage: Usage;
  now: string;
  fingerprint: (value: string) => string;
};
type FailureContext = {
  attemptId: string;
  expectedRevision: number;
  error: NonNullable<Run["error"]>;
  willRetry: boolean;
  now: string;
};

function addEvent(
  run: Run,
  type: string,
  message: string,
  now: string,
): RunEvent[] {
  return [
    ...run.events,
    { sequence: run.events.length + 1, type, message, occurredAt: now },
  ];
}

export function createQueuedRun(
  input: CreateRunInput,
  context: RunContext,
): Run {
  return {
    id: context.id,
    workspaceId: "local-workspace",
    title: input.title,
    brief: input.brief,
    domain: input.domain,
    mode: "ollama",
    workflow: { ...founderReleaseWorkflowRef },
    knowledge: input.knowledge,
    status: "queued",
    revision: 1,
    createdAt: context.now,
    updatedAt: context.now,
    proposal: null,
    route: {
      policy: "local_only",
      provider: "ollama",
      model: context.model,
      executed: false,
      reason:
        "Selected an eligible installed local model. Cloud execution and fallback are disabled.",
    },
    events: [
      {
        sequence: 1,
        type: "run.queued",
        occurredAt: context.now,
        message:
          "Local Ollama run queued for the worker. No model output exists yet.",
      },
    ],
  };
}

export function claimGeneration(
  run: Run,
  context: { attemptId: string; now: string; allowRecovery?: boolean },
): Run | undefined {
  if (
    run.mode !== "ollama" ||
    (run.status !== "queued" &&
      !(context.allowRecovery && run.status === "running"))
  )
    return undefined;
  return {
    ...run,
    status: "running",
    revision: run.revision + 1,
    updatedAt: context.now,
    attemptId: context.attemptId,
    error: undefined,
    events: addEvent(
      run,
      "generation.started",
      context.allowRecovery && run.status === "running"
        ? "Worker recovered an interrupted generation attempt."
        : "Worker started the configured local Ollama generation.",
      context.now,
    ),
  };
}

export function completeGeneration(
  run: Run,
  context: CompletionContext,
): Run | undefined {
  if (
    run.status !== "running" ||
    run.attemptId !== context.attemptId ||
    run.revision !== context.expectedRevision
  )
    return undefined;
  if (!context.content.trim() || context.content.length > 100_000)
    throw new DomainError(
      "INVALID_STATE",
      "The generated document is empty or exceeds the supported size.",
    );
  if (run.knowledge && run.evidence?.status !== "matched")
    throw new DomainError(
      "INVALID_STATE",
      "Required evidence must be recorded before a generated draft can be accepted.",
    );
  const action = {
    kind: "save_local_artifact" as const,
    destination: "Local artifact library" as const,
    content: context.content,
  };
  const generated: Run = {
    ...run,
    status: "waiting_approval",
    revision: run.revision + 1,
    updatedAt: context.now,
    proposal: {
      ...action,
      fingerprint: context.fingerprint(JSON.stringify(action)),
    },
    route: { ...run.route, executed: true },
    usage: context.usage,
    error: undefined,
    events: addEvent(
      run,
      "generation.completed",
      run.evidence?.status === "matched"
        ? "Local Ollama returned a draft using the recorded evidence. Its claims still require review; no tools were run."
        : "Local Ollama returned a draft. Its factual claims remain unverified; no tools or retrieval were run.",
      context.now,
    ),
  };
  generated.events = addEvent(
    generated,
    "approval.requested",
    "Exact generated local artifact is ready for human review.",
    context.now,
  );
  return generated;
}

export function attachEvidence(
  run: Run,
  context: {
    attemptId: string;
    expectedRevision: number;
    evidence: import("./knowledge.js").EvidenceSnapshot;
    now: string;
  },
): Run | undefined {
  if (
    run.mode !== "ollama" ||
    !run.knowledge ||
    run.status !== "running" ||
    run.attemptId !== context.attemptId ||
    run.revision !== context.expectedRevision
  )
    return undefined;
  if (run.evidence) return run;
  const evidence = evidenceSnapshotSchema.parse(context.evidence);
  if ((evidence.status === "matched") !== evidence.items.length > 0)
    throw new DomainError(
      "INVALID_STATE",
      "Evidence status does not match its recorded passages.",
    );
  return {
    ...run,
    evidence,
    revision: run.revision + 1,
    updatedAt: context.now,
    events: addEvent(
      run,
      "retrieval.completed",
      evidence.status === "matched"
        ? `Recorded ${evidence.items.length} selected evidence passages for review. Source claims remain unverified.`
        : "Required evidence was insufficient. No model generation is authorized.",
      context.now,
    ),
  };
}

export function failGeneration(
  run: Run,
  context: FailureContext,
): Run | undefined {
  if (
    run.status !== "running" ||
    run.attemptId !== context.attemptId ||
    run.revision !== context.expectedRevision
  )
    return undefined;
  return {
    ...run,
    status: context.willRetry ? "queued" : "failed",
    revision: run.revision + 1,
    updatedAt: context.now,
    error: context.error,
    events: addEvent(
      run,
      context.willRetry ? "generation.retry_scheduled" : "generation.failed",
      context.willRetry
        ? "The local generation attempt failed. A bounded retry is queued; cloud fallback is disabled."
        : context.error.message,
      context.now,
    ),
  };
}

export function exhaustGeneration(
  run: Run,
  context: { error: NonNullable<Run["error"]>; now: string },
): Run | undefined {
  if (run.mode !== "ollama" || !["queued", "running"].includes(run.status))
    return undefined;
  return {
    ...run,
    status: "failed",
    revision: run.revision + 1,
    updatedAt: context.now,
    error: { ...context.error, retryable: false },
    events: addEvent(
      run,
      "generation.exhausted",
      context.error.message,
      context.now,
    ),
  };
}

/** Validates persisted aggregates; the caller supplies its server-side SHA-256. */
export function parseRunIntegrity(
  value: unknown,
  fingerprint: (value: string) => string,
): Run {
  const run = runSchema.parse(value);
  const invalidSequence = run.events.some(
    (event, index) => event.sequence !== index + 1,
  );
  if (invalidSequence) throw new Error("Invalid run event sequence.");
  const proposal = run.proposal;
  if (run.evidence) {
    if (!run.knowledge || run.mode !== "ollama")
      throw new Error("Evidence has no explicit selection.");
    if ((run.evidence.status === "matched") !== run.evidence.items.length > 0)
      throw new Error("Inconsistent evidence status.");
    const labels = new Set<string>();
    for (const item of run.evidence.items) {
      if (
        labels.has(item.citation) ||
        fingerprint(item.text) !== item.contentHash
      )
        throw new Error("Inconsistent evidence passage.");
      labels.add(item.citation);
    }
  }
  if (proposal && run.knowledge && run.evidence?.status !== "matched")
    throw new Error(
      "Required evidence is missing from the generated proposal.",
    );
  if (proposal) {
    const { kind, destination, content } = proposal;
    // Canonical reference records bind retained provenance as well as excerpts.
    // Legacy arbitrary fixture documents remain readable; real wrapped documents
    // must still match their exact application-owned appendix.
    if (
      run.evidence &&
      (run.evidence.items.some((item) => item.origin) ||
        content.startsWith("> Local Ollama draft — unverified.") ||
        content.startsWith("> Human-revised draft — unverified.")) &&
      extractDraftBody(
        content,
        run.evidence,
        run.draftRevisions?.length ? "human" : "model",
      ) === undefined
    )
      throw new Error(
        "The retained evidence differs from its document reference record.",
      );
    if (
      proposal.fingerprint !==
      fingerprint(JSON.stringify({ kind, destination, content }))
    )
      throw new Error("Inconsistent proposal fingerprint.");
  }
  if (
    run.mode === "simulation" &&
    (!proposal || run.route.executed || run.route.model !== null)
  )
    throw new Error("Inconsistent simulation data.");
  if (run.mode === "ollama" && !run.route.model)
    throw new Error("Missing local model identity.");
  if (
    run.status === "waiting_approval" &&
    (!proposal || run.decision || run.artifact)
  )
    throw new Error("Inconsistent waiting approval data.");
  if (
    run.status === "completed" &&
    (!proposal ||
      run.decision?.decision !== "approve" ||
      run.artifact?.content !== proposal.content)
  )
    throw new Error("Inconsistent approved artifact data.");
  if (
    run.status === "cancelled" &&
    (run.decision?.decision !== "reject" || run.artifact)
  )
    throw new Error("Inconsistent rejected artifact data.");
  if (
    run.decision &&
    (!proposal ||
      run.decision.fingerprint !== proposal.fingerprint ||
      run.decision.revision !== run.revision - 1)
  )
    throw new Error("Inconsistent approval revision.");
  if (
    ["queued", "running", "failed"].includes(run.status) &&
    (proposal || run.decision || run.artifact)
  )
    throw new Error("Unexpected artifact before generation.");
  if (run.status === "running" && !run.attemptId)
    throw new Error("Missing generation attempt identity.");
  validateDraftRevisionIntegrity(run, fingerprint);
  return run;
}

export * from "./github.js";
