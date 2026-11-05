# Local alpha foundation release notes

Prepared 4 November 2026 for private evaluation; not a public release announcement. Licence: AGPL-3.0-only.

Vuzmi now turns an owned product brief and selected knowledge into a locally generated, cited draft that a signed-in owner can review and save as an exact local package. Web and native iOS Simulator clients share its run/approval contract. The approved package records the document bytes, hashes, workflow version, evidence, model route/usage and authenticated decision.

## Included

- Versioned founder-release workflow with durable PostgreSQL events, recoverable local worker and explicit simulation mode.
- Ollama generation plus pinned EmbeddingGemma retrieval for versioned text/Markdown sources and curated workspace memory.
- Single-owner authentication, safe browser Markdown/citations, exact approval/rejection, local outbox and deterministic downloads.
- Web draft corrections before approval, with owner/reason attribution, retained original/prior text, stale approval protection, exact retry handling, conflict preservation and memory-only recovery after session expiry. Fixed provenance and retained references are reconstructed by trusted code; edits do not trigger another model call.
- Locally built iOS Simulator companion with secure sessions, runs, exact documents and approvals.
- Built web/API self-host command on loopback, health endpoints, private backup/empty-target recovery and reviewed source packaging.
- Disabled OpenAI/Claude text adapter contracts tested through fixtures; no live cloud-provider call.

## Verification

The current checks pass 110 unit/API/source/startup/native-transport/web-session tests and 53 real PostgreSQL/auth/knowledge/outbox/revision tests, strict root/mobile TypeScript, web production build and native bundle export. The baseline signed Release Simulator compilation remains valid compilation evidence; no fresh Xcode build was run for the web/shared revision increment. A real local embedding/generation browser mission produced a downloaded package matching its approved database content and evidence. Separate synthetic browser checks verified human revision, expired-session recovery, concurrent conflict and exact approved download; a native dump/restore drill also preserved revision history and package bytes between two disposable databases. See [STATUS.md](STATUS.md) for exact scope and limitations.

## Evaluation boundary

Generated copy is unverified and can contain semantic mistakes despite valid citations; the observed QA draft confused native/web verification and one authentication description. The local-save approval test does not approve that text for a launch. Human factual/content review remains required. No code implementation, deployment, publication, customer contact, purchase or billing action is performed by this workflow.

Active-source deletion does not erase historical excerpts, approved documents, downloaded copies or old backups. Backups are private but unencrypted; encrypted off-host operational recovery, target CPU/Linux deployment and private ingress/TLS remain handoff gates. The actual owner account is intentionally unconfigured until the founder chooses credentials privately. Physical-device/App Store delivery, public multitenancy, billing, external integrations and automated selling are future work.

Run locally using [DEVELOPMENT.md](DEVELOPMENT.md). The [infrastructure evaluation request](INFRASTRUCTURE_REQUEST.md) is recorded below. Source licensing does not imply that a repository or service has been published.

## Handoff update — 5 November 2026

The founder authorized posting the private evaluation request. It is now [infrastructure issue #310](https://github.com/XeoNote/Infrastructure-/issues/310), containing the verified application commit and local source-archive hash. Target allocation and response are pending; posting the request is not evidence of deployment or DNS changes.
