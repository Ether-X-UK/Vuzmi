# Vuzmi

A self-hosted business orchestration platform bringing agents, models, knowledge and operations into one control plane. Original project code is licensed under [AGPL-3.0-only](LICENSE).

Vuzmi's larger direction is coordinated development, IT operations, support, marketing and sales with web/iOS clients and an open backend. The current private alpha turns owned product knowledge into a locally generated, cited and approved package. A separate development workflow proposes bounded code changes, runs isolated checks and requires exact review before saving a package. A second explicit authorization can create its fixed local work branch without changing the active checkout. A third reviewed action can publish the exact commit as a GitHub draft PR when an operator connects the optional publication worker. Merge, deployment, customer contact and billing remain later capabilities.

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

**Development** accepts a brief or optional public Vuzmi issue against an immutable operator-provisioned source profile. The reusable web-client profile pins a clean full commit and three permitted source files; the local model can replace a nonempty subset. Separate offline containers check the baseline and candidate against nineteen sealed regressions. Passing those checks does not prove the brief was fulfilled; exact human review remains required. The original historical web401 profile retains its known-red baseline and saved packages. Neither profile accepts arbitrary repositories, commands, tests or dependencies.

Package approval saves only the exact reviewed artifact. **Review local application** presents a separate plan binding its SHA-256, base and fixed `vuzmi/development/<run ID>` branch. Explicit application authorization lets the trusted worker create that local branch and an independent receipt. It does not execute generated code on the host, change the active checkout/index, push, open a PR, merge or deploy. Unknown outcomes and conflicting branches stay visible; a restored unfinished application cannot replay automatically.

**GitHub delivery** prepares a separate public draft-PR plan with exact commit metadata, title/body, destination, observed `main` and full fingerprint. Publication stays disabled without an explicitly configured private worker token file; existing Git CLI credentials are never adopted. A separately authorized operation uploads exact objects, creates only the fixed branch and one draft PR, then retains an independent receipt. Unknown writes receive read-only reconciliation rather than blind retries. Explicit refresh observes the named PR workflow for the exact head and marks missing, failed or stale CI accurately. See [GitHub delivery setup and boundaries](docs/GITHUB_DELIVERY.md). Real remote commit reconstruction/publication remains unverified until an owner-authorized live attempt.

Provision the optional dedicated runtime and both check profiles using [the runner instructions](docs/DEVELOPMENT_RUNNER.md), then run `npm run test:development-runner`. The document/knowledge workflows do not require this Docker VM. `OLLAMA_DEVELOPMENT_MODEL` explicitly selects the installed local development model without changing founder-document missions; there is no automatic model fallback. Native development review/application controls remain deferred.

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
