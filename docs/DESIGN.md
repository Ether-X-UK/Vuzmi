# Vuzmi interface design

Status: UI specification, 4 November 2026. This document describes intended interfaces, not implemented capabilities. Architecture and delivery sequencing are defined in [ARCHITECTURE.md](ARCHITECTURE.md) and [BUILD_PLAN.md](BUILD_PLAN.md).

## 1. Product direction and current boundary

Vuzmi is a business control plane for SaaS founders: **build → operate → market → sell**. Development, IT operations, support, marketing, and sales share agents, models, knowledge, approvals, and execution evidence. They must feel like one system rather than separate dashboards.

The immediate target is a polished private alpha running on existing local hardware, with no additional spend. Public hosting at `vuzmi.com` will be coordinated with the infrastructure team later. The interface must not imply that the domain is deployed, billing works, or business services are connected.

The confirmed first mission is Vuzmi's own alpha release preparation and launch assets. The first implementation creates a run, produces a deterministic local plan, requests review, and records an approved local artifact with an event history. This is an explicitly labelled simulation of an orchestration workflow. It does not call a model, inspect a repository, run tests, deploy software, contact customers, or publish anything. Later verified capabilities replace the simulator behind the same execution contract.

The complete alpha release-preparation mission adds real local inference, retrieved product knowledge, citations, and a concrete release package. The later support template reuses those foundations with a reviewed local outbox. Saving an outbox item does not mean a response was sent.

### Design priorities

1. Make the operator's next decision clear.
2. Preserve the relationship between intent, proposed action, approval, execution, and outcome.
3. Give the broad business vision a coherent shell while keeping unavailable features honest.
4. Make local ownership and model routing visible without overwhelming the main workflow.
5. Deliver a distinctive and accessible interface without paid assets, paid fonts, external font requests, or ornamental complexity.

## 2. Shared product language

The shared conceptual sequence is:

`Mission → Versioned automation → Run → Actions → Approval → Evidence → Outcome`

| Term       | Interface meaning                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Mission    | The operator's business objective and requested result. It is a human-facing concept, not a second execution engine. |
| Automation | A reusable, versioned definition of steps, policies, and permitted effects.                                          |
| Run        | One execution of a specific automation version.                                                                      |
| Agent      | A versioned role, instructions, model policy, tools, and memory scope.                                               |
| Action     | A proposed or attempted operation with identifiable inputs and effects.                                              |
| Approval   | An attributable decision about an exact action or artifact revision.                                                 |
| Evidence   | Source passages, artifacts, tool results, and events supporting a decision or result.                                |
| Outcome    | A verified result at the implemented completion boundary.                                                            |

Domain choices filter the common system: All operations, Build, Operate, Support, Market, Sell. The first mission belongs to Build. A domain is not a separate application shell or a separate run history.

Prefer concrete status language: “Preparing release brief,” “Waiting for your review,” “Saving local artifact,” or “Source unavailable.” Avoid vague claims such as “Agent thinking,” “AI optimizing,” or “Fully autonomous.”

## 3. Visual system

### Character

A calm, precise operational workbench. Near-black ink surfaces, clear typography, fine separators, pale teal actions, and small lime highlights convey a futuristic product through craft. The interface should remain readable when filled with long titles, errors, and technical evidence.

Avoid decorative gradient backgrounds, purple dashboard conventions, glowing card borders, repeated glass effects, large empty charts, and constant animated activity. A small vector V mark can depict two paths converging; build it with local SVG or CSS. No image generation or purchased illustrations are required.

### Colour tokens

| Token            | Value     | Intended use                                    |
| ---------------- | --------- | ----------------------------------------------- |
| `background`     | `#080E13` | App shell and main canvas                       |
| `surface`        | `#0E171E` | Working sections and panels                     |
| `surface-raised` | `#14212A` | Inspector, menu, dialog                         |
| `border`         | `#263A44` | Panel separators and secondary edges            |
| `text-primary`   | `#EDF5F3` | Titles, body, important values                  |
| `text-secondary` | `#9BAEB4` | Metadata and supporting content                 |
| `accent`         | `#79E4D0` | Primary action, active navigation, focus detail |
| `outcome`        | `#D2EE94` | Verified result emphasis, sparingly             |
| `warning`        | `#F0BC72` | Review required and caution                     |
| `danger`         | `#FF8995` | Failure and destructive scope                   |
| `information`    | `#8DBAFF` | Informational state                             |

