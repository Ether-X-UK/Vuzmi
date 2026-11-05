# Infrastructure evaluation request

Status: posted with founder authorization on 5 November 2026 as [issue #310](https://github.com/XeoNote/Infrastructure-/issues/310). The request is open; target allocation and infrastructure response are pending. No infrastructure/DNS change has been performed by the application team. Target: [XeoNote/Infrastructure-](https://github.com/XeoNote/Infrastructure-/). Licence: AGPL-3.0-only. Existing hardware only; zero additional service cost.

Posted title: **Allocate a private CPU-only evaluation target for Vuzmi alpha**

## Requested outcome

Provide an isolated evaluation target on the existing estate for Vuzmi's private single-owner alpha. Its workflow is owned product text/Markdown → local retrieval and Ollama draft → human review → exact approved local package. It does not execute host commands, deploy applications, send customer messages, publish campaigns or bill customers.

Local MacBook M5 validation now covers native PostgreSQL 16/pgvector, local Ollama generation/embedding, owner auth, web review and downloads, an actual native iOS Simulator companion, and backup/restore between disposable databases. This is not a claim that Linux/CPU-server latency, private ingress or operational backups have passed. The next environment is a test target, not production SaaS.

## Concrete capacity and placement proposal

These are conservative starting allocations for measurement, not benchmark results or new purchases. Infrastructure may use smaller existing allocations if the same acceptance workload passes without competing with existing services.

| Component                       | Initial request                                                                                                           | Boundary                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| App/worker/Ollama evaluation VM | Existing Linux VM capacity: 8 vCPU, 16 GiB RAM, 80 GiB persistent disk                                                    | API/worker and Ollama share the host so the current local-only model adapter remains valid. No GPU required. One inference at a time.       |
| Application database            | Private PostgreSQL 16 database with pgvector 0.8.7 in public, initial 20 GiB quota plus existing snapshot/backup capacity | Dedicated application DB/owner and SCRAM credentials. No database or Ollama port exposed to users. Existing DB tier is acceptable.          |
| Model store                     | Persistent private Ollama store within the VM budget; start with qwen3.5:4b and embeddinggemma:300m                       | Match the verified digest/profile, download only from official model distribution, keep cloud disabled. Do not silently substitute a model. |
| Source/build                    | Exact reviewed Git revision/source archive, Node 22.13+ in 22.x, npm lockfile                                             | No public Git repository destination has been selected or published yet. Artifact transfer is a separate handoff.                           |
| Access                          | Owner/admin private access through the existing approved VPN/private ingress method                                       | No internet-wide access, Cloudflare tunnel or root-domain change requested.                                                                 |

The existing infrastructure repository describes Proxmox/Terraform provisioning, separate application/database tiers and established backup facilities. Use those conventions rather than copying infrastructure credentials or private network inventories into this application repository. The infrastructure team owns placement, VM identifiers, routes, firewall rules and administration.

## Runtime contract

- Native processes: Fastify API serving the built web client, separate worker, local cloud-disabled Ollama. Container deployment is not yet validated and is not required by this request.
- Install project dependencies with `npm ci`, build with `npm run build`, then start with `npm start` under the approved supervisor. The command runs API/worker without development watchers and refuses simulation/auth bypasses.
- API binds to 127.0.0.1:4310; Ollama binds to 127.0.0.1:11435. PostgreSQL is accessible only through the approved private database path.
- `/healthz`: minimal API liveness. `/readyz`: database-backed runtime, fresh worker heartbeat and configured owner authentication. Neither endpoint claims a successful model inference. Perform the authenticated workload separately.
- Application/queue/auth migrations run on connection with locks/checksums. Provision the vector extension administratively first. Migration/runtime role separation is still a hardening gate; restrict the current owner role to this dedicated application DB.
- Operator creates the real owner credentials privately; no known password or demo identity is supplied. Public signup, mail and social auth are disabled.
- Supply server-only `DATABASE_URL`, `BETTER_AUTH_SECRET`, `VUZMI_OWNER_SETUP_KEY`, `VUZMI_PUBLIC_URL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL` and `OLLAMA_EMBEDDING_MODEL` through the existing approved secret/configuration mechanism. See [.env.example](../.env.example). Never put values in the issue, logs or source archive.
- For a later approved TLS reverse proxy, preserve the exact configured public Origin and use a loopback upstream Host accepted by the API. Keep database/model endpoints private. Review this integration in the target environment before enabling owner access through it.
- No new hostname or DNS record is required for initial loopback/SSH evaluation. If a private TLS hostname is later needed, propose it with the concrete target and access restrictions for separate approval; `alpha.vuzmi.com` remains a suggestion only.

## Persistence, recovery and source offer

All current live source text, vectors, memories, run evidence, approvals and artifacts are in PostgreSQL. Keep its persistent volume separate from ephemeral builds. Model files and the signing secret require their own protected recovery path. Simulation JSON is a development option and is not deployed here.

`npm run backup:local` produces a private whole-DB archive plus the original signing secret. The local bundle is explicitly unencrypted; it must not be uploaded as-is. Please identify the existing encrypted backup destination, key custody, schedule/retention, alerting, restore owner and an empty restore-test target. Review [RECOVERY.md](RECOVERY.md). Restoration quarantines pending inference and requires session revocation and deletion-state review before serving data. No RPO/RTO guarantee is established by the local fixture drill.

`npm run package:source` prepares the exact committed AGPL source bundle; the running interface offers its matching source through `/source`. Keep the corresponding source offer valid for every hosted modification. No application code is hidden behind a proprietary backend.

## Acceptance and requested response

Please respond with the chosen existing target/OS, resource allocation, application/DB owners, secret injection method, private access plan and recovery arrangement. Do not provision paid services or widen public access.

- [ ] Existing capacity/owner and isolated test target confirmed.
- [ ] Native Linux installation, clean migrations, auth setup and supervision verified.
- [ ] Actual CPU-only generation/embedding latency, memory, disk and stability measured on the representative founder mission.
- [ ] Real owned document → citation → approval → downloaded package flow succeeds without cloud egress.
- [ ] API/worker restart preserves the same approved bytes/events and returns dependency health.
- [ ] Private ingress/TLS, cookies/origin enforcement and exact source offer verified for the chosen access boundary.
- [ ] Encrypted operational backup plus restore/session-revocation drill passes on a separate empty target.
- [ ] Rollback procedure verified with matching application version and backup; incompatible migrations fail closed.

Supporting application records: [DEVELOPMENT.md](DEVELOPMENT.md), [STATUS.md](STATUS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [RECOVERY.md](RECOVERY.md) and [LICENSING.md](LICENSING.md). The issue includes reviewed application commit `e494dd995c165fe97cb3de697e398a1ada273fc9` and its local source archive SHA-256 `ee09476ea5ba236f892bea8cbcd23b1e4d2248d544f0539b5143ceb41c451eca`. The archive has not been uploaded or attached. This request does not authorize added spend, production deployment, DNS changes or public exposure.
