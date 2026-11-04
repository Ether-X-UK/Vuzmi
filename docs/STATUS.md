# Delivery status

Updated 4 November 2026. This file describes delivered code; the architecture and build plan describe the larger target. The founder accepted the initial UI direction as a starting point.

## Implemented local foundation

- Product definition, full target architecture, seven-day build plan, primary-source research, desktop/mobile UI design, and an unposted infrastructure issue draft are recorded.
- The TypeScript workspace contains React/Vite web, Fastify API, separate worker, shared domain rules, native Ollama transport, and PostgreSQL/pg-boss runtime packages.
- Model control discovers eligible installed local models and reports actual database, worker, and Ollama readiness independently of saved workspace data.
- Missions explicitly select Simulation or Local Ollama. Simulation is the default. Live requests require PostgreSQL, a ready worker, and an eligible installed model; there is no cloud or simulation fallback.
- Local Ollama generation creates a draft with an unverified-output provenance warning. Model identity and observed usage are recorded; absent usage remains unknown. No retrieval, repository inspection, tools, code changes, deployment, or messages occur.
- PostgreSQL persists aggregates, append-only events, decisions, and artifacts. Run creation and queue insertion share a transaction; approval commits the exact reviewed artifact atomically.
- Attempts use revision/identity fences, bounded retries, queue and shutdown cancellation signals, worker heartbeat, and exhausted-job reconciliation. At-least-once delivery may repeat inference; stale output cannot replace the accepted draft.
- Approval binds to the proposal's SHA-256 fingerprint and revision. Identical replay returns the existing outcome; stale or conflicting decisions fail. Rejection creates no artifact.
- A file-backed single-process simulation remains available for UI development without PostgreSQL or Ollama. It is separate from the PostgreSQL history.
- Local helpers own a private native PostgreSQL cluster and a dedicated cloud-disabled Ollama process. The user's existing Ollama service on 11434 is untouched.
- The API remains loopback-only with host/origin checks. Authentication and network deployment are incomplete.

## Verification

| Check | Result |
| --- | --- |
| Domain/API/provider fixture tests | 39 passed, no failures or skips (`npm test`) |
| Real PostgreSQL/pg-boss integration | 13 passed, no failures or skips (`npm run test:postgres`; 12 scenarios plus wrapper) |
| TypeScript and web production build | Passed (`npm run check`) |
| Native local dependency bootstrap | Passed with PostgreSQL 16.15 and Ollama 0.40.14 on the M5 |
| Real local generation | `qwen3.5:4b`: 343 input / 1,114 output tokens; provider-reported duration 38.75 seconds for one smoke mission |
| Browser local Ollama flow | Created → queued/running → exact document → approve → saved artifact; download bytes match both proposal and persisted artifact |
| Full local service restart | PostgreSQL, Ollama, API, worker, and web restarted; the approved bytes and single artifact event persisted and runtime returned ready |
| Current mobile/desktop checks | Live review at 1440px; Model control and live-mission dialog at 390px with no horizontal overflow; mobile Models navigation works |
| Prior simulation browser coverage | Desktop approval/reload, mobile rejection, exact-document access, keyboard skip navigation, no horizontal overflow at 390px/769px |
| Backup/restore | Not implemented or verified |
| Native iOS build | Not implemented or verified |

The live smoke mission is retained in ignored local PostgreSQL data, not seeded or committed into the repository. Its generated document is an unverified draft, not a declaration of release readiness. The timing is one observed run, not a benchmark. A single smaller model was downloaded under the founder's authorization; no paid model route was used.

Database evidence covers atomic run+queue rollback, immutable event enforcement, concurrent approvals across repository instances, workspace-qualified access, reconnect persistence, recovery, duplicate jobs, worker heartbeat, bounded failures, exhausted-job reconciliation, migration checksum refusal, and corrupt-state detection. Cancellation regressions deliberately ignore abort signals in the fake generator and prove obsolete results cannot publish after a lost lease or shutdown.

## Next milestone

1. Ingest versioned owned product documents; add source-scoped retrieval with real citations, deletion, and explicit curated memory.
2. Complete the founder release package and durable local outbox using retrieved evidence; keep proposed work distinct from verified outcomes.
3. Add authenticated private deployment, the native iOS approval companion, packaging, and backup/restore gates.

OpenAI and Claude are not implemented or live-verified. Public SaaS, tenant isolation, billing, automated development/IT execution, client support, marketing/sales connectors, and automated selling remain roadmap work. No source repository has been published, infrastructure issue posted, DNS changed, or paid service enabled. The licence remains a founder decision.
