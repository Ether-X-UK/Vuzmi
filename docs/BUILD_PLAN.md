# Vuzmi build plan

Status: planned delivery baseline, 4 November 2026. All feature checkboxes below start unverified. Creating this plan does not mean the software exists.

Delivery window: Wednesday 4 November through Tuesday 10 November 2026, Europe/London. The target is a working, self-hosted alpha with a coherent interface and one reliable end-to-end workflow. Public SaaS readiness, billing, and App Store distribution are separate milestones.

## Required order

1. Record the product boundary, full architecture, trust model, data model, interfaces, and delivery plan.
2. Design the primary desktop and mobile flows, including failures, approvals, and empty states.
3. Build the first vertical slice, then expand it behind verified contracts.

Implementation can begin once these artifacts are concrete. No additional approval ceremony is implied for routine reversible work already authorized by the founder. New external sends, spend, public publication, production deployments, or destructive operations require their applicable explicit authorization.

## Working assumptions

- Single organization and private/local deployment for the alpha.
- Confirmed first user: a SaaS founder building, operating, marketing, and selling a software business; Vuzmi is its own initial customer.
- Primary complete workflow: founder goal/change brief → plan and retrieved product knowledge → release readiness artifacts → exact-package approval → durable local outbox.
- The first code slice uses a clearly labelled deterministic sandbox plan; it does not claim model reasoning, RAG, or customer delivery.
- The default first-run fixture prepares Vuzmi's own alpha release unless the founder supplies another product brief.
- Provisional stack: TypeScript; React and Vite web; Fastify API; a separate worker; PostgreSQL with pgvector and pg-boss; Expo for the iOS companion.
- Initial code packages are `apps/web`, `apps/api`, and `packages/core` for shared contracts and pure rules. Add the worker, mobile client, or other infrastructure packages when they have a concrete implementation; do not scaffold empty packages for the whole future architecture.
- Backend/dependency packaging must be runnable on existing hardware; Docker is a planned packaging option, but no running daemon was available at the initial check. Web and iOS share API contracts and design tokens where practical.
- Ollama is installed but its service was not initially running. Existing local model manifests include `gemma4:26b-a4b-it-qat` and `hf.co/unsloth/Qwen3.6-27B-GGUF:IQ4_XS`; actual load/inference remains unverified. Use existing assets and do not download models. Resolving the local runtime and proving a real Ollama call is on the critical path.
- Ollama, OpenAI, and Claude use provider adapters; policy-based routing precedes optimization. Paid API providers are disabled by default.
- ZERO additional costs beyond the existing GPT subscription. Use existing hardware and local tooling; no paid API calls, hosted builds, new subscriptions, or paid infrastructure. Verify any eligible subscription credits/sign-in capability before relying on it.
- Existing infrastructure staff accept resource-request issues. [INFRASTRUCTURE_REQUEST.md](INFRASTRUCTURE_REQUEST.md) is an unposted issue draft pending the repository URL and host details. `vuzmi.com` DNS is on Cloudflare; public exposure is not assumed authorized or completed.
- No assumed license choice, public launch, billing integration, or App Store plan.

The architecture document owns final technical decisions and their tradeoffs. Stack revisions should update this plan and implementation contracts together.

## Workstreams and coordination

| Workstream | Ownership and output | Dependency |
| --- | --- | --- |
| Orchestration/product | Scope, contracts, sequencing, integration, release evidence | Founder decisions and findings from all streams |
| Architecture/research | Trust boundaries, storage, worker model, provider contracts, operational risks | Product brief and alpha workflow |
| Design/web | Visual system, desktop/mobile layouts, run review, knowledge, approval states | Product states and shared contracts |
| Backend/runtime | API, persistence, worker, routing, approvals, tools, outbox | Architecture and agreed schemas |
| Knowledge/evaluation | Ingestion, retrieval, citations, memory boundaries, quality fixtures | Document model, provider interfaces, access rules |
| iOS/operations | Companion flows, packaging, local setup, release validation | Stable API and auth contract |

The orchestrator assigns bounded subagent tasks and prevents simultaneous edits to the same files. Independent research and design can proceed concurrently; contract changes and cross-stream integration remain sequential. Tasks report files changed, what was tested, open risks, and whether their result is implemented or only proposed.

## Milestones and calendar

Dates are a working schedule. Acceptance gates determine readiness; a missed gate reduces breadth rather than lowering the truthfulness of the release.