Pale accent-filled buttons use dark text. Status colours are always accompanied by readable text and an icon or shape. Validate actual text/background combinations during implementation; the palette is not a claim that every possible combination passes contrast requirements. A stronger border or focus outline is required where a control depends on a visible boundary.

### Typography and assets

Use a local system stack initially:

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

The iOS client uses native platform typography. A locally bundled open font may be considered later after its licence and package are reviewed; it is not necessary for the alpha. Do not fetch Google Fonts, remote icons, background images, or paid assets at runtime.

| Role               | Desktop size                        | Usage                              |
| ------------------ | ----------------------------------- | ---------------------------------- |
| Page title         | 28–32px                             | One clear title per page           |
| Section title      | 18–20px                             | Queue, evidence, timeline sections |
| Body               | 15px, approximately 1.5 line height | Operational content                |
| Label and metadata | 13px                                | Field labels, secondary facts      |
| Technical detail   | 12–13px                             | IDs and compact trace metadata     |

Use tabular numbers for durations, counts, and recorded usage. Use monospace selectively for IDs, code, hashes, and exact technical values rather than for all interface copy.

### Geometry and motion

- Base spacing: 4px and 8px increments.
- Desktop page padding: 32px; tablet 24px; narrow screens 16px.
- Navigation rail: approximately 216px. Top bar: 64px.
- Normal controls: 40px high. Touch targets: at least 44 by 44px.
- Panel corners: 12px; control corners: 8px; status chips: 6px.
- Row height: approximately 64–76px depending on supporting text.
- Content can expand to roughly 1680px; do not stretch reading text across the entire viewport.
- Use borders and spacing before adding nested cards or shadows.
- Short transitions around 160ms are sufficient. Honour reduced motion. No perpetual decorative animation or misleading live pulse.

## 4. Information architecture

The target web navigation is:

1. **Command:** decisions, active work, and verified outcomes.
2. **Automations:** recipes, definitions, triggers, and run entry points.
3. **Runs:** execution history and investigation.
4. **Approvals:** pending and historical decisions.
5. **Agents:** roles, tools, permissions, and memory scope.
6. **Knowledge:** sources, ingestion, evidence, and curated memory.
7. **Models:** connections, policy, routing, and observed usage.

Workspace settings contain members, permissions, integrations, audit access, and self-hosted health. Billing only becomes an operative section when the commercial module is implemented.

The top bar contains the workspace, deployment environment, global search when supported, and backend connectivity. The primary page action is “New mission” or the more specific action appropriate to the screen.

### First implementation navigation

Only Command, Runs, and Approvals need operative views in the initial slice. Model, knowledge, and business-area previews must be clearly labelled “Planned” or show an honest connection/empty state. They must not navigate to fake completed dashboards. Prefer a small roadmap preview to many disabled navigation items.

Do not render a search field, notification bell, workspace switcher, or command shortcut as interactive unless its behaviour works. A static workspace identity is sufficient for the local single-workspace slice.

## 5. First three screens

These are the implementation priorities in sequence. Layout routes below describe intended navigation; actual routing must follow the client and API contracts agreed for the slice.

### Screen 1 — Command

Question answered: **“What needs me, and what is happening?”**

Suggested desktop structure:

```text
┌──────────────┬──────────────────────────────────────────────────────┐
│ vuzmi        │ Workspace / Private local alpha   Backend state      │
│              ├──────────────────────────────────────────────────────┤
│ Command      │ COMMAND                               New mission   │
│ Runs         │ Your business, in motion.                           │
│ Approvals    │ Local simulation · No model or external action      │
│              │                                                     │
│              │ Needs your review                                   │
│              │ [exact proposed local result and review action]     │
│              │                                                     │
│              │ Active work                                         │
│              │ Mission          Current step      State    Elapsed │
│              │ ...                                                 │
│              │                                                     │
│              │ Recent outcomes             Activity                │
│ Local alpha  │ [actual artifacts only]     [persisted events]       │
└──────────────┴──────────────────────────────────────────────────────┘
```

