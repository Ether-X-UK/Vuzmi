# Vuzmi product brief

Status: proposed product direction, 4 November 2026. This document describes intended behavior; it is not an inventory of working features. See [BUILD_PLAN.md](BUILD_PLAN.md) for delivery gates and current scope.

## Purpose

Vuzmi is an open-source business orchestration platform with a self-hosted backend, a web workspace, and an iOS client. It will bring development and IT operations, client support, marketing, and sales into a common system of agents, workflows, knowledge, memory, and approvals.

Ollama, OpenAI, and Anthropic Claude are planned model backends. Vuzmi should choose a permitted model for the task, explain that choice, preserve useful context, retrieve relevant business knowledge, and show what happened when a workflow runs.

The long-term business is a hosted SaaS offering whose full application code remains open source. Vuzmi should eventually operate much of its own support, product delivery, marketing, and sales through the same capabilities offered to customers. Public release, payment processing, outbound communications, and production changes require explicit operational and product gates.

## Initial customer and mission

The confirmed first customer is a SaaS founder who wants to build, operate, market, and sell a software business. Vuzmi itself is the first internal customer. The first week delivers a polished, deployable alpha with one reliable end-to-end flow; it does not claim to automate that entire business lifecycle.

The initial promise is: **turn a founder's change brief into a traceable, knowledge-grounded release readiness package, with a person controlling consequential actions.**

A single reliable workflow provides a stronger foundation than several disconnected demos. The first complete alpha workflow is the founder release mission:

1. A founder enters a goal or change brief and adds a small, owned collection of product/release documents. The confirmed first workflow prepares Vuzmi's own alpha release and launch assets.
2. The workflow uses a visible local-only routing policy to select an available Ollama model.
3. Retrieval finds permitted source passages and records their revisions.
4. A real model call produces a plan and concrete release readiness artifacts: scope, acceptance checklist, release notes, risks, deployment handoff, and draft launch assets.
5. Claims distinguish known evidence, proposed work, missing information, and unverified readiness; the model cannot mark tests as passed without evidence.
6. A person reviews the brief, evidence, artifacts, and exact intended local action.
7. Approval produces a durable local outbox/artifact package and completion record.
8. Later, separately configured development, deployment, marketing, and sales connectors can execute explicitly authorized actions.

The local outbox is an alpha completion boundary. A saved package must never be described as code implemented, tests passed, a deployment completed, or a customer contacted unless separate recorded evidence proves that action.

The first implementation slice is smaller: create a run, generate an explicitly labelled deterministic sandbox plan, approve it, and produce a local artifact with an event ledger. That slice establishes the interaction and execution contract; real Ollama calls, document retrieval, and the complete founder release mission follow it. The day-seven acceptance gate requires the real Ollama path and a concrete saved output.

## Confirmed operating constraints