| Day | Deliverable and sequence | Depends on | Acceptance evidence and focused tests |
| --- | --- | --- | --- |
| **1 — Wed 4 Nov** | Finish architecture and build plan; record desktop/mobile design; then create the workspace skeleton and initial sandbox run → review → approval → local artifact slice. | Product defaults and architecture/design artifacts recorded in that order. | The interface labels the sandbox explicitly. A run has real state transitions and an inspectable event sequence. Approval and rejection lead to distinct results. No invented provider call, retrieval, send, or live metric is shown. Build/type checks for created packages and a focused run-transition test pass. |
| **2 — Thu 5 Nov** | Resolve zero-cost local runtime prerequisites; start/connect Ollama; establish PostgreSQL persistence, migrations, worker recovery, provider adapters, configuration, and deterministic routing. Replace in-memory prototype paths required by the acceptance workflow. | Shared run/action/provider contracts, initial UI slice, existing hardware/runtime availability. | A real local Ollama call succeeds and records the model used. A restart preserves queued and waiting runs. Adapter contract tests cover normalized success and failure. OpenAI/Claude stay disabled absent verified zero-cost access. A local-only route cannot fall back to a hosted provider. |
| **3 — Fri 6 Nov** | Add supported-document ingestion, revisioned chunks/embeddings, retrieval, citations, source deletion, and minimal curated memory boundaries. | Database, worker, embedding/provider interfaces, document ownership model. | A small owned fixture set retrieves the expected source passages. Citations resolve to actual source revisions. Unsupported/empty material is reported. A deleted source does not appear in a later retrieval. Access filtering runs before context is sent to a model. |
| **4 — Sat 7 Nov** | Complete the founder release mission: change brief → real Ollama plan and retrieved evidence → release readiness package → exact-package approval → durable local outbox. Add cancellation, errors, and bounded retries. | Days 2–3 contracts and retrieval quality gate. | An end-to-end browser/API check produces actual plan, acceptance checklist, release notes, risk notes, and deployment handoff files. The package distinguishes proposed work from verified outcomes. Rejection creates no outbox item. Editing an approved payload requires new approval. Restart/retry/replay does not duplicate the action. |
| **5 — Sun 8 Nov** | Build the minimal Expo iOS companion for run list, run detail/evidence, and approve/reject using local tooling; finish responsive web. Add a generic dev/ops sandbox template only if the golden flow is stable. | Stable API/auth and approval semantics; available local iOS build tooling. | A real simulator/device build, if available without added cost, performs the same approval transition as web. Authentication and API errors are visible. UI reflects conflicting/stale approval state. No paid build or App Store dependency is introduced. Optional sandbox execution has no arbitrary host or production access. |
| **6 — Mon 9 Nov** | Package self-host setup, health/readiness, safe configuration, operational logging, backup/restore procedure, and essential CI. Perform integration and accessibility checks. | Working complete workflow and deployable services. | A clean database can migrate and start. Missing secrets/configuration fail clearly. Core logs contain correlation IDs and no credentials. A backup is restored into a separate test database and the saved run remains inspectable. Keyboard use, readable contrast, and narrow-screen operation are checked. |
| **7 — Tue 10 Nov** | Fresh-install rehearsal on existing hardware, real-Ollama founder-release regression, failure rehearsal, documentation, known limitations, and a polished deployable alpha candidate. | All mandatory alpha gates below. | A person follows setup instructions without private knowledge or new spending, produces and approves a concrete release package through real local inference, and retrieves its saved result. Provider/iOS matrices show honest incomplete statuses. No full development/sales lifecycle, public SaaS, or App Store claim is inferred. |

## Mandatory alpha gates

### Foundation and installation

- [ ] Architecture, product boundary, and primary UI flows are recorded before implementation.
- [ ] Workspace packages build and type-check with reproducible dependency installation.
- [ ] Backend dependencies start through documented self-host commands.
- [ ] The local Ollama service is running/reachable and an existing suitable model loads successfully without a new model download.
- [ ] The required database/runtime works on the local testbed despite the initially unavailable Docker daemon; any infrastructure dependency has an identified owner.
- [ ] All exercised paths add no service cost, and paid provider routes are disabled by default.
- [ ] Migrations work on a clean database and preserve existing run data when applied again.
- [ ] Authentication/access configuration is appropriate to the documented private deployment boundary; exposed endpoints do not rely on a demo identity.
- [ ] Environment examples contain placeholders, and logs do not print provider secrets.

### Execution and authority