Content hierarchy:

1. Page heading with one primary action.
2. Deployment/execution-mode disclosure appropriate to the current adapter.
3. Pending approvals, prioritised by actual urgency and impact.
4. Active and recently completed runs with an actionable next step.
5. Recent verified local artifacts and recorded activity when available.

Do not begin with decorative revenue, conversion, uptime, token, or cost tiles. If counts are displayed, calculate them from actual returned runs and clearly scope them to the workspace or loaded results. Pagination must not silently make a page count look like a global total.

Run row content:

- Mission title and domain.
- Concrete current step or reason for waiting.
- Canonical state rendered in plain language.
- Recorded start time or elapsed time.
- Simulation marker when applicable.
- A clear link or button to inspect the run.

The real workspace begins empty. The empty state reads along these lines:

> **Your first mission starts here.** Prepare Vuzmi's release brief in a local simulation, review the result, and follow the recorded run from start to finish.

Primary action: **Prepare a release brief**. Secondary explanation: **No model calls, deployments, or external messages.**

A deliberately separate demo workspace may contain seeded examples, but it must be labelled “Demo data” at workspace level and on the relevant preview. The initial implementation does not need seeded runs at all.

### Screen 2 — New mission

Question answered: **“What am I asking Vuzmi to do, and what can it actually do?”**

Use a dialog or focused page on desktop and a full-screen form on mobile. A single form is sufficient; avoid a multi-step wizard for three fields.

Fields:

- **Mission title:** editable, initially “Prepare Vuzmi's release brief.”
- **Goal or brief:** editable text, with a useful local release-preparation example.
- **Expected result:** read-only description of the current local artifact.
- **Execution mode:** visible and explicit, initially “Local simulation.”
- **Review policy:** “Review required before saving the final local result.”

The initial recipe can produce a deterministic release-preparation brief with scope, checks to perform, known limitations, and next actions. Any suggested check must remain a checklist item until real execution evidence exists. It cannot state that builds passed, sources were reviewed, or deployment occurred.

Summary before submission:

> This run uses the local simulator. It will prepare a reviewable artifact from your brief. It will not call Ollama, OpenAI, or Claude, inspect your repository, run commands, deploy, or send messages.

Primary action: **Start local run**. Prevent accidental duplicate submission while the request is pending. A failed request retains the entered brief and offers a clear retry.

Future provider and locality options should appear only after they are implemented and configured. Do not put an apparently working model selector above a simulator.

### Screen 3 — Run detail and review

Question answered: **“What happened, what am I authorising, and where is the result?”**

Desktop header:

- Mission title and domain.
- State, initiating actor, recorded creation time, and simulation marker.
- Back to runs.
- Cancel when supported by the current state and backend.

Body:

- Main column, approximately two thirds: current result or proposed artifact, followed by an execution timeline.
- Secondary column, approximately one third: review panel, run facts, and execution mode.
- On smaller screens, the review summary appears before the long timeline.

The release-preparation artifact should be readable as a document, with clear headings and a small “Simulated plan” label. Present raw JSON or event payloads in a separate technical disclosure.

Approval panel:

1. Exact action: **Save this release brief as a local artifact**.
2. Artifact revision or stable version.
3. Destination: this workspace's implemented local storage boundary.
4. Effect summary: no external send, publication, deployment, or repository change.
5. Full preview or direct access to the exact content being approved.
6. **Approve local result** and **Reject** actions.

Approval is a decision, not evidence of completion. Show “Saving local result” while the backend executes, then “Local artifact saved” only after the actual storage operation succeeds. If persistence is session-only at any intermediate milestone, disclose that limitation instead of calling the result durable.

Rejection records the approval decision and leaves no completed artifact/outbox action. The displayed run status follows the shared backend contract; initially a rejected review can terminate as `cancelled` with a specific human-readable reason. Do not introduce a client-only `rejected` run enum.

An edited proposal invalidates the old approval. The client must refresh a stale proposal and require review again. During decision submission, disable conflicting buttons, announce progress, and render the persisted server result. A second tab deciding the same approval should receive an informative already-decided/stale state.

