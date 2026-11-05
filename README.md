# Vuzmi

A self-hosted business orchestration platform bringing agents, models, knowledge and operations into one control plane. Original project code is licensed under [AGPL-3.0-only](LICENSE).

Vuzmi's larger direction is coordinated development, IT operations, support, marketing and sales with web/iOS clients and an open backend. The current private alpha foundation focuses on one reliable workflow: owned product knowledge → real local model draft → cited review → exact approval → durable local package. It does not autonomously implement, deploy, publish, contact customers or sell subscriptions.

## Start locally

Use Node.js 22.13+ in the 22.x line, npm 10, native PostgreSQL 16 with pgvector 0.8.7, and local Ollama. Follow [development instructions](docs/DEVELOPMENT.md) for native extension installation.

```sh
npm ci
npm run services:start
# One-time model downloads if absent:
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull qwen3.5:4b
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull embeddinggemma:300m
npm run dev
```

Open [the web client](http://127.0.0.1:5173). First-run setup uses the private key in `.data/dev/owner-setup-key`; choose your own owner credentials. The helper owns private local PostgreSQL and a cloud-disabled Ollama daemon on 11435, leaving the user's normal11434 service untouched. Ctrl-C stops clients/API/worker; `npm run services:stop` stops the owned dependencies while preserving data.

In **Knowledge & memory**, add owned text/Markdown and wait for indexing. Create a **Local Ollama** mission with explicit evidence selections. Review the actual citations and document, then approve to save those exact bytes. **Local outbox** downloads the approved Markdown with its hashes, provenance, retained evidence and decision record. Supplied claims and model output remain unverified.

```sh
npm run check
npm run test:postgres
npm run export:ios
npm run test:recovery
npm run build
npm start
```

`npm start` serves the built web client and API together on [loopback 4310](http://127.0.0.1:4310), alongside the worker; PostgreSQL/Ollama must already be available. Owner authentication is required. Native iOS uses local Expo/Xcode tooling; see [mobile instructions](apps/mobile/README.md). No paid cloud build or model call is required. `npm run dev:simulation` remains an explicit, visibly labelled UI-only bypass with separate file history.

## Project records

- [Product](docs/PRODUCT.md), [architecture](docs/ARCHITECTURE.md), [build plan](docs/BUILD_PLAN.md) and [UI design](docs/DESIGN.md).
- [Delivery status](docs/STATUS.md): exact implemented and verified scope.
- [Development](docs/DEVELOPMENT.md), [recovery](docs/RECOVERY.md), [licensing](docs/LICENSING.md) and [research](docs/RESEARCH.md).
- [Infrastructure request](docs/INFRASTRUCTURE_REQUEST.md): posted as [infrastructure issue #310](https://github.com/XeoNote/Infrastructure-/issues/310) for private evaluation on existing hardware.

OpenAI and Claude adapters are contract-tested and disabled, with no live calls. Public SaaS, multi-tenant isolation, billing, external connectors, automated operations and selling remain later milestones. Source deletion removes active retrieval data; historical evidence, approved packages and backups remain retained under the disclosed private-alpha boundary.

The local source is licensed; [infrastructure issue #310](https://github.com/XeoNote/Infrastructure-/issues/310) is posted. No application repository has been published, DNS changed or production release performed. Keep this evaluation on loopback until the private-ingress and operational release gates pass.