- No additional cost beyond the founder's existing GPT subscription. Paid provider API calls, paid hosting, paid build services, and new subscriptions are disabled by default.
- The MacBook M5 with local Ollama is the confirmed testbed. Later deployment uses existing CPU-only infrastructure with ample CPU/RAM; no datacenter GPU is assumed. Capacity is not a current blocker.
- The MacBook M5 testbed now has verified local generation with `qwen3.5:4b` and embeddings with `embeddinggemma:300m`, a private native PostgreSQL16/pgvector database, and a dedicated Vuzmi cloud-disabled Ollama daemon on11435. The user’s usual11434 service is untouched. No Docker daemon or hosted service is required for this native package. These are observed local checks, not a CPU-server benchmark.
- Existing infrastructure staff accept resource-request issues in [XeoNote/Infrastructure-](https://github.com/XeoNote/Infrastructure-/). Repository access and the high-level deployment documentation were verified on 4 November 2026. [INFRASTRUCTURE_REQUEST.md](INFRASTRUCTURE_REQUEST.md) records the request posted with founder authorization on 5 November 2026 as [issue #310](https://github.com/XeoNote/Infrastructure-/issues/310). Target allocation and response remain pending.
- `vuzmi.com` DNS is managed through Cloudflare. DNS edits and public exposure are deployment work, not assumed completed setup.
- Any eligible subscription API credits or supported subscription sign-in capability must be verified against current official documentation and this account's eligibility before use. An existing chat subscription is not treated as general API permission or an available API budget.
- Languages are open; the TypeScript/Expo stack is a provisional implementation choice rather than a founder-imposed requirement.

## Product principles

- One control plane: shared runs, policies, approvals, audit events, and budgets across business domains.
- Visible decisions: show the selected model, routing reason, retrieved evidence, requested actions, status, and failure reason.
- Human authority: external sends, purchases, production deployments, privileged actions, and destructive changes require the applicable approval policy.
- Self-host ownership: business data and secrets remain under the operator's control; provider use and data egress are explicit.
- Honest autonomy: distinguish a suggested plan, a simulated action, an approved action, an attempted action, and a verified result.
- Open implementation: backend, web, iOS, workflow definitions, and necessary self-host instructions belong in the open-source product scope.
- A coherent interface: a distinctive, futuristic visual identity with readable content, accessible controls, responsive layouts, and clear error states.

## One-week alpha boundary

The alpha is a local or privately self-hosted, single-organization system. It is intended for evaluation with owned documents and test requests. It is not a claim of production SaaS readiness.

| Included in the alpha plan                                                                                                                | Deferred until the foundation passes its gates                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Web onboarding and a coherent run/approval interface                                                                                      | Broad connector marketplace and visual workflow builder                                               |
| A persistent generic workflow/run/event model                                                                                             | Unrestricted autonomous agents or arbitrary host command execution                                    |
| Deterministic sandbox workflow, visibly identified as simulation                                                                          | Production deployments and automatic changes to customer systems                                      |
| Real Ollama path; OpenAI and Claude adapter contracts/configuration, disabled by default                                                  | Paid provider calls, learned model routing, or claims of optimal model selection                      |
| Explicit policy-based model routing and safe failure behavior                                                                             | Public multi-tenant hosting and enterprise identity controls                                          |
| Small-document ingestion, retrieval, revision-aware citations, and deletion                                                               | Large-scale document sync, OCR, extensive file formats, and advanced knowledge graphs                 |
| Human-reviewed founder release package and durable local outbox                                                                           | End-to-end autonomous development, live marketing campaigns, cold outbound sales, and automated spend |
| A minimal iOS companion for runs and approvals, if its build gate passes                                                                  | Full web/iOS feature parity, App Store acceptance, and push infrastructure                            |
| Deployable backend packaging, health checks, migration instructions, and essential tests; local runtime prerequisites resolved explicitly | Public billing, subscriptions, tax handling, commercial SLA commitments, and any paid infrastructure  |

Provider compatibility is verified per configured adapter and recorded in a test matrix. A mock or unavailable credential must not be reported as a completed live-provider test.

## Intended product areas

The interface should make these areas feel like one product while indicating availability accurately.

| Area                   | Alpha behavior                                                       | Full product direction                                                                                               |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Overview               | Runs awaiting attention, approvals, basic activity                   | Business health, exceptions, goals, outcomes, and capacity                                                           |
| Workflows              | Founder release mission and explicitly labelled sandbox slice        | Compose, schedule, trigger, evaluate, and reuse workflows                                                            |
| Agents and models      | Provider configuration, role/task settings, route reason             | Specialist agents, capability registry, evaluated selection, bounded autonomy                                        |
| Knowledge and memory   | Upload supported documents, search evidence, inspect provenance      | Connector sync, lifecycle controls, curated memory, feedback and retrieval evaluation                                |
| Support                | Clearly marked roadmap area                                          | Grounded support drafts, inbox integrations, handoffs, escalation, service metrics                                   |
| Development and IT ops | Release planning/readiness artifacts; planned sandbox execution lane | Issue-to-change workflows, isolated execution, CI, review, deployments, incident response, infrastructure operations |
| Marketing              | Clearly marked roadmap area                                          | Campaign planning, asset generation, scheduling, measurement, approved publication                                   |
| Sales                  | Clearly marked roadmap area                                          | CRM workflows, qualification, follow-up, forecasting, approved outreach                                              |
| Settings and audit     | Workspace, providers, policy, runs, and events                       | Roles, connectors, retention, usage, billing, and operational controls                                               |

A roadmap area must not display invented revenue, customers, completed runs, or connected integrations as live facts. Demo fixtures must be labelled and separable from operator data.

## Shared execution contract

A workflow definition is versioned. A run uses a fixed definition version and records its input, routing decision, steps, artifact references, approval requests, and terminal result. Canonical run states are `queued`, `running`, `waiting_approval`, `completed`, `failed`, and `cancelled`. Step retries must preserve action identity.

An approval binds the approving person to a specific action payload or artifact revision. Editing the draft, target, tool parameters, or relevant policy invalidates the prior approval. An approved action should be executed at most once through a durable action record and idempotency key. Approval is not evidence that execution succeeded.

The initial autonomy levels are:

- **Observe:** collect permitted context and report findings.
- **Draft:** propose responses, plans, and artifacts.
- **Execute after approval:** perform a specific authorized action and report its result.

Bounded unattended execution is a later capability that requires explicit policies, scoped permissions, limits, monitoring, and recovery controls. A model cannot grant itself authority or weaken a policy.

## Model selection and data egress

The first router is deterministic and policy based. Its inputs include task type, requested capability, configured provider availability, data sensitivity, local-only requirements, and operator preference. Where reliable price data exists, estimates may inform routing; unknown prices or local inference costs remain visibly unknown.

A local-only request must fail closed if no allowed local model is available. Fallback cannot silently send its data to a hosted provider. Retry and fallback rules need bounded attempts and a visible reason. Usage reports distinguish observed token usage, estimated cost, missing data, and enforced limits.

Provider prompts, retrieved documents, tool responses, and external messages are untrusted input. They cannot override application policy, discover unrelated secrets, or authorize tools. Secret references are resolved at the tool/provider boundary rather than embedded in model-visible configuration.

## Knowledge and memory lifecycle

Knowledge and agent memory have different purposes. Knowledge is a source collection used as evidence. Memory is an explicit retained fact, preference, or workflow lesson with provenance and a defined scope. A conversation is not automatically durable memory.

The planned lifecycle is:

1. **Connect or upload:** record organization, owner, source identity, permissions, content type, and ingestion status.
2. **Normalize and version:** retain a source revision, parse supported content, and assign stable document identity.
3. **Chunk and index:** associate passages and embeddings with their source revision and embedding configuration.
4. **Retrieve:** apply workspace/access filters before model use; return provenance with every selected passage.
5. **Generate:** attach the evidence used to the draft and preserve the routing decision. An unsupported answer is a visible uncertainty or escalation.
6. **Curate memory:** explicitly save approved facts with scope, source, confidence/verification status, and optional expiry.
7. **Update:** re-index changed sources and prevent superseded revisions from appearing as current evidence.
8. **Delete or expire:** remove active originals, extracted content, chunks, embeddings, and related memory according to defined relationships. Preserve only the minimum permissible audit record.

An alpha deletion test covers current application storage. Backup retention, deletion during restore, and hosted retention commitments require an additional beta gate before public service. Logs must avoid raw secrets and unnecessary customer content.

## Alpha success criteria

The week succeeds when a new operator can install the system, connect the available local Ollama service, ingest supported documents, run a founder release mission using a real model call, inspect its citations and concrete release package, approve the exact package, and find a durable local result without developer intervention or additional spending.

The acceptance suite must also show that a rejected approval creates no action, a changed payload requires new approval, a restart does not lose a waiting run, a replay does not duplicate an outbox item, and an unmet local-only policy does not cause remote egress. Source deletion must remove that content from later retrieval.

Real Ollama execution is required for the complete day-seven flow. OpenAI/Claude live checks depend on verified zero-cost eligibility or later explicit budget authorization; they remain disabled otherwise. The final release note must name which adapters were verified, which were tested only through contract fixtures, which flows remain incomplete, and whether an actual iOS build was produced.

## Path to the business

The initial SaaS offer should sell managed operation, convenient onboarding, reliability, updates, and support. A self-hosted operator should be able to use the open-source application without relying on a hidden proprietary backend. The founder selected AGPL-3.0-only; pricing and support commitments remain founder decisions. Current implementation and validation must stay within existing hardware and the zero-additional-cost constraint; commercialization is not authorization to start spending.

Commercialization progresses through evidence-based gates:

1. Use Vuzmi internally on owned briefs, product knowledge, and release readiness packages; measure task success and review effort.
2. Onboard a small number of design partners in isolated deployments; observe real workflow value and operational failures.
3. Validate hosted isolation, recovery, authentication, billing correctness, support, and data handling before charging for public SaaS.
4. Use Vuzmi for its own support and release preparation, then its marketing and sales operations.
5. Permit bounded automatic actions only after per-workflow evaluations, explicit business policy, and operational recovery are proven.

The sales automation loop is eventually: permitted lead source → qualification → proposed outreach → human approval → delivery through an authorized connector → reply/CRM update → attributed outcome. Campaign budgets, actual purchases, publishing, customer messages, and production deployments retain explicit approval until a founder-approved policy grants a bounded exception.

## Remaining decisions

- Choose a concrete resource allocation and deployment handoff when local readiness is demonstrated; the infrastructure repository and ample CPU/RAM are confirmed.
- Validate later CPU-server capacity and representative workflow quality; the local M5 generation and embedding smoke checks have passed.
- Whether this account has any verified eligible API credits or subscription sign-in integration; zero added cost remains mandatory.
- Public source repository destination and hosted pricing/support commitments; AGPL-3.0-only is selected.
- Required first external integration, if any; the alpha uses a local change brief and artifact outbox.
- iOS expectations: a native Expo companion is planned; public distribution is outside the alpha promise.
