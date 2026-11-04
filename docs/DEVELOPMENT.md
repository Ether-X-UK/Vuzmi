# Local development

The current slice connects the command interface to local Ollama generation and durable PostgreSQL execution. It is a private development foundation; the complete alpha gates remain in [BUILD_PLAN.md](BUILD_PLAN.md).

## Requirements and quickstart

- Node.js 22.12 or newer in the 22.x series; npm 10. `.nvmrc` selects 22.
- Native PostgreSQL 16 tools on PATH: `initdb`, `pg_ctl`, `psql`, and `createdb`. Tested on macOS with PostgreSQL 16.15.
- Ollama installed on the local machine. Tested with Ollama 0.40.14 and Apple M5 Metal.
- Network access for dependency installation and an optional one-time model download. No API keys or paid services are required.

```sh
npm ci
npm run services:start
# If the model is not already installed:
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull qwen3.5:4b
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/v1` to the loopback Fastify API at port 4310. `npm run dev` first ensures local dependencies are started, then runs web, API, and worker. Ctrl-C stops these three processes. Background dependencies remain available until:

```sh
npm run services:stop
```

The helper creates a private PostgreSQL cluster on `127.0.0.1:55432` under ignored `.data/dev/pgdata`, using SCRAM passwords and a non-superuser application role. It starts a separate Vuzmi-owned Ollama daemon on `127.0.0.1:11435` with `OLLAMA_NO_CLOUD=1` and one parallel inference. Existing PostgreSQL installations and the user's normal Ollama service at 11434 are not stopped or reconfigured. Model files use Ollama's normal local store. Nothing downloads automatically.

For UI development without either dependency:

```sh
npm run dev:simulation
```

That command forces the single-process file adapter, even when a local database configuration exists. It permits deterministic simulation only and rejects live model runs.

## Workflow

1. Inspect **Model control** for observed database, worker, and installed-model readiness.
2. Create a mission. Simulation is the default; Local Ollama requires an eligible installed model and a ready worker.
3. A live mission is durably queued before the worker claims it. The interface displays queued, running, failed, and waiting-for-review states from the API.
4. Review the exact Markdown document. A fixed provenance warning identifies model output as unverified and records that no retrieval, repository inspection, tests, deployment, or messages occurred.
5. Approve to save those exact bytes, or reject without saving an artifact. Approval is bound to the SHA-256 action fingerprint and aggregate revision. Identical replay returns the existing outcome; stale/conflicting decisions fail.
6. Download the approved Markdown, reopen the run, and inspect its event history.

The model proposes a document only. Domain labels do not enable development, operations, support, marketing, or sales tools. The API never silently replaces a failed live run with a simulation or a cloud provider.

## Configuration and storage

API and worker load root `.env`, then generated `.data/dev/database.env`. Explicit process variables take precedence. Never commit either file. `.env.example` contains placeholders only.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection; generated locally if not supplied. API and worker must use the same database. |
| `OLLAMA_BASE_URL` | Loopback HTTP endpoint; default `http://127.0.0.1:11435`. Remote, credential-bearing, redirecting, and path-bearing endpoints are rejected. |
| `OLLAMA_MODEL` | Default model selection; `qwen3.5:4b`. No automatic pull or model substitution. |
| `PORT` | API loopback port; default 4310. Vite currently proxies the default port. |
| `VUZMI_SIMULATION_ONLY=1` | Ignore database configuration and use the file adapter. |
| `VUZMI_DATA_DIR` | Private directory for simulation JSON, default ignored `.data`. |

A custom Ollama endpoint is operator-managed: start it with `OLLAMA_NO_CLOUD=1`. Startup does not claim to verify another daemon's cloud setting. The adapter requires eligible local model metadata, rechecks before inference, and rejects cloud names/remote-backed aliases. Metadata checks alone cannot lock models against operator replacement, so the owned cloud-disabled daemon is the default.

The local helper stores randomly generated credentials in private files (0600) within private directories (0700); logs and state remain ignored. Do not print or share connection strings. PostgreSQL application/queue migrations run on connect; application migrations use an advisory lock and checksum validation. Events and artifacts are committed atomically with aggregate changes; creating a live run and enqueueing its job share one transaction.

The worker performs inference outside database transactions. Attempts use revision and identity fences; duplicate fresh delivery cannot steal an active attempt. Transient provider failures allow two retries with backoff; worker interruption and exhausted jobs produce durable events. Queue delivery is at least once. Repeated inference is possible after interruption, while obsolete attempts cannot replace the accepted draft or create duplicate approved artifacts. Worker readiness uses a database heartbeat, expiring after 30 seconds.

The file adapter serializes writes and atomically replaces private JSON files. Run one API process per file directory. Existing file runs are not automatically imported into PostgreSQL; switching adapters displays a separate workspace history.

## Code boundaries

| Location | Responsibility |
| --- | --- |
| `packages/core` | Shared schemas, pure run transitions, approval and integrity rules |
| `packages/providers` | Bounded local-only Ollama discovery/generation, normalized usage/errors |
| `packages/runtime` | PostgreSQL migrations/repository, atomic queue writes, recoverable worker |
| `apps/api` | Loopback HTTP validation, readiness, missions and approval endpoints |
| `apps/worker` | Local runtime configuration and worker lifecycle |
| `apps/web` | Responsive command interface, actual execution state, exact review and artifacts |
| `scripts` | Owned local dependency lifecycle and isolated native PostgreSQL test harness |

## Verification

```sh
npm run check
npm run test:postgres
```

`check` runs TypeScript, domain/API/provider fixture tests, and the production web build. Provider fixtures protect local-only routing, remote aliases, output bounds, redirects, deadlines, malformed responses, missing usage, and cancellation. They are not proof of a live inference.

`test:postgres` creates a disposable private cluster on a free loopback port, supplies its URL only to the test process, runs real database/queue tests, then stops/removes the cluster. It fails if native tools or tests are missing. It checks transactions, replay/concurrent approval, workspace qualification, migrations, persistence, retry/recovery, stale attempts, and worker heartbeat. This is distinct from backup/restore, which remains an alpha gate.

The web build lands in `apps/web/dist`. A build is not a self-host deployment. There is no user authentication yet: keep the API on loopback and do not expose it through a tunnel, reverse proxy, public interface, or LAN. The repository queries use workspace-qualified keys; production tenant isolation, restricted migration/runtime roles, identity, backup restore, packaging, RAG quality, and native iOS require separate implementation and evidence. See [STATUS.md](STATUS.md) for actual results.
