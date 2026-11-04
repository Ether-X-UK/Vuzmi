# Local development and private self-hosting

The current foundation has real local generation, versioned retrieval, curated memory, owner authentication, and an approved local artifact workflow. It runs on existing hardware with no paid model calls or hosted builds. See [STATUS.md](STATUS.md) for verification and the remaining alpha gates.

## Requirements

- Node.js 22.13 or newer in the 22.x series; npm 10. `.nvmrc` selects22.
- Native PostgreSQL 16 tools on PATH: `initdb`, `pg_ctl`, `psql`, `createdb`, `pg_dump`, `pg_restore`. Tested with 16.15 on macOS.
- pgvector 0.8.7 installed for that PostgreSQL major version. The database administrator installs the extension; the application role remains non-superuser.
- Local Ollama; tested with 0.40.14 and Apple M5 Metal. Models need a one-time local download. No API keys are required.
- iOS development additionally needs Xcode, the matching Apple Simulator runtime, and CocoaPods. See [mobile instructions](../apps/mobile/README.md). No EAS subscription or Apple distribution account is needed for a local Simulator build.

On this Mac, PostgreSQL 16's native extension was built from the [official pgvector source](https://github.com/pgvector/pgvector) at tagv0.8.7:

```sh
git clone --branch v0.8.7 --depth 1 https://github.com/pgvector/pgvector.git /private/tmp/vuzmi-pgvector
cd /private/tmp/vuzmi-pgvector
make PG_CONFIG=/opt/homebrew/opt/postgresql@16/bin/pg_config
make install PG_CONFIG=/opt/homebrew/opt/postgresql@16/bin/pg_config
```

Installation writes to the selected PostgreSQL extension directory and may need local administrator permission. Use the `pg_config` for your own PostgreSQL 16 installation. Do not upgrade or overwrite another cluster to satisfy this prerequisite. The helper reports a missing extension and preserves existing data.

## Quickstart

From the repository root:

```sh
npm ci
npm run services:start
# One-time downloads only when absent:
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull qwen3.5:4b
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull embeddinggemma:300m
npm run dev
```

