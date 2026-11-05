# Local alpha foundation release notes

Prepared 4 November 2026 for private evaluation; not a public release announcement. Licence: AGPL-3.0-only.

Vuzmi now turns an owned product brief and selected knowledge into a locally generated, cited draft that a signed-in owner can review and save as an exact local package. Web and native iOS Simulator clients share its run/approval contract. The approved package records the document bytes, hashes, workflow version, evidence, model route/usage and authenticated decision.

## Included

- Versioned founder-release workflow with durable PostgreSQL events, recoverable local worker and explicit simulation mode.
- Ollama generation plus pinned EmbeddingGemma retrieval for versioned text/Markdown sources and curated workspace memory.
- Single-owner authentication, safe browser Markdown/citations, exact approval/rejection, local outbox and deterministic downloads.
- Web draft corrections before approval, with owner/reason attribution, retained original/prior text, stale approval protection, exact retry handling, conflict preservation and memory-only recovery after session expiry. Fixed provenance and retained references are reconstructed by trusted code; edits do not trigger another model call.
- Locally built iOS Simulator companion with secure sessions, runs, exact documents and approvals.
- Changed proposals require deliberate exact-document review and version acknowledgment in web/iOS. Native polling, protected session expiry and late-response handling recover without silently retargeting decisions.
- Built web/API self-host command on loopback, health endpoints, private backup/empty-target recovery and reviewed source packaging.
- Disabled OpenAI/Claude text adapter contracts tested through fixtures; no live cloud-provider call.

## Earlier foundation verification

The recovery-increment client checks passed 134 unit/API/source/startup/native-transport/web-session tests, strict root/mobile TypeScript, web production build and an 801-module iOS export. [Hosted checks at 266e7da](https://github.com/Ether-X-UK/Vuzmi/actions/runs/42014800496) also pass 53 real PostgreSQL/auth/knowledge/outbox/revision tests, recovery and source packaging. A fresh ad-hoc-signed Xcode Release Simulator build passes. Interactive web/native replacement gates, exact web approval, native timeout/reconnection/rejection and polling session-expiry gates pass on isolated data. Earlier real local embedding/generation and separate synthetic revision/download checks remain recorded in [STATUS.md](STATUS.md), including their limits.

## Evaluation boundary

Generated copy is unverified and can contain semantic mistakes despite valid citations; the observed QA draft confused native/web verification and one authentication description. The local-save approval test does not approve that text for a launch. Human factual/content review remains required. No code implementation, deployment, publication, customer contact, purchase or billing action is performed by this workflow.

Active-source deletion does not erase historical excerpts, approved documents, downloaded copies or old backups. Backups are private but unencrypted; encrypted off-host operational recovery, target CPU/Linux deployment and private ingress/TLS remain handoff gates. The founder has completed actual owner setup privately. The founder reviewed and approved the subsequent corrected real-model readiness package locally; its content and original history remain private. Physical-device/App Store delivery, public multitenancy, billing, additional integrations and automated selling are future work.

Run locally using [DEVELOPMENT.md](DEVELOPMENT.md). The [infrastructure evaluation request](INFRASTRUCTURE_REQUEST.md) is recorded below. Source licensing does not imply that a repository or service has been published.

## Handoff update — 5 November 2026

The founder authorized posting the private evaluation request. It is now [infrastructure issue #310](https://github.com/XeoNote/Infrastructure-/issues/310), containing the verified application commit and local source-archive hash. Target allocation and response are pending; posting the request is not evidence of deployment or DNS changes.

## Public source update — 5 November 2026

The founder authorized public AGPL publication at [Ether-X-UK/Vuzmi](https://github.com/Ether-X-UK/Vuzmi). Reviewed application baseline `864b61d` is published with its checked commit history, licence, lockfile and self-host instructions. [Hosted Ubuntu checks](https://github.com/Ether-X-UK/Vuzmi/actions/runs/42008424308) pass for subsequent baseline `78f28c1`, including real native PostgreSQL/pgvector fixtures and recovery. The harness now also stops a partially started fixture before deleting its directory. GitHub publication and fixture verification do not deploy a service or authorize a production launch.

## GitHub knowledge update — 5 November 2026

Preview one public Vuzmi Markdown/text file at a full commit, then save and index the exact local snapshot. Imported sources are read-only, and commit/blob/raw/normalized hashes follow retrieved evidence into approved packages. Durable receipts make exact retries recoverable after restart; deleted imports are not recreated by replay. Fixed-origin unauthenticated GETs are bounded, redirects refused, symlinks/submodules rejected and source contents treated as untrusted context. There is no private-repository access, automatic sync or repository write.

Local verification passes 188 unit/client/API checks, 60 real PostgreSQL checks, strict TypeScript, web build, 802-module iOS export, fresh signed Xcode Simulator compilation and the expanded native backup/restore drill. A real browser import of the pinned public README reached six indexed passages and four attributed retrieval results. Imported detail and expanded hashes fit 390px. A live-observed one-character excerpt tail was corrected with a regression preserving complete short facts. Error/expiry/retry/deletion boundaries additionally use fixtures; native provenance has compile/export coverage without a new interactive rehearsal. See STATUS.md for exact scope and limits.

## Development workflow update — 5 November 2026

A separate web development workflow accepts a brief or optional public Vuzmi issue, generates a local-model code proposal for one pinned file, reproduces the known baseline failure and runs sealed acceptance checks in fresh restricted offline containers. A passing candidate reaches exact versioned review; approval saves its patch/evidence package locally. It never applies the patch or opens a PR. Failed candidates remain visible and cannot be approved.

The dedicated zero-cost runner has bounded resources/output/time, no host mounts/credentials/network, inspected policy and owned-resource cleanup. Request/decision replay, expired worker/attempt fencing, restore quarantine and exact downloaded bytes have real PostgreSQL/browser coverage. All 211 application tests, 87 PostgreSQL tests, ten runner fixtures, six actual VM gates, strict TypeScript, web build, 803-module iOS export and backup/restore pass locally. Five real proposals were blocked for syntax/behavior/no-op failures; the explicitly selected existing Gemma model then produced the minimal patch and passed all six candidate checks. Its exact local package awaits founder review. This is a functional owned-repository alpha, not an unattended code-safety or model-quality guarantee. See [runner setup](DEVELOPMENT_RUNNER.md) and [current status](STATUS.md).
