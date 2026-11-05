# Vuzmi

A self-hosted business orchestration platform bringing agents, models, knowledge and operations into one control plane. Original project code is licensed under [AGPL-3.0-only](LICENSE).

Vuzmi's larger direction is coordinated development, IT operations, support, marketing and sales with web/iOS clients and an open backend. The current private alpha turns owned product knowledge into a locally generated, cited and approved package. A separate development workflow now proposes a bounded code patch, runs isolated acceptance checks and requires exact review before saving it. Applying changes, deployment, publication, customer contact and billing remain separate capabilities.

## Start locally

Use Node.js 22.13+ in the 22.x line, npm 10, native PostgreSQL 16 with pgvector 0.8.7, and local Ollama. Follow [development instructions](docs/DEVELOPMENT.md) for native extension installation.

```sh
git clone https://github.com/Ether-X-UK/Vuzmi.git
cd Vuzmi
npm ci
npm run package:source
npm run services:start
# One-time model downloads if absent:
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull qwen3.5:4b
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull embeddinggemma:300m
npm run dev
```

Open [the web client](http://127.0.0.1:5173). First-run setup uses the private key in `.data/dev/owner-setup-key`; choose your own owner credentials. The helper owns private local PostgreSQL and a cloud-disabled Ollama daemon on 11435, leaving the user's normal11434 service untouched. Ctrl-C stops clients/API/worker; `npm run services:stop` stops the owned dependencies while preserving data.

In **Knowledge & memory**, add owned text/Markdown and wait for indexing. Create a **Local Ollama** mission with explicit evidence selections. Review the actual citations and document. Use **Revise draft** to correct its body with a recorded reason, then approve the exact saved revision. **Local outbox** downloads the approved Markdown with its hashes, provenance, retained evidence, revision history and decision record. Supplied claims and model output remain unverified.

**Import from GitHub** previews one `.md`/`.txt` file from the public `Ether-X-UK/Vuzmi` repository. Enter its full lowercase 40-character commit, repository-relative path and local source title, inspect the exact normalized text, then choose **Save and index locally**. The imported snapshot is read-only and becomes selectable after indexing. Its commit, blob and raw/normalized hashes follow retrieved evidence into approved packages. An uncertain save can be retried with the same import identity. This initial connector needs outbound HTTPS to `api.github.com`, uses no credentials and has no private-repository or automatic-sync support. Unauthenticated GitHub rate limits are shared by the server's originating IP; errors show a cooldown and do not retry automatically.

**Development** accepts a brief or optional public Vuzmi issue, pins one permitted source file and generates a local-model replacement. A dedicated offline container first reproduces the known bug, then checks the candidate. Only a complete passing result can reach exact human review and local package download. The first profile targets web401 session expiry at a fixed source revision; it does not accept arbitrary repositories, commands or dependencies. Provision the optional dedicated runtime and check image using [the runner instructions](docs/DEVELOPMENT_RUNNER.md), then run `npm run setup:development` and `npm run test:development-runner`. The document/knowledge workflows do not require this Docker VM. `OLLAMA_DEVELOPMENT_MODEL` explicitly selects the installed local development model without changing founder-document missions; there is no automatic model fallback.

```sh
npm run check
npm run test:postgres
npm run export:ios
npm run test:recovery
npm run build
npm run package:source
npm start
```

`npm start` serves the built web client and API together on [loopback 4310](http://127.0.0.1:4310), alongside the worker; PostgreSQL/Ollama must already be available. Owner authentication is required. Native iOS uses local Expo/Xcode tooling; see [mobile instructions](apps/mobile/README.md). No paid cloud build or model call is required. `npm run dev:simulation` remains an explicit, visibly labelled UI-only bypass with separate file history.

## Project records

- [Product](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), [build plan](docs/BUILD_PLAN.md) and [UI design](docs/DESIGN.md).
- [Delivery status](docs/STATUS.md): exact implemented and verified scope.
- [Development](docs/DEVELOPMENT.md), [recovery](docs/RECOVERY.md), [licensing](docs/LICENSING.md) and [research](docs/RESEARCH.md).
- [Infrastructure request](docs/INFRASTRUCTURE_REQUEST.md): posted as [infrastructure issue #310](https://github.com/XeoNote/Infrastructure-/issues/310) for private evaluation on existing hardware.

OpenAI and Claude adapters are contract-tested and disabled, with no live calls. Public SaaS, multi-tenant isolation, billing, additional connectors, automated operations and selling remain later milestones. Source deletion removes active retrieval data; historical evidence, approved packages and backups remain retained under the disclosed private-alpha boundary.

The source is public at [Ether-X-UK/Vuzmi](https://github.com/Ether-X-UK/Vuzmi), published with founder authorization on 5 November 2026 under AGPL-3.0-only. [Infrastructure issue #310](https://github.com/XeoNote/Infrastructure-/issues/310) requests a private evaluation target. Keep this evaluation on loopback until the private-ingress and operational release gates pass. Repository publication does not deploy the application or change DNS.
