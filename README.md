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

Use Node.js 22.12 or later in the 22.x series and npm 10:

```sh
npm ci
npm run dev
```

Open [the local web client](http://127.0.0.1:5173). The API binds to `127.0.0.1:4310`. Stop both with Ctrl-C.

```sh
npm run check
```

The first slice is a **local simulation**: create a mission, review its deterministic release brief and event history, approve or reject the exact result, and save an approved artifact. No model calls, repository changes, deployments, external messages, or purchases occur. The web client reads the local API; it does not fabricate completed runs.

State is stored in an ignored local `.data` directory by the API. This single-process development adapter precedes PostgreSQL, authentication, and the worker. Keep the API on loopback; this slice is not ready for network deployment. OpenAI, Claude, Ollama inference, RAG, and native iOS remain planned until their implementation and verification gates pass.

## Project status

Planning and initial implementation, started 4 November 2026. The complete product vision is a roadmap, not a statement of existing functionality. The first week targets an alpha with a reliable end-to-end workflow.

The open-source licence is a founder decision still to be made; no licence grant has been selected yet. Do not treat this repository as publicly released software until that decision is recorded.
