# Working on Vuzmi

## Product and delivery

- Read `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, and `docs/BUILD_PLAN.md` before changing scope or architecture.
- Keep documentation honest about implemented, simulated, proposed, and unverified behavior.
- Preserve the order: architecture and build plan, then UI design, then implementation.
- The founder has authorized the orchestrator to use subagents for research, design, planning, code, and review. Give agents bounded ownership to avoid conflicting edits.
- Prefer complete vertical slices with observable results over unrelated module stubs.

## Engineering

- Use strict TypeScript and shared contracts at client/server boundaries. Keep provider SDKs and secrets on the server.
- Model selection must respect capability, data residency, cost, and policy constraints before optimizing price or latency. No silent fallback from local to cloud.
- Persist execution state and evidence. Treat retried external work as at-least-once and require idempotency; do not claim exactly-once side effects.
- Tenant and project boundaries apply to retrieval, memory, files, runs, and integration credentials.
- Models propose actions; trusted application code validates and authorizes execution. Retrieved content is untrusted input.
- External sends, spending, destructive operations, and production releases require concrete reviewable actions and explicit applicable authorization.
- Never log, commit, or expose credentials. Use environment examples with placeholders only.
- Test behavior and failure boundaries appropriate to the change. Run type checks, relevant tests, and builds before handoff. Report verification limitations.

## Collaboration

- Keep architecture decisions in the repository and record material changes to the plan.
- Avoid adding infrastructure or dependencies without a concrete need in the current milestone.
- Do not select the licence, publish the repository, purchase services, or send outreach on the founder's behalf without an explicit decision.
