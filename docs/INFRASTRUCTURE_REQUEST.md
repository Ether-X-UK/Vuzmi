# Infrastructure request issue draft

Status: draft only, 4 November 2026. No external issue has been posted. Target repository: [XeoNote/Infrastructure-](https://github.com/XeoNote/Infrastructure-/). The founder confirms ample CPU/RAM and no datacenter GPU. Local development remains on the MacBook M5; no resource request is needed to start.

Suggested issue title: **Prepare existing infrastructure for a zero-cost Vuzmi self-hosted alpha**

## Request and context

Vuzmi is an open-source business orchestration platform being developed toward a polished deployable alpha by 10 November 2026. The first complete workflow uses local Ollama inference to turn a founder's change brief and owned product knowledge into a reviewed release readiness package. No production deployment or external customer send is part of that workflow.

The MacBook M5 and local Ollama remain the testbed until deployment readiness is demonstrated. Model downloads are permitted when needed. The later target is existing CPU-only infrastructure; capacity is not a current blocker. We need an existing-host deployment target and an operational handoff. There must be **no additional infrastructure, API, subscription, certificate, or build-service cost**. If existing capacity is unavailable, please report the constraint rather than purchase or provision a paid resource.

At the initial environment check, Ollama was installed locally but not running, and no running Docker daemon was available. Local model manifests include `gemma4:26b-a4b-it-qat` and `hf.co/unsloth/Qwen3.6-27B-GGUF:IQ4_XS`; loading and inference remain unverified. Start with suitable existing models and download additional models when needed within the zero-added-cost constraint. Runtime availability must be resolved or replaced with an agreed existing approach; it is not a completed setup step.

## Deployment handoff fields for the infrastructure team

| Topic | Please identify or choose | Constraint / acceptance |
| --- | --- | --- |
| Existing target host | Assign a target VM/service owner and the existing standard OS/runtime when deploy-ready | Use the existing CPU-only estate; ample CPU/RAM is confirmed and no GPU purchase is needed |
| Runtime | Existing supported container runtime/daemon, or approved native process/service approach | Must support the agreed API, worker, PostgreSQL/pgvector, and local model arrangement without new paid services |
| Initial resource allocation | Allocate application/database resources from existing capacity using the measured local workload | Application and database budgets are distinct from model memory; preserve capacity for existing workloads |
| Ollama placement | Local on the application host or another existing trusted machine; installed models and current resource usage | Keep inference private; start with existing assets and measure fit/latency. Additional models must fit available capacity and the zero-cost constraint |
| Persistence | Existing volume/location for PostgreSQL, source documents, artifacts, and model files | Survives restarts; permissions restrict access to the service owner |
| Backups and restore | Existing backup destination/process, retention, restore owner, and a safe restore-test location | No paid backup service; a restore test is required before hosted beta |
| Network boundary | Private access method, reverse proxy, TLS approach, allowed inbound/outbound paths, and admin access | Ollama/database stay private; begin with local/private exposure rather than an automatic public endpoint |
| DNS | Cloudflare owner for `vuzmi.com`; proposed alpha hostname and record target after deploy readiness | Draft suggestion: `alpha.vuzmi.com`, pending owner choice. Do not change production/root DNS merely to prepare the host |
| Operations | Service owner, restart/logging conventions, health checks, rollback mechanism, and incident contact | A failing worker or model service must be observable and recoverable |
| Secrets | Existing approved secret-injection method and operator responsibility | No credentials in the repository, issue body, logs, image layers, or DNS |

## Planned components

The stack is provisional and will be reconciled with the architecture before handoff:

- React/Vite web assets served through the agreed local/reverse-proxy arrangement.
- Fastify TypeScript API and a separate background worker.
- PostgreSQL with pgvector and a PostgreSQL-backed job queue.
- Ollama on an existing private host; OpenAI/Claude adapters disabled by default.
- Persistent document/artifact storage; no new managed storage dependency.

The application team will supply the actual service configuration, private ports/health endpoints, environment-variable names, migration commands, and measured workload after local validation. Please do not allocate arbitrary GPU capacity from this draft.

## Capacity validation plan

1. Inventory the candidate host and already installed model(s), including free RAM/disk and competing workloads.
2. Run the smallest suitable existing model against the founder-release fixture and record latency, peak resident memory, and stability.
3. Measure API, worker, database, index, and artifact storage under the single-organization alpha workload.
4. Agree initial limits, concurrency, queue behavior, storage quota, and failure thresholds from those observations.
5. If headroom is insufficient, reduce model/workload/concurrency or request an owner-approved alternative existing host. Do not assume a purchase.

## Deployment gates

- [ ] Repository is identified; a concrete resource issue can be prepared for the infrastructure team when deploy-ready.
- [ ] An existing no-additional-cost host/runtime and local inference path are available.
- [ ] Private deployment starts with the documented environment and clean database migration.
- [ ] A real Ollama founder-release run produces a reviewed, durable local artifact package.
- [ ] Restart, health checks, persistence, and rollback are demonstrated.
- [ ] Exposure/authentication/TLS configuration is reviewed for the chosen access boundary.
- [ ] DNS changes, if needed, are explicitly approved for the agreed hostname and target.
- [ ] Deployment instructions identify limitations, owner, backup/restore process, and recovery commands.

## Application-team handoff to attach later

- Exact release identifier and deployable package/source location.
- Verified startup, health, migration, backup/restore, and rollback instructions.
- Measured resource results and recommended limits.
- Environment template with placeholders only.
- Verified-provider matrix and known limitations.
- Explicit access/exposure request and any proposed DNS records.

Posting this issue does not authorize a purchase, public exposure, production DNS change, or production deployment. Those actions require the concrete request and applicable founder/infrastructure-owner authorization.