Timeline entries show an event label, recorded time, and useful details. No artificial typing animation, simulated provider name, fake tool transcript, or fabricated duration should make the simulator appear to be a live agent.

## 6. Runtime states and truthfulness

Clients consume canonical shared contracts. Use `waiting_approval` and `completed`; do not create alternate spellings such as `waiting_for_approval` or use step-level `succeeded` as a run state.

| Run state          | Main label   | Typical next action                     |
| ------------------ | ------------ | --------------------------------------- |
| `queued`           | Queued       | Inspect or cancel if supported          |
| `running`          | In progress  | Inspect current concrete step           |
| `waiting_approval` | Needs review | Review exact proposal                   |
| `completed`        | Completed    | Open verified local result              |
| `failed`           | Failed       | Read cause and use supported retry      |
| `cancelled`        | Cancelled    | Read reason; create a new run if wanted |

Future waiting/retry/paused states must be added to the shared schema before clients display them. Do not infer run success from the presence of an approval, a final model message, or a disconnected stream.

| Fact                               | Honest display                                             |
| ---------------------------------- | ---------------------------------------------------------- |
| Simulator generated a plan         | “Local simulation” and “No model call”                     |
| No provider configured             | “Not configured”                                           |
| Provider configured but not tested | “Not verified”                                             |
| Backend connection lost            | “Disconnected” with last updated time                      |
| Cost not recorded                  | “Not measured,” not a fabricated currency value            |
| No model call occurred             | “No provider call,” without claiming local compute is free |
| Source retrieval not implemented   | No citation panel implying retrieved evidence              |
| Outbox item saved                  | “Saved to local outbox,” not “Sent”                        |
| Release plan created               | “Release brief prepared,” not “Release shipped”            |
| Planned domain module              | “Planned,” with concise scope and no fake statistics       |

## 7. Later alpha screens

### Automation Studio

Introduce reusable recipes after the core run/approval flow works. Use an ordered step editor initially; an arbitrary DAG canvas is outside the first slice and the one-week priority.

The step vocabulary stays small: Trigger, Agent task, Retrieve, Condition, Approval, External action, Verify result. Each step shows inputs, outputs, permissions, policy, timeout, and failure behaviour through progressive disclosure.

The primary controls are Save draft, Test, and Activate when each exists. Testing must identify preview-only, mocked external actions, or live execution. Activation shows a concise summary of triggers, connected identities, consequential actions, budget, and approval policy.

### Models and routing

The Models screen distinguishes connection configuration, verified capabilities, and routing policies. Provider credentials remain server-side and are never redisplayed. Initial zero-additional-spend operation must not silently activate a paid provider call or a paid fallback.

The run's routing inspector shows selected provider/model, hard constraints, policy version, excluded alternatives, fallback attempts, and a short recorded reason. Show local-only policy prominently. A failed local route must not be described as a successful cloud fallback.

Recorded usage, estimated cost, and unknown cost are separate values. Do not invent optimality, calibrated quality scores, or latency measurements. Show action traces and concise routing explanations rather than private chain-of-thought.

### Knowledge and memory

Knowledge sources show owner/scope, ingestion status, last sync, source revision, and real citation provenance. Failed parsing or indexing is visible. Retrieval similarity is not displayed as factual confidence.

Memory is an explicit retained fact or preference with scope, provenance, trust state, and deletion/edit controls. A conversation is not automatically durable memory. Keep knowledge evidence, retained memory, and current run context distinguishable.

### Business domains

The broader founder journey remains visible through real recipes as they ship:

- **Build:** release brief, issue triage, proposed change, test evidence, review.
- **Operate:** health observation, incident proposal, authorised remediation, verification.
- **Support:** request, permitted retrieval, cited draft, review, local outbox, later configured delivery.
- **Market:** brief, assets, audience, review, configured publication, measured results.
- **Sell:** permitted lead/context, qualification, proposed outreach, review, configured delivery, CRM result.

Unavailable execution steps stay proposed or planned. Approval for preparing a draft must never imply permission to publish, send, spend, or deploy it.