- [ ] A generic versioned workflow creates a persistent run with correlated steps and events.
- [ ] Shared contracts use the canonical states `queued`, `running`, `waiting_approval`, `completed`, `failed`, and `cancelled` consistently across clients and runtime.
- [ ] Sandbox plans and artifacts are visibly identified as local simulation.
- [ ] A run can wait for approval, resume, fail, be rejected, and be cancelled with clear state.
- [ ] Approval binds to a specific payload revision, actor, and intended action.
- [ ] Replays and worker restarts do not create duplicate outbox items.
- [ ] Retries are bounded, and non-retryable failures have actionable messages.
- [ ] No default workflow performs external sends, spend, privileged host execution, or production deployment.

### Providers and knowledge

- [ ] Each of Ollama, OpenAI, and Claude has an implemented adapter contract and documented configuration.
- [ ] Real Ollama compatibility is verified; OpenAI/Claude are separately marked verified, unavailable, or unverified without assuming subscription API access.
- [ ] Routing records its reason and fails closed when local-only or other hard policy cannot be met.
- [ ] Retrieval filters sources by the applicable workspace/access scope.
- [ ] A founder release package cites real retrieved passages, handles insufficient evidence visibly, and does not invent test/deployment results.
- [ ] Updated/deleted sources no longer produce stale active retrieval results.
- [ ] Durable memory is explicit, scoped, inspectable, and deletable; raw conversations are not silently promoted into memory.

### Client and operational readiness

- [ ] Web completes the golden workflow and shows empty, waiting, failed, rejected, and completed states.
- [ ] A real Ollama run produces a concrete downloadable/inspectable plan, acceptance checklist, release notes, risks, and deployment handoff package.
- [ ] The iOS companion has a documented build result and feature matrix; a preview or web shell is not presented as a successful native build.
- [ ] Run status and action results survive a backend/worker restart.
- [ ] A documented backup/restore rehearsal succeeds in a separate test database.
- [ ] The quickstart and release notes state real limitations and verified test results.

An unchecked mandatory gate means the result remains an incomplete alpha. A good-looking interface alone cannot satisfy it.

## Testing strategy

Tests should protect actual product risks rather than reproduce implementation details.

| Layer | Purpose | Minimum useful coverage |
| --- | --- | --- |
| Domain and policy tests | Prevent unauthorized or inconsistent state transitions | Approval invalidation, rejection, cancellation, local-only routing, retry eligibility |
| Adapter contract tests | Keep provider behavior consistent | Normalized content/usage, unsupported capability, invalid configuration, timeout, retryable/non-retryable errors |
| Database/worker integration tests | Prove persistence and safe replay | Waiting-run restart, unique action identity, duplicate job delivery, migration and restore |
| Retrieval evaluation fixtures | Check groundedness and lifecycle | Expected source selection, real citation provenance, insufficient evidence, deletion and access filtering |
| One golden end-to-end flow | Prove user value across boundaries | Connect local Ollama → ingest product knowledge → change brief → plan/release artifacts with evidence → approve → local package/outbox |
| Focused failure flows | Prove honest and safe degradation | Provider unavailable, route blocked, failed ingestion, rejected/stale approval |
| Native/client smoke check | Verify actual client delivery | iOS build/start/auth/run detail/approval and responsive web keyboard operation |

Unit and contract checks use fixtures without secrets. A successful mock test is not evidence of live-provider support. Real Ollama inference is required for the complete alpha; other live smoke tests require verified existing zero-cost eligibility. Tests that cause external send, spend, or system change require the corresponding authorization. An existing GPT subscription is not evidence of API entitlement.

## Cut lines if time is tight

Protect the golden workflow, authorization, durable state, safe egress, accurate UI, and repeatable setup first.

Cut in this order:

1. Decorative motion, dashboard density, extra themes, and nonessential analytics.
2. Optional dev/ops sandbox templates and additional document formats.
3. Extra workflow templates, advanced memory editing, and provider performance comparisons.
4. iOS secondary screens; preserve run review/approval where the native build is viable.
5. Live external connectors and any automatic publication or outreach.

Do not replace missing persistence, authorization, or real retrieval with concealed fixtures to meet a date. If native tooling or credentials prevent validation, document the exact gap and carry the incomplete gate forward. Public billing, customer-facing autonomy, and multi-tenant hosting are already outside the one-week baseline.

## Ordered backlog after the alpha

### Phase 1 — Internal reliability and design partners

Entry: the real-Ollama founder release mission passes the alpha gates.

