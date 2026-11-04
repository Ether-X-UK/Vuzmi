# Delivery status

Updated 4 November 2026. This file describes delivered code; the architecture and build plan describe the larger target.

## First foundation slice

- Product definition, full target architecture, primary-source research, seven-day build plan, UI design, and an infrastructure issue draft are recorded.
- A TypeScript npm workspace contains the shared contracts/domain rules, Fastify API, and React/Vite web client.
- Mission creation prepares an explicitly labelled deterministic release brief. It does not run a model or retrieve knowledge.
- Decisions bind to the proposal's SHA-256 fingerprint and revision. Approval saves a local artifact; rejection cancels without one.
- Identical decision replays return the existing outcome. Conflicting or stale decisions fail.
- The API serializes writes to a private local JSON file and refuses corrupt or inconsistent state at startup. It is a single-process development adapter.
- The API binds only to loopback and checks browser origins. User authentication and network deployment are not implemented.

## Verification

| Check | Result |
| --- | --- |
| Domain tests | 5 passed |
| API integration tests | 10 passed |
| TypeScript checks | Passed for the final integrated source |
| Browser workflow and visual review | Passed: desktop approval and reload, mobile rejection and exact-document access, no horizontal overflow at 390px |
| Web production build | Passed after final accessibility fixes (`npm run check`) |
| Live provider calls | None performed |
| PostgreSQL/queue/restore | Not implemented or verified |
| Native iOS build | Not implemented or verified |

API evidence covers concurrent writes, approved/rejected decisions, stale fingerprint/revision, idempotent decision replay, restart persistence, corruption refusal, origin/host guards, and disk-write failure without false completion.

## Next mandatory milestone

1. Verify a suitable existing Ollama model on local hardware, with cloud calls disabled.
2. Replace the local file adapter with PostgreSQL-backed execution and migrations; introduce a worker with tested recovery.
3. Add source ingestion, retrieval with real citations, and explicit curated memory.
4. Complete the founder release-preparation workflow through real local inference and a concrete reviewed package.
5. Add authenticated private deployment and the native iOS approval companion, then run the packaging and restore gates.

OpenAI and Claude compatibility, production automation, client support, marketing/sales connectors, public SaaS billing, and automated selling remain roadmap work. No source repository has been published, infrastructure issue posted, DNS changed, or paid service enabled. The licence remains a founder decision.

Confirmed delivery environment: MacBook M5 with local Ollama; new models may be downloaded when needed. Later CPU-only infrastructure has ample capacity and requests target `XeoNote/Infrastructure-`. No deployment resources are needed for the current local slice.

Browser QA used an isolated temporary workspace. The repository has no seeded runs or committed test data. Keyboard skip navigation preserves the run URL, compact navigation has accessible names, and 390px/769px layouts were checked for horizontal overflow. Native iOS remains a separate milestone.
