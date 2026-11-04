# Local development

The current implementation is the first foundation slice, not the complete alpha. Architecture, UI specification, and the seven-day delivery plan are in the adjacent documents.

## Requirements and commands

- Node.js 22.12 or newer in the 22.x series; `.nvmrc` selects 22.
- npm 10 and network access for the first dependency installation. The lockfile makes subsequent installation reproducible.
- No provider keys, paid services, model download, Docker, or database are required for this local simulation.

From the repository root:

```sh
npm ci
npm run dev
```

The React/Vite client serves at `http://127.0.0.1:5173`, proxying `/v1` to the Fastify API at `http://127.0.0.1:4310`. Both processes are local. Ctrl-C stops them.

```sh
npm run typecheck
npm test
npm run build
# Or run all three sequentially:
npm run check
```

The web production build lands in `apps/web/dist`. Building those files is not a self-host deployment. The production reverse proxy, authenticated API, PostgreSQL, migrations, queue worker, and upgrade/recovery instructions are later acceptance gates.

## What works in this slice

1. Create a mission with a title, brief, and business domain.
2. The deterministic local template prepares a proposed release brief and records events. No model or retrieval is involved.
3. Review the exact content and local destination.
4. Approve it to save an artifact, or reject it to cancel the run without an artifact.
5. Reopen the run and its recorded history. Identical decision replays return the existing result; changed or conflicting decisions are rejected.

Artifact content is plain text/Markdown. It describes proposed work and unchecked release requirements. It must not be treated as proof that code changed, tests ran, a release shipped, or customers were contacted.

## Code boundaries

| Location | Current responsibility |
| --- | --- |
| `packages/core` | Runtime schemas, client/server types, pure simulated workflow and approval rules |
| `apps/api` | Local HTTP validation, serialized file persistence, immutable proposal decisions |
| `apps/web` | Responsive command interface, mission creation, run review, approvals, artifact access |
| `docs` | Product, architecture, design, delivery, research and infrastructure handoff |

Additional domain packages, a worker, provider adapters, and the mobile app are introduced when their milestone needs them. Do not add empty apps simply to imply feature coverage.

## Storage and configuration

The API stores a versioned workspace JSON file in its local data directory. The directory and files are ignored by Git. `VUZMI_DATA_DIR` can select a private absolute directory; `PORT` can change the API port. The Vite proxy currently targets the default port 4310. The example environment file is documentation; environment variables must be exported in the process environment.

Mutations are serialized within one API process and persisted by replacing a temporary file atomically. Startup refuses malformed state rather than overwriting it. This is not a distributed store, encrypted vault, PostgreSQL substitute, or power-loss recovery guarantee. Run one API process per data directory. The JSON adapter will be replaced by PostgreSQL-backed repositories before the deployable alpha.

There is no user authentication in this local-only slice. The API binds only to loopback and limits browser origins. Do not expose it through a tunnel, reverse proxy, public interface, or LAN before the authenticated deployment gate. Do not store production customer data or credentials in its local state.

## Verification boundaries

Domain tests cover exact approval content, stale revision/fingerprint rejection, conflicting decisions, rejection without artifact, and idempotent replay. API tests use isolated temporary storage to check persistence, concurrent decisions, request validation and corrupt-state handling. These tests do not prove PostgreSQL recovery or real inference.

Provider compatibility, RAG quality, memory deletion, native iOS builds, private-network deployment, backups/restores, and production tenant isolation need separate evidence. Record their real status rather than promoting a mock test or responsive browser preview to a completed integration.