## 8. Mobile and iOS companion

The Expo companion is approval-first rather than a compressed clone of the web builder.

Bottom navigation: Command, Approvals, Runs, Account. Initial useful capabilities are run list, run detail, artifact/evidence reading, approve/reject, and supported cancellation. Creating an existing safe recipe can follow if the API and native build gates pass.

Mobile review is a full screen:

1. Action and run status.
2. Scope, destination, and simulation/live mode.
3. Exact artifact/message/diff preview.
4. Supporting evidence and technical details.
5. Persistent footer with a specifically labelled decision action.

Keep the proposal readable above the decision button; do not approve from a notification without the required context. Notifications, biometric confirmation, background streaming, and push infrastructure are later capabilities unless implemented and verified.

Use native text scaling, safe-area handling, scrollable long content, platform back navigation, and at least 44pt targets. Code and diffs may scroll horizontally inside labelled blocks; ordinary content must reflow. At large text sizes, put decision buttons in a vertical stack.

The initial loopback-only simulator is a desktop/local development boundary. Do not present an iPhone connection as working until the authenticated private-network backend and actual native build are verified. Backend URL settings should explain that the phone's `localhost` refers to the phone.

## 9. Empty, failure, and recovery states

| Situation                                   | Required behaviour                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| New workspace                               | Explain the first real available mission; no seeded live metrics.                    |
| No approvals                                | “No decisions waiting,” with a link to actual active work.                           |
| Loading                                     | Skeleton or readable loading text; do not flash false zero totals.                   |
| Create run failed                           | Preserve input, explain failure, allow deliberate retry.                             |
| Backend disconnected                        | Show last update, preserve the last known state, block unverified mutation results.  |
| Event stream interrupted                    | Reconnect or poll using supported contracts; do not concatenate duplicated events.   |
| Provider unavailable                        | Name the failed connection and explain permitted recovery; no silent egress change.  |
| Knowledge insufficient                      | State which evidence is missing; do not fabricate citations.                         |
| Approval stale or already decided           | Refresh the actual proposal/decision and explain why the old control is unavailable. |
| Local artifact write failed                 | Show failure, preserve the reviewed proposal, do not claim completion.               |
| Retry unsupported                           | Provide useful error context; do not display a decorative Retry button.              |
| External outcome unknown in later workflows | Show uncertainty and reconciliation/review; never blindly offer a duplicate send.    |
| Optional module unavailable                 | Clearly mark Planned or Not configured and state the next real prerequisite.         |

Errors belong near the affected action, with a persistent page-level state when necessary. Toasts may confirm a completed action but must not be the only record of a failed or consequential operation.

## 10. Accessibility and responsive behaviour

- Target WCAG 2.2 AA for implemented web flows and validate actual rendered contrast.
- Use semantic navigation, headings, lists/tables, form labels, and buttons.
- All controls work by keyboard; use a visible focus indicator and a skip link.
- Dialogs trap focus appropriately and restore it to the opener. Escape dismisses non-destructive transient panels.
- Announce important asynchronous state changes with a polite live region. Do not announce every timeline tick or elapsed second.
- Status always has text; icons and colour are supplementary.
- Buttons describe consequences. Do not bind a global shortcut directly to approval or another external effect.
- Add Command-K only when the command menu works. Selection and navigation never execute an action.
- Honour reduced motion and native text scaling; test the main flow at 200% web zoom.
- Below approximately 1024px, collapse secondary navigation and move the inspector below the artifact. Below approximately 768px, use mobile navigation and stacked run rows.
- Do not require horizontal scrolling for ordinary run metadata, approval copy, or forms.
- Never hide error reasons or decision controls behind hover-only interactions.

## 11. Component and implementation boundaries

Suggested reusable web components:

`AppShell`, `WorkspaceIdentity`, `ExecutionModeBanner`, `DomainFilter`, `RunList`, `RunStateBadge`, `ApprovalQueue`, `NewMissionForm`, `RunTimeline`, `ArtifactPreview`, `ApprovalPanel`, `RunFacts`, `EmptyState`, `ErrorState`, and `ConnectionHealth`.

