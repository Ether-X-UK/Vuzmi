# Vuzmi

An open-source, self-hostable business orchestration platform for coordinated agents, models, knowledge, and operations.

Vuzmi will connect development and IT operations with client support, marketing, and sales through one execution system. Web and iOS clients will share a backend that supports OpenAI, Anthropic Claude, and Ollama.

## Start here

- [Product definition](docs/PRODUCT.md): audience, outcomes, scope, and open decisions.
- [Architecture](docs/ARCHITECTURE.md): components, data, execution, security, deployment, and technical decisions.
- [Build plan](docs/BUILD_PLAN.md): the first seven days, acceptance gates, and the path to a hosted SaaS.
- [Research](docs/RESEARCH.md): primary sources and integration constraints.
- [Interface design](docs/DESIGN.md): visual system, desktop/mobile flows, and interaction states.
- [Development](docs/DEVELOPMENT.md): run the current slice locally.
- [Delivery status](docs/STATUS.md): implemented features and verification evidence.
- [Infrastructure request](docs/INFRASTRUCTURE_REQUEST.md): an unposted handoff draft for the existing infrastructure team.

## Run locally

Use Node.js 22.12 or later in the 22.x series, npm 10, native PostgreSQL 16 tools, and Ollama:

```sh
npm ci
npm run services:start
# One-time download if this model is not installed:
OLLAMA_HOST=http://127.0.0.1:11435 ollama pull qwen3.5:4b
npm run dev
```

Open [the local web client](http://127.0.0.1:5173). The API binds to `127.0.0.1:4310`. Ctrl-C stops the clients and worker; `npm run services:stop` stops Vuzmi's database and Ollama processes. Existing services on Ollama's usual port 11434 are untouched.

```sh
npm run check
npm run test:postgres
```

Create a mission using **Local Ollama** to generate a draft with an installed local model, or choose the explicitly labelled deterministic **Simulation**. Review the exact document and approve or reject it. Approval saves the reviewed bytes as a local Markdown artifact. PostgreSQL persists runs, events, approvals, and artifacts; a separate pg-boss worker performs bounded, recoverable generation.

Model output remains unverified. No repository changes, tools, deployment, external messages, or purchases are performed. OpenAI, Claude, RAG, authentication, and native iOS remain planned. Keep this private development slice on loopback; it is not ready for network deployment.

For the simulation alone, use `npm run dev:simulation`; no database or Ollama is required. See [development instructions](docs/DEVELOPMENT.md) for storage, configuration, and verification boundaries.

## Project status

Planning and initial implementation, started 4 November 2026. The complete product vision is a roadmap, not a statement of existing functionality. The first week targets an alpha with a reliable end-to-end workflow.

The open-source licence is a founder decision still to be made; no licence grant has been selected yet. Do not treat this repository as publicly released software until that decision is recorded.
