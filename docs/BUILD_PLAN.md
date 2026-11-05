# Vuzmi build plan

Status: delivery baseline, 4 November 2026. Checked gates have evidence in [STATUS.md](STATUS.md); unchecked gates remain incomplete.

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
- The confirmed first workflow prepares Vuzmi's own alpha release and launch assets.
- Provisional stack: TypeScript; React and Vite web; Fastify API; a separate worker; PostgreSQL with pgvector and pg-boss; Expo for the iOS companion.
- Initial code packages are `apps/web`, `apps/api`, and `packages/core` for shared contracts and pure rules. Add the worker, mobile client, or other infrastructure packages when they have a concrete implementation; do not scaffold empty packages for the whole future architecture.
- Backend/dependency packaging must be runnable on existing hardware; Docker is a planned packaging option, but no running daemon was available at the initial check. Web and iOS share API contracts and design tokens where practical.
- Ollama was subsequently verified running; initial sandboxed network checks did not establish readiness. The MacBook M5 now runs a dedicated Vuzmi-owned cloud-disabled daemon on 11435, leaving the user's service on 11434 untouched. Existing large models were discovered; the founder-authorized `qwen3.5:4b` download now provides a smaller verified local draft model. Native PostgreSQL 16 supplies the local database without Docker.
- Ollama, OpenAI, and Claude use provider adapters; policy-based routing precedes optimization. Paid API providers are disabled by default.
- ZERO additional costs beyond the existing GPT subscription. Use existing hardware and local tooling; no paid API calls, hosted builds, new subscriptions, or paid infrastructure. Verify any eligible subscription credits/sign-in capability before relying on it.
- Existing infrastructure staff accept resource-request issues. [INFRASTRUCTURE_REQUEST.md](INFRASTRUCTURE_REQUEST.md) records [issue #310](https://github.com/XeoNote/Infrastructure-/issues/310), posted with founder authorization on 5 November 2026 to [XeoNote/Infrastructure-](https://github.com/XeoNote/Infrastructure-/). The later estate is CPU-only with ample CPU/RAM; capacity is not a blocker. Local Mac development precedes the deployment handoff. `vuzmi.com` DNS is on Cloudflare; public exposure is not assumed authorized or completed.
- Confirmed licence: AGPL-3.0-only. Public launch, billing integration and App Store distribution remain separate decisions.

The architecture document owns final technical decisions and their tradeoffs. Stack revisions should update this plan and implementation contracts together.

## Workstreams and coordination

| Workstream            | Ownership and output                                                           | Dependency                                        |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| Orchestration/product | Scope, contracts, sequencing, integration, release evidence                    | Founder decisions and findings from all streams   |
| Architecture/research | Trust boundaries, storage, worker model, provider contracts, operational risks | Product brief and alpha workflow                  |
| Design/web            | Visual system, desktop/mobile layouts, run review, knowledge, approval states  | Product states and shared contracts               |
| Backend/runtime       | API, persistence, worker, routing, approvals, tools, outbox                    | Architecture and agreed schemas                   |
| Knowledge/evaluation  | Ingestion, retrieval, citations, memory boundaries, quality fixtures           | Document model, provider interfaces, access rules |
| iOS/operations        | Companion flows, packaging, local setup, release validation                    | Stable API and auth contract                      |

The orchestrator assigns bounded subagent tasks and prevents simultaneous edits to the same files. Independent research and design can proceed concurrently; contract changes and cross-stream integration remain sequential. Tasks report files changed, what was tested, open risks, and whether their result is implemented or only proposed.

## Milestones and calendar

Dates are a working schedule. Acceptance gates determine readiness; a missed gate reduces breadth rather than lowering the truthfulness of the release.

| Day                | Deliverable and sequence                                                                                                                                                                                                                                                | Depends on                                                                                      | Acceptance evidence and focused tests                                                                                                                                                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Wed 4 Nov**  | Finish architecture and build plan; record desktop/mobile design; then create the workspace skeleton and initial sandbox run → review → approval → local artifact slice.                                                                                                | Product defaults and architecture/design artifacts recorded in that order.                      | The interface labels the sandbox explicitly. A run has real state transitions and an inspectable event sequence. Approval and rejection lead to distinct results. No invented provider call, retrieval, send, or live metric is shown. Build/type checks for created packages and a focused run-transition test pass.                         |
| **2 — Thu 5 Nov**  | Resolve zero-cost local runtime prerequisites; start/connect Ollama; establish PostgreSQL persistence, migrations, worker recovery, provider adapters, configuration, and deterministic routing. Replace in-memory prototype paths required by the acceptance workflow. | Shared run/action/provider contracts, initial UI slice, existing hardware/runtime availability. | A real local Ollama call succeeds and records the model used. A restart preserves queued and waiting runs. Adapter contract tests cover normalized success and failure. OpenAI/Claude stay disabled absent verified zero-cost access. A local-only route cannot fall back to a hosted provider.                                               |
| **3 — Fri 6 Nov**  | Add supported-document ingestion, revisioned chunks/embeddings, retrieval, citations, source deletion, and minimal curated memory boundaries.                                                                                                                           | Database, worker, embedding/provider interfaces, document ownership model.                      | A small owned fixture set retrieves the expected source passages. Citations resolve to actual source revisions. Unsupported/empty material is reported. A deleted source does not appear in a later retrieval. Access filtering runs before context is sent to a model.                                                                       |
| **4 — Sat 7 Nov**  | Complete the founder release mission: change brief → real Ollama plan and retrieved evidence → release readiness package → exact-package approval → durable local outbox. Add cancellation, errors, and bounded retries.                                                | Days 2–3 contracts and retrieval quality gate.                                                  | An end-to-end browser/API check produces actual plan, acceptance checklist, release notes, risk notes, and deployment handoff files. The package distinguishes proposed work from verified outcomes. Rejection creates no outbox item. Editing an approved payload requires new approval. Restart/retry/replay does not duplicate the action. |
| **5 — Sun 8 Nov**  | Build the minimal Expo iOS companion for run list, run detail/evidence, and approve/reject using local tooling; finish responsive web. Add a generic dev/ops sandbox template only if the golden flow is stable.                                                        | Stable API/auth and approval semantics; available local iOS build tooling.                      | A real simulator/device build, if available without added cost, performs the same approval transition as web. Authentication and API errors are visible. UI reflects conflicting/stale approval state. No paid build or App Store dependency is introduced. Optional sandbox execution has no arbitrary host or production access.            |
| **6 — Mon 9 Nov**  | Package self-host setup, health/readiness, safe configuration, operational logging, backup/restore procedure, and essential CI. Perform integration and accessibility checks.                                                                                           | Working complete workflow and deployable services.                                              | A clean database can migrate and start. Missing secrets/configuration fail clearly. Core logs contain correlation IDs and no credentials. A backup is restored into a separate test database and the saved run remains inspectable. Keyboard use, readable contrast, and narrow-screen operation are checked.                                 |
| **7 — Tue 10 Nov** | Fresh-install rehearsal on existing hardware, real-Ollama founder-release regression, failure rehearsal, documentation, known limitations, and a polished deployable alpha candidate.                                                                                   | All mandatory alpha gates below.                                                                | A person follows setup instructions without private knowledge or new spending, produces and approves a concrete release package through real local inference, and retrieves its saved result. Provider/iOS matrices show honest incomplete statuses. No full development/sales lifecycle, public SaaS, or App Store claim is inferred.        |

## Mandatory alpha gates

### Foundation and installation

- [x] Architecture, product boundary, and primary UI flows are recorded before implementation.
- [x] Workspace packages build and type-check with reproducible dependency installation.
- [x] Backend dependencies start through documented self-host commands on the local Mac testbed.
- [x] The local Ollama service is running/reachable and a suitable model loads successfully within existing hardware and the zero-additional-cost constraint.
- [x] The required database/runtime works on the local testbed despite the initially unavailable Docker daemon; any infrastructure dependency has an identified owner.
- [x] All exercised paths add no service cost, and paid provider routes are disabled by default.
- [x] Migrations work on a clean database and preserve existing run data when applied again.
- [x] Authentication/access configuration is appropriate to the documented private deployment boundary; exposed endpoints do not rely on a demo identity.
- [x] Environment examples contain placeholders, and logs do not print provider secrets.

### Execution and authority

- [x] A pinned founder-release workflow creates a persistent run with correlated steps and events; arbitrary workflow graphs remain deferred.
- [x] Shared contracts use the canonical states `queued`, `running`, `waiting_approval`, `completed`, `failed`, and `cancelled` consistently across clients and runtime.
- [x] Sandbox plans and artifacts are visibly identified as local simulation.
- [x] A run can wait for approval, resume, fail, be rejected, and be cancelled with clear state.
- [x] Approval binds to a specific payload revision, actor, and intended action.
- [x] Replays and worker restarts do not create duplicate outbox items.
- [x] Retries are bounded, and non-retryable failures have actionable messages.
- [x] No default workflow performs external sends, spend, privileged host execution, or production deployment.

### Providers and knowledge

- [x] Each of Ollama, OpenAI, and Claude has an implemented adapter contract and documented configuration.
- [x] Real Ollama compatibility is verified; OpenAI/Claude are separately marked verified, unavailable, or unverified without assuming subscription API access.
- [x] Routing records its reason and fails closed when local-only or other hard policy cannot be met.
- [x] Retrieval filters sources by the applicable workspace/access scope.
- [x] A founder release package cites real retrieved passages, handles insufficient evidence visibly, and does not invent test/deployment results.
- [x] Missions require latest ready revisions; deleted sources cannot enter new retrieval and retained prior search revisions are explicit.
- [x] Durable memory is explicit, scoped, inspectable, and deletable; raw conversations are not silently promoted into memory.

### Client and operational readiness

- [x] Web completes the golden workflow and shows empty, waiting, failed, rejected, and completed states.
- [x] A real Ollama run produces a concrete downloadable/inspectable plan, acceptance checklist, release notes, risks, and deployment handoff package.
- [x] The iOS companion has a documented build result and feature matrix; a preview or web shell is not presented as a successful native build.
- [x] Run status and action results survive a backend/worker restart.
- [x] A documented backup/restore rehearsal succeeds in a separate test database.
- [x] The quickstart and release notes state real limitations and verified test results.

These checks establish the documented local alpha foundation. Target-environment deployment, editorial/model quality, physical-device distribution and public SaaS remain separate release boundaries in STATUS.md; passing a fixture is never evidence of a completed external action.

## Testing strategy

Tests should protect actual product risks rather than reproduce implementation details.

| Layer                             | Purpose                                                | Minimum useful coverage                                                                                                                |
| --------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Domain and policy tests           | Prevent unauthorized or inconsistent state transitions | Approval invalidation, rejection, cancellation, local-only routing, retry eligibility                                                  |
| Adapter contract tests            | Keep provider behavior consistent                      | Normalized content/usage, unsupported capability, invalid configuration, timeout, retryable/non-retryable errors                       |
| Database/worker integration tests | Prove persistence and safe replay                      | Waiting-run restart, unique action identity, duplicate job delivery, migration and restore                                             |
| Retrieval evaluation fixtures     | Check groundedness and lifecycle                       | Expected source selection, real citation provenance, insufficient evidence, deletion and access filtering                              |
| One golden end-to-end flow        | Prove user value across boundaries                     | Connect local Ollama → ingest product knowledge → change brief → plan/release artifacts with evidence → approve → local package/outbox |
| Focused failure flows             | Prove honest and safe degradation                      | Provider unavailable, route blocked, failed ingestion, rejected/stale approval                                                         |
| Native/client smoke check         | Verify actual client delivery                          | iOS build/start/auth/run detail/approval and responsive web keyboard operation                                                         |

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

| Decision/input                         | Confirmed position or outstanding input                                                                                                                                                                      | Effect on delivery                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| First buyer and highest-value workflow | Confirmed: SaaS founder; build → operate → market → sell. First mission is founder release readiness.                                                                                                        | Workflow copy, data fixtures, artifacts, and priority modules                              |
| Definition of success in one week      | Confirmed: polished deployable alpha with one reliable end-to-end flow.                                                                                                                                      | Real Ollama inference plus concrete approved local output, packaging, and release evidence |
| Models, machine, hosting, and budget   | Confirmed: existing hardware, local testbed, zero extra cost. MacBook M5 + local Ollama now; CPU-only existing infrastructure later. Model downloads are allowed. Verify models and any eligible API access. | Runtime prerequisites, Ollama model selection, infrastructure issue, and provider gating   |
| License/commercial constraints         | Full code open source; AGPL-3.0-only selected                                                                                                                                                                | Repository license, distribution terms, and hosted-service positioning                     |
| Infrastructure request repository      | Confirmed: `XeoNote/Infrastructure-`; existing staff manage resources and Cloudflare DNS for `vuzmi.com`.                                                                                                    | Issue #310 posted on 5 November 2026; target allocation/response pending                   |
| First external integration             | GitHub knowledge import and bounded local development workflow implemented                                                                                                                                   | Connector implementation and authorization tests                                           |
| iOS distribution expectation           | Expo companion with local tooling; no paid build/App Store plan assumed                                                                                                                                      | Actual local build availability and companion scope                                        |

Revise the plan as remaining inputs arrive. The founder mission, zero-added-cost constraint, trust boundaries, and truthful reporting remain requirements.

## Follow-on local slice — human revision, 5 November 2026

The verified alpha draft contained semantic wording errors despite correct retrieval/citations. Before broadening external automation, let the owner correct the draft locally while preserving original model output, evidence, actor provenance and approval fences. Architecture§21 and Design§16 precede implementation. Gate this slice on exact-byte amended download, stale/conflicting replay, concurrent edit/approval, terminal immutability, retained-chain integrity and browser conflict/unsaved-draft behavior. Infrastructure evaluation proceeds through posted issue#310; no external action is added by this local slice.

Completed locally: 110 unit/API/provider/native-transport/source/startup/web-session tests and 53 PostgreSQL tests pass; backup/restore retains the revised aggregate and exact approved package. Browser verification covers real session expiry/reauthentication, competing tabs, deliberate discard and the amended download, including 390px layout. No new inference or external action occurs during a human edit. Representative content quality and the allocated target environment remain separate evaluation gates.

## Public source and checks increment — 5 November 2026

The founder authorized creation and public publication of Ether-X-UK/Vuzmi; reviewed baseline `864b61d` is published. Add clone/setup instructions and keep repository status accurate. Following Architecture§22, put the existing checks on a standard public Ubuntu runner without credentials, models, cache or artifact uploads. Gate completion on an actual green hosted run covering fresh dependency installation, strict code checks/build, native PostgreSQL/pgvector tests and restore drill, iOS bundle export and source packaging. Keep actual inference, Xcode compilation and private infrastructure acceptance distinct.

Completed: [hosted run 42008424308](https://github.com/Ether-X-UK/Vuzmi/actions/runs/42008424308) passes on application baseline `78f28c1` with 111 unit/client/contract tests, 53 PostgreSQL tests, backup/restore, web build, iOS export and source packaging. Ubuntu PGXS needs the matching Clang 19/LLVM 19 toolchain, now installed explicitly. Actual target allocation and operational validation remain pending.

## Native recovery increment — 5 November 2026

Read-only review found overlapping polling can suppress a slow backend's errors, some protected 401 responses miss the owner gate, and automatic refresh can replace a proposal under review. Follow Architecture§23 and Design§17 before implementation. Add bounded lifecycle/review helpers with failure-boundary tests, run strict checks and an iOS export, and rebuild the actual Simulator app. Verify recovery using isolated test data without configuring the founder's owner account. Record any remaining native interaction limits explicitly.

The analogous web proposal replacement was confirmed by static review. Apply the same explicit re-review gate to polled and conflict-recovered proposals, preserving the existing editor/session recovery. Test changed, unchanged, terminal and repeated-replacement boundaries; include strict web checks and production build.

Implemented and locally verified: 134 unit/client/contract tests pass, including 23 new recovery tests, with strict root/mobile TypeScript, web build, iOS export (801 modules) and fresh ad-hoc-signed Xcode Release Simulator compilation. At the initial code handoff, interaction checks remained pending and the owner setup was left to the founder; subsequent results follow below.

Subsequent interactive verification passed on isolated synthetic data: web/native A/B/C proposal replacement and renewed acknowledgment, exact web C approval, native timeout with disabled decisions followed by successful refresh, native C rejection with no artifact, and session-revocation gates in both clients. Individual native 409, decision/conflict 401 and uncertain-mutation timeout paths remain fixture-tested; large accessibility text and physical-device behavior remain unverified. The test server, three disposable schemas and synthetic credentials were removed afterward. The founder independently completed actual owner setup and signed in. A grounded real-model package was generated and corrected, retaining the original model output; the founder subsequently approved that exact local package, as recorded in the next increment.

## GitHub knowledge increment — 5 November 2026

The founder selected this first connector after approving the actual local founder package. Architecture §24 precedes UI design and implementation. Scope is one explicitly previewed public Vuzmi text file at an immutable commit, saved into the existing local knowledge pipeline.

- [x] Record preview/import UI design, then implement shared contracts and bounded server adapter.
- [x] Add atomic import receipts, per-revision provenance and append-only migration; preserve old migration checksums.
- [x] Expose preview, explicit local save, indexing state and retained origin in the web interface; imported text is read-only.
- [x] Preserve origin through retrieval, canonical documents and export, while keeping legacy approved bytes unchanged.
- [x] Verify malformed/oversized/redirected/symlink/private/timeout/rate-limit responses, expired previews, changed inputs and uncertain retries.
- [x] Verify PostgreSQL concurrent replay, restart, deletion and index-job atomicity; origin survives historical evidence retention.
- [x] Run strict checks/build and browser rehearsal, plus one deliberate unauthenticated public-file import using local indexing. No model generation is needed for this gate.

Private repositories, directory crawling, periodic sync, credentials, repository writes and native import UI are deferred. iOS continues to consume shared source/evidence contracts. Existing infrastructure allocation remains a separate pending gate.

Evidence: 188 unit/client/API checks, 60 PostgreSQL checks, backup/restore of origin and import receipts, strict root/mobile TypeScript, web build, 802-module iOS export and a fresh signed Xcode Simulator build pass. The real owner session previewed/imported the public README at a pinned commit; local embeddings produced six passages and the corrected retrieval returned four attributed excerpts. Imported detail/expanded hashes fit 390px. Timeout, rate-limit, expired-preview, concurrent replay and deletion failure boundaries use fixtures rather than individually induced operator UI failures.

## Development workflow increment — 5 November 2026

Founder approved the issue/brief → patch → isolated checks → exact review workflow. Architecture§25 precedes UI design and implementation. First profile fixes a real web401/session-expiry bug at a pinned owned revision with one permitted source file and sealed acceptance checks.

- [x] Record architecture, runner permissions and delivery plan; then record the web review design.
- [x] Provision a dedicated zero-cost VM/runtime with no host-directory/agent sharing; verify isolation and fixed check-image provenance.
- [x] Add shared development contracts, validated full-file replacement/diff, local JSON-model transport and failure-boundary tests.
- [x] Add append-only persistence/queue migration, owner-only API, pinned task/issue/context and worker/attempt fencing with restart/restore coverage.
- [x] Run actual baseline and candidate checks in fresh restricted containers; persist honest failures, timeouts, bounded logs and exact identities.
- [x] Build the web creation/list/diff/check/review/download flow; changed or unreviewed packages cannot be approved.
- [x] Verify paths/commands/policy cannot expand, secrets/network/host mounts are unavailable, resource/time/output limits and cancellation cleanup work.
- [x] Verify concurrent/replayed creation/decisions, lost worker ownership, stale output, unavailable runner, backup restore and existing founder/native compatibility.
- [x] Run strict checks/build, PostgreSQL/recovery, isolated runner tests and browser rehearsal; use a real local model on the owned acceptance task and present its exact package for founder review.

A passed saved package is not an applied checkout change or pull request. The first profile intentionally supports one known code path; broader profiles, unrestricted edits, dependency changes, native development review and external writes are deferred.

Completed local evidence: 211 application tests, 87 PostgreSQL tests, ten runner fixtures and six actual VM gates pass, with strict TypeScript, web build, 803-module iOS export and backup/restore. The existing Gemma 26B/A4B model produced the minimal statement move in 48.99s; the baseline reproduced two failures and its candidate passed all six checks. Five prior 4B/7B proposals remain visibly rejected by validation/checks. A separate synthetic browser rehearsal verified exact local save/download, competing views and rejection. The founder approved the actual revision 7 package; completion at revision 8 preserves one 26,520-byte artifact and nine matching events. Its exact payload/download hashes verify, and its patch applies cleanly in a read-only check. Checkout application remains separate. Published application `bebdd69` passes all steps of [hosted Linux run 42076979023](https://github.com/Ether-X-UK/Vuzmi/actions/runs/42076979023), including all six actual Docker gates.