Later components include `RoutingDecision`, `UsageSummary`, `RecipeEditor`, `KnowledgeSourceList`, and `MemoryItem`.

Shared tokens can live in `packages/ui` when both clients need them. Keep DOM components out of React Native. The web client consumes shared contracts and server state; it does not embed provider keys, simulate backend success, create client-only approvals, or infer authority from hidden UI controls.

Use local SVG icons or an already available local icon package. Prefer a few well-made primitives to adding a large component framework solely for the first page. Every visible control in the first slice must work or carry an unambiguous planned/read-only label.

## 12. UI acceptance checklist

Before calling the first slice complete:

- [ ] Command, new mission, and run review work as a connected flow.
- [ ] A new workspace has an honest empty state and no fabricated runs or metrics.
- [ ] Simulation is visible before submission, during review, in the run facts, and on its artifact.
- [ ] The first mission prepares Vuzmi's release brief and never implies repository inspection, command execution, deployment, or external delivery.
- [ ] Canonical states come from shared contracts and refresh after mutations.
- [ ] Approval shows and binds the exact result; stale decisions fail visibly.
- [ ] Rejection creates no completed action, and completion appears only after actual local storage succeeds.
- [ ] Model, provider, retrieval, and cost claims match actual execution facts.
- [ ] All visible controls work or clearly indicate planned/read-only behaviour.
- [ ] Loading, disconnected, failed-create, failed-save, empty, waiting, rejected, and completed cases are readable.
- [ ] The main flow works with keyboard navigation, narrow screens, reduced motion, and readable contrast.
- [ ] No paid asset, remote font fetch, paid service, or external telemetry is required for the interface.
- [ ] Native iOS build status is reported separately; a responsive web preview is not called an iOS app.

Visual polish supports the execution contract. It does not replace persistence, authority checks, real provider compatibility, retrieval quality, or recovery evidence required by the architecture and build plan.

## 13. Real local execution increment

Keep the approved visual direction. A mission explicitly selects Simulation or Local Ollama. The latter shows discovered local models and requires PostgreSQL and a fresh worker heartbeat; a missing dependency blocks the real run rather than switching execution modes.

Runs without a proposal display their persisted queued/running/failed state and event trail. Approval, artifact preview, and export appear only after a concrete model result has been saved. Real outputs are labelled as unverified local drafts; they do not imply retrieval, tests, deployment, or publication. Show the selected model and observed usage separately from simulation facts.

Model control becomes an operative local runtime view showing observed Ollama connectivity, eligible installed models, storage backend, and worker readiness. Runtime discovery failure must not hide saved workspace data. The shell describes local-only execution; individual simulator runs retain explicit simulation labels. Existing keyboard, text-size, mobile, and exact-document review behavior remains required.

## 14. Sources, retrieval, and curated memory increment

Keep the established ink/teal visual system. Knowledge & memory becomes operative, with Sources, Retrieval test, and Memory tabs. Sources accept pasted or picked `.md`/`.txt` text up to 64 KiB. Show current revision, actual indexing status/error, active searchable revision, and source detail as escaped text. Updating creates a new revision; loading/failure retains unsaved input. Deletion is deliberate and discloses removal from active retrieval plus linked memories, while historical run evidence/artifacts remain retained.

Retrieval test searches only selected sources and memories. Show actual excerpts, stable citation labels, source revision and line/chunk identity; no confidence percentages. No result is a visible insufficiency. Editing/deleting sources invalidates displayed test results. Memory is explicitly saved/edited/deleted by the operator, confirmed and workspace-scoped; conversations do not become memory automatically. Show provenance and expiry.

New missions keep No retrieval as the compatibility default. Local Ollama can opt into Require workspace evidence and select ready sources/confirmed memories. Required evidence that becomes unavailable or irrelevant stops generation with a concrete reason. Run review presents the exact retained evidence snapshot and citation identities beside the generated document. Citation focus must not overwrite the hash route. Mobile gets a fifth Knowledge tab, preserving Models; roadmap copy must distinguish operative knowledge from planned connectors and agent memory automation.

## 15. Owner setup and authenticated clients