- Run Vuzmi on owned change briefs and product/release documents; measure workflow success, retrieval quality, review effort, latency, and failure recovery.
- Add the first founder-selected connector, with scoped credentials and an approved-action boundary.
- Add a safe development/IT workflow: issue/context → plan → isolated execution or artifact → diff/report → approval → configured action. Sandbox and permission design precede execution capability.
- Harden retention, deletion, backup restore, audit access, and secret management.
- Improve iOS distribution for a small test group when build/signing prerequisites are available.
- Onboard a few design partners in isolated deployments with explicit usage limits and support expectations.

Exit: real users repeatedly complete the chosen task, serious safety/reliability failures are resolved, and the team can restore a failed deployment.

### Phase 2 — Hosted beta and commercial foundation

Entry: design-partner evidence, available existing infrastructure capacity, and an explicit commercial plan. The zero-added-cost constraint remains until the founder changes it; this phase does not authorize spend.

- Validate tenant isolation end to end, including jobs, files, embeddings, secrets, caches, logs, and backups.
- Add production identity/session management, scoped roles, abuse controls, operational monitoring, incident handling, and tested disaster recovery.
- Establish data handling, retention/export/deletion, provider terms, and the chosen open-source license before public promises.
- Build hosted onboarding, subscriptions, entitlements, metering, usage limits, and reconciliation. Verify payment callbacks and retries before charging real customers.
- Define pricing from customer value and actual service/provider costs; expose provider usage and distinguish estimates from invoices.
- Publish source, self-host instructions, security reporting, and support boundaries with an explicit release process.

Exit: a limited hosted cohort can onboard, pay, obtain support, export/delete its data, and survive service failure without cross-tenant exposure.

### Phase 3 — Broader business orchestration

Entry: stable shared execution, connector, and policy contracts.

- Expand support channel integrations, escalation, service metrics, and feedback.
- Add development/IT delivery workflows with isolated runners, CI feedback, diff review, environment policies, and staged deployment authority.
- Add marketing campaigns, approved asset/publication flows, scheduling, and attribution.
- Add sales/CRM records, permitted lead ingestion, qualification, drafts, approved outreach, follow-up, and pipeline reporting.
- Add workflow composition, schedules, richer agent memory, retrieval evaluation, and model-policy experiments.
- Expand native mobile coverage where it helps users intervene and make decisions.

Exit: each domain uses the same auditable run/action system and can demonstrate its own outcome and recovery tests.

### Phase 4 — Vuzmi operates and sells Vuzmi

Entry: the relevant workflows have measured quality, bounded permissions, and an owner for exceptions.

- Use Vuzmi to triage its repository, prepare changes and release notes, assemble support responses, and surface operational incidents.
- Run an approved launch process: positioning → landing content → campaign proposal → publication approval → attribution → learning.
- Run an approved sales process: permitted lead source → qualification → outreach draft → approval → authorized send → CRM update → reply handling.
- Automate onboarding, trial assistance, support, usage follow-up, and renewal tasks under published policies.
- Gradually permit bounded unattended actions only after evaluations, idempotency, spend limits, escalation, and recovery are proven.

The product goal is extensive automation. The release process must continue to distinguish agent proposals, human-approved execution, and independently verified outcomes.

## Confirmed decisions and remaining inputs

| Decision/input | Confirmed position or outstanding input | Effect on delivery |
| --- | --- | --- |
| First buyer and highest-value workflow | Confirmed: SaaS founder; build → operate → market → sell. First mission is founder release readiness. | Workflow copy, data fixtures, artifacts, and priority modules |
| Definition of success in one week | Confirmed: polished deployable alpha with one reliable end-to-end flow. | Real Ollama inference plus concrete approved local output, packaging, and release evidence |
| Models, machine, hosting, and budget | Confirmed: existing hardware, local testbed, zero extra cost. Need exact host capacity/model inventory and any verified eligible API access. | Runtime prerequisites, Ollama model selection, infrastructure issue, and provider gating |
| License/commercial constraints | Full code open source; license undecided | Repository license, distribution terms, and hosted-service positioning |
| Infrastructure request repository | Required before posting; existing staff manage resources and Cloudflare DNS for `vuzmi.com`. | Draft remains local until a concrete destination and authorized request are available |
| First external integration | Local change brief and artifact outbox; later integration undecided | Connector implementation and authorization tests |
| iOS distribution expectation | Expo companion with local tooling; no paid build/App Store plan assumed | Actual local build availability and companion scope |

Revise the plan as remaining inputs arrive. The founder mission, zero-added-cost constraint, trust boundaries, and truthful reporting remain requirements.