Open [the web client](http://127.0.0.1:5173). Vite proxies `/v1` and `/api/auth` to the loopback API on 4310. The first visit requests the private key in `.data/dev/owner-setup-key`, your name/email, and a password of 12–128 characters. Choose your own credentials. Setup creates one immutable owner binding, then signs in. Email ownership is not verified and no mail is sent. Public signup and password-reset delivery are disabled. Keep the private key and signing secret safe; neither is a replacement for the owner's password.

`services:start` creates an ignored private PostgreSQL cluster on 55432, a non-superuser application role, random database credentials, and private authentication files. It starts a separate Vuzmi-owned Ollama daemon on 11435 with cloud disabled and one parallel inference. It leaves the user's normal11434 daemon and other databases untouched. Models use Ollama's normal local store. Nothing downloads automatically.

Ctrl-C stops web/API/worker. Dependencies remain until `npm run services:stop`. That command only stops Vuzmi-owned services and preserves their data.

For clearly labelled deterministic UI development without PostgreSQL, Ollama, or sign-in:

```sh
npm run dev:simulation
```

This explicitly enables a loopback-only development bypass. It displays a warning badge, uses separate file-backed history, and rejects live generation and knowledge operations. It is refused by the self-host command.

## Using the workflow

1. Sign in and inspect **Model control** for independently observed database, worker, and local-model health.
2. Open **Knowledge & memory**. Paste or upload plain text/Markdown up to 64KiB, then wait for indexing. Titles, revisions, status and failures are visible. No URL crawler, PDF parser, OCR or connector sync is implied.
3. Optionally add a confirmed workspace memory with manual or source provenance and optional expiry. Conversations are not automatically retained as memory.
4. Test retrieval using explicit source/memory selections. Excerpts show their exact source revision and line range; ranking scores are not confidence in a factual claim.
5. Create a mission, select **Local Ollama**, and explicitly require selected evidence when needed. Required evidence cannot silently disappear or fall back to another source/model/provider. Empty retrieval stops the run before generation.
6. Review the actual Markdown, fixed provenance warning, retained evidence and clickable citation labels. Claims in supplied sources and generated output remain unverified unless separate evidence establishes them.
7. Approve the exact fingerprint/revision to save those reviewed bytes, or reject without saving an artifact. Approval is a local save only. It does not change code, post an infrastructure issue, deploy, publish or contact anyone.
8. Download the Markdown or approved package. The package preserves the original action fingerprint separately from the exact Markdown SHA-256, with provenance, evidence and decision history.

Changed or deleted knowledge fences an in-progress grounded draft. Failed re-indexing preserves the previous active index for explicitly observed search, but a mission cannot treat an incomplete newer revision as current. The embedding profile pins model digest,768 dimensions, L2 normalization and prompt versions. Switching models/profile requires a deliberate migration; there is no silent fallback.

Deleting a source removes active original text, revisions, chunks, vectors and source-linked memory. **Historical run excerpts, artifacts, downloaded copies and backups remain retained.** The UI discloses this boundary. This private-alpha operation is not a claim of total erasure.

## Configuration and storage

API/worker load root `.env`, then generated `.data/dev/database.env`; explicitly exported environment variables win. Private files must be 0600 within 0700 directories. Never commit `.env`, `.data`, database dumps, signing secrets, setup keys, cookies or passwords. Examples contain placeholders only.

| Variable                  | Purpose                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Shared PostgreSQL URL; generated locally if absent.                                                                                     |
| `OLLAMA_BASE_URL`         | Local HTTP endpoint; default `http://127.0.0.1:11435`. Remote, redirecting, credential-bearing and path-bearing endpoints are rejected. |
| `OLLAMA_MODEL`            | Default generation model, `qwen3.5:4b`. No automatic pull/substitution.                                                                 |
| `OLLAMA_EMBEDDING_MODEL`  | `embeddinggemma:300m`; must match the pinned workspace profile.                                                                         |
| `BETTER_AUTH_SECRET`      | Strong server-only signing secret; otherwise `.data/dev/auth-secret`.                                                                   |
| `VUZMI_OWNER_SETUP_KEY`   | Private bootstrap key; otherwise `.data/dev/owner-setup-key`.                                                                           |
| `VUZMI_PUBLIC_URL`        | Exact same-origin auth URL; development defaults to 5173, `npm start` to its API port. HTTP is loopback-only.                           |
| `PORT`                    | API loopback port, default 4310. Vite development proxy uses4310.                                                                       |
| `VUZMI_DEV_NO_AUTH=1`     | Explicit loopback testing bypass; never a deployment default.                                                                           |
| `VUZMI_SIMULATION_ONLY=1` | Separate file adapter with no live generation.                                                                                          |
| `VUZMI_DATA_DIR`          | Private simulation-state directory, default ignored `.data`.                                                                            |

A custom Ollama daemon is operator-managed: start it with `OLLAMA_NO_CLOUD=1`. Discovery checks local metadata/digest; it cannot prevent an operator replacing a model concurrently. The owned daemon is the default. OpenAI/Claude contracts require an explicit injected transport and remote-execution opt-in; no application route or environment toggle enables paid calls. They are fixture-tested, not live-verified. Subscription sign-in integration remains separate and unconfigured.

PostgreSQL persists aggregates, append-only events, approvals, retained evidence and artifacts. Application migrations are checksum-checked under an advisory lock; auth migrations pin their maintained library versions. API/worker use separate pools but the same DB. Creating a live run and its queue job is atomic. Attempts use revision/identity fences, bounded retries and abort checks after lock acquisition and before commit. Delivery is at least once and can repeat inference after interruption; it must not replace accepted output. Stale missing queue jobs terminate with a visible failure. Worker health expires after 30seconds.

## Run the built self-host package

```sh
npm run build
npm start
```

Open [the combined web/API service](http://127.0.0.1:4310). This starts the API and worker without file watchers, serves only `apps/web/dist`, and requires PostgreSQL plus owner auth. Local dependencies must already be running. Ctrl-C stops both children. The service remains bound to loopback and does not configure a proxy, TLS, DNS, infrastructure, or public exposure.

`/healthz` is minimal API liveness. `/readyz` additionally requires PostgreSQL-backed execution, a fresh worker heartbeat and configured owner authentication; it deliberately does not claim an Ollama inference passed. Model/embedding readiness remains visible after sign-in. A missing build, database, secret, incompatible migration or occupied port fails startup.

For later infrastructure handoff use [INFRASTRUCTURE_REQUEST.md](INFRASTRUCTURE_REQUEST.md), still an unposted draft. Private ingress/TLS, Linux packaging validation, separate migration/runtime roles and encrypted off-host backups remain release gates. A native local package is not public SaaS readiness.

## Verification and recovery

```sh
npm run check
npm run test:postgres
npm run export:ios
npm run test:recovery
```

`check` runs strict root/mobile TypeScript, core/provider/API/native transport fixtures and the production web build. Provider fixtures are not live calls. `test:postgres` creates a disposable private cluster on a free port and removes it afterward; it covers real queue/transaction behavior, knowledge lifecycle, exact decisions, auth bootstrap/session boundaries, migration drift and recovery regressions. It does not create the operator's owner account. The iOS export bundles JavaScript; report native compilation separately.

[RECOVERY.md](RECOVERY.md) documents private whole-database backup and restore into a separate empty target. A backup is sensitive and unencrypted. A restore must not wipe the original database, start inference, or silently expose restored sessions. Deletion can be rolled back by an older backup; public retention promises require a separate gate.