Before workspace content loads, read minimal authentication state. An empty authenticated installation shows a one-time owner setup form requiring the private setup key, name, email, and password; no public registration or email verification claim. A configured installation shows sign-in. Keep entered non-secret fields after failure, clear password on completed sign-in/setup, and show actionable session/network errors. Password/setup secrets never appear in URLs or logs. Setup success leads to normal sign-in, not a silently exposed session token.

The shell shows the actual owner and sign-out when authenticated, or an explicit local development/no-sign-in badge when bypassed. Session expiry returns to sign-in and stops protected polling; it must not silently switch to development mode. Web uses same-origin cookies. Native uses the maintained Expo SecureStore integration and the same run/evidence/approval contracts, with one clear connection screen and no claim of physical-device deployment before that gate passes.

## 16. Correct a draft before approval — 5 November 2026

Add **Revise draft** beside the review controls for a waiting Ollama document whose editable body can be verified. Open an inline editor with an explicit Edit/Preview state, selectable retained context and read-only provenance/reference boundaries. Keep body text exact and show its UTF-8 byte budget. Collect a short change reason. Save means **Save revised draft**, never approve or publish.

While editing, replace the approve/reject buttons with save/cancel controls. A stale server revision leaves the unsaved body intact and explains that current saved content must be reviewed; do not merge or silently overwrite it. Discard requires an explicit local choice, including sign-out. Session expiry shows sign-in, preserves the pending editing session only in memory and restores it after the same owner authenticates; closing/reloading still requires the browser's unsaved-text warning. Successful save returns to the actual saved document, shows a human-revised label and appends an inspectable revision record with the prior text, actor and reason. The next approval binds only to that revised fingerprint/revision. Existing completed/rejected records remain immutable.

## 17. Native recovery and changed proposals — 5 November 2026

Keep refresh single-flight so a stalled backend reaches its visible timeout and disables decisions. A session-expired response from any protected operation returns directly to the existing sign-in screen and clears protected content; a late response from an old connection has no visible effect.

When a refreshed run contains a different waiting proposal, show a persistent **Proposal changed** notice with a **Review updated document** action. Disable approval and rejection until the person deliberately opens the replacement exact document and acknowledges that version from that document screen. Further changes invalidate that acknowledgment again. Show the currently reviewed revision and fingerprint; never silently retarget an approval. Preserve the established visual system and accessible announcements.

Use the same changed-proposal notice and deliberate document acknowledgment on web. The previous reviewed snapshot stays stable until the person opens the replacement. A conflict does not make the next click approve a newly fetched draft. Keep revision editing, its unsaved text and its discard guard intact.

## 18. GitHub file preview and local import — 5 November 2026

Add **Import from GitHub** beside Add source in Knowledge. Use the existing restrained dark surfaces, mint primary action, typography and responsive forms. The panel names the fixed public repository `Ether-X-UK/Vuzmi`, explains the one-file snapshot boundary and requires a full 40-character commit, repository-relative `.md`/`.txt` path and local title. A collapsed help line explains where to copy a commit. No connected-account badge or sync promise.

**Preview file** fetches without saving. Display escaped plain text in a bounded scrollable region with a clear Untrusted source label. Show repository, path, full commit, blob ID, raw/normalized size and a disclosure for hashes/fetch time. Explain normalization and that source lines refer to the imported local text. Never render remote Markdown or load its images. Input changes immediately discard the preview; an old response cannot restore it.

Only the exact current, unexpired preview enables **Save and index locally**. Show preview expiry and concrete missing-file, unsupported-file, network, timeout, rate-limit and expired-preview errors. A failed/uncertain save keeps the same import identity for Retry save; starting a different preview creates a different identity. Save success clears the form, refreshes knowledge and links the new source, showing queued/indexing/ready/failed from actual state. Navigating away cannot cause a late save response to reopen a different view.

Imported source detail presents a read-only provenance card and exact normalized text, with delete using the existing confirmation. Source cards show a modest GitHub snapshot badge. Retrieval and recorded evidence expose the immutable commit/path and hashes, with a canonical GitHub link built only from validated origin. It does not imply repository execution, truth verification, automatic updates or tests passing. Native import controls remain outside this increment; shared evidence retains the new origin.
