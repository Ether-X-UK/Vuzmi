# Local development checks runner

The original bounded `web-api-status-authority@1` profile described in architecture §25 targets Vuzmi's owned public repository at commit `a7d088e4954f848da392eed91684dfb445d5ce45`. Only `apps/web/src/api.ts` may change in that historical profile. The reusable profile below follows architecture §26. Both produce observed check evidence for an exact local patch package; the real checkout stays unchanged. Checks do not establish that arbitrary generated code is safe or an arbitrary task was fulfilled.

The API has no Docker connection. A separate trusted worker loads `.data/dev/development-runner.json`, publishes readiness and owns execution. Missing configuration, image, daemon, policy or complete evidence blocks this workflow. There is no host execution or model-provider fallback.

## Dedicated Mac runtime

Use free Colima/Lima with a separate Docker VM. The initial local verification uses Apple Silicon/macOS26, aarch64, 2 CPUs, 4GiB RAM and a 20GiB container-data disk. OrbStack's commercial licence is not assumed. Installation and VM startup are operator setup; the provisioning script never performs them.

After installing Colima and its supported Lima dependency, create the dedicated VM:

```sh
colima start vuzmi \
  --runtime docker --vm-type vz --arch aarch64 \
  --cpus 2 --memory 4 --disk 20 \
  --template=false --mount=none --port-forwarder=none \
  --ssh-agent=false --ssh-config=false --activate=false \
  --vz-rosetta=false --binfmt=false
```

Verify the generated profile has `mounts: null`, `portForwarder: none`, `forwardAgent: false`, `sshConfig: false` and `autoActivate: false`; inspect guest mounts to confirm no host home/project shares. `mounts: []` would share HOME writable and is unsuitable. The Docker socket is `~/.colima/vuzmi/docker.sock`; no command changes the default Docker context. [Colima v0.10.3 flags](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/start.go), [mount semantics](https://github.com/abiosoft/colima/issues/1533), [profiles](https://colima.run/docs/profiles/)

## Provision the trusted profile

From the repository root, with Node22 and the dedicated VM already running:

```sh
node --import tsx scripts/setup-development.mjs
```

Provisioning reads reviewed Git objects at the full pinned commit, never the live working tree, environment files, operator data or model output. The commit must exist locally; shallow CI checkouts must fetch it. It exports exact regular Git blobs and executable modes with replacement objects disabled, so archive export-ignore/export-subst attributes cannot omit or rewrite source. Git transports and lazy fetching are disabled; partial/promisor repository configuration is rejected before reading objects. It rejects symlinks/submodules/private paths, verifies source and lockfile bytes, and adds the separately sealed acceptance harness. Build metadata stays outside the exported source directory. Public official Node22 slim is pulled anonymously for the native Linux platform and resolved to a repository digest. The trusted provisioning build installs the pinned lockfile with `npm ci --ignore-scripts --no-audit --no-fund --workspace @vuzmi/core --include-workspace-root`. Dependency downloads occur only during this explicit setup stage. It does not run repository lifecycle scripts, make paid requests or inherit registry credentials.

The sealed image contains Linux dependencies, the pinned baseline source and the separate harness at `/opt/vuzmi/checks/web-api-status-authority.test.ts`. Do not copy macOS `node_modules`. Setup records the resolved sealed image ID, platform, source/lockfile/harness hashes, fixed command and canonical profile hash. Directories are private owned directories; configuration and the separate empty Docker client config are 0600. Bounded diagnostics describe only public-source provisioning failures. Configuration activates only after successful image creation.

The same source and policy can provision `linux/amd64` on a dedicated Linux Docker host; its image ID/platform/profile hash will differ. This does not establish CPU-server model performance or hostile multitenant isolation.

## Execute and recover

The worker reserves the run, attempt and execution identities durably before calling the runner. Each execution has a fresh `vuzmi-dev-*` name and labels binding its execution, run, attempt, profile and invocation. A pre-existing name is uncertain work and is refused. The runner never attaches to an existing execution.

Baseline uses the exact sealed image. Candidate preparation validates the shared full-file replacement and fingerprint, then sends only the replacement plus a generated COPY-only Dockerfile as a regular-file tar context. It has no model-controlled Docker instructions, RUN, ADD, frontend, mount or command. The child image must inherit the exact sealed base layers plus one COPY layer, Linux architecture and all profile pin labels. Base ONBUILD instructions and declared volumes are rejected.

Before starting, the runner inspects effective configuration: exact image/entrypoint/argv, non-root UID/GID1000, network `none`, read-only root, no capabilities, no-new-privileges, PID128, memory/swap512MiB, CPU2,64MiB noexec/nosuid/nodev tmpfs, private IPC, init, disabled healthcheck/restarts/log storage, no host mounts/devices/sockets/published ports or secret/proxy environment. Candidate execution has no network dependency installation. The fixed command is:

```text
/usr/local/bin/node --import tsx --test /opt/vuzmi/checks/web-api-status-authority.test.ts
```

Each check process is limited to30 seconds and64KiB per output stream; preparation/inspection/cleanup also have bounded command deadlines. Cancellation, timeout, OOM, truncation, missing/duplicate tests, failed policy verification or uncertain cleanup cannot pass. The parser requires the six exact sealed test names and matching TAP counts. Baseline must fail precisely the first two tests and pass the other four; candidate must exit0 and pass all six. Early process exit0 is insufficient. Test evidence is functional evidence, not protection against a deliberately dishonest candidate forging an in-process test protocol; exact diff review remains required.

Receipts retain observed status, exit, timestamps/duration, command, image/profile/candidate identities, bounded logs and their canonical hash, policy verification and parsed tests. Cleanup removes only exactly named/labelled owned containers and candidate images, never the sealed base or unrelated resources. It is idempotent. Automatic cleanup inside a run checks its invocation nonce. Explicit recovery cleanup additionally derives run/attempt identity from the exact DB-reserved name and requires matching labels; the worker must fence ownership before invoking recovery across invocations. Failed cleanup remains unavailable and requires reconciliation. The worker must fence stale attempts before cleanup; interrupted work is never automatically accepted or regenerated. Approval only saves the exact reviewed local development package.

## Verification commands

Fixture tests use injected Docker results and a trusted temporary CLI fixture; they need no daemon:

```sh
node --import tsx --test packages/runtime/test/development-runner.test.ts
```

The explicit actual-runtime gate requires successful provisioning and fails if unavailable:

```sh
node --import tsx --test packages/runtime/test/development-runner.integration.ts
```

It exercises the real pinned baseline and corrected synthetic candidate, observes kernel UID/capability/no-new-privileges/network/cgroup controls, probes read-only/noexec and absent host resources, and checks early exit, output flooding, cancellation, OOM and wall-clock timeout. Synthetic QA patches never modify the checkout or use operator application data. The integration filename is intentionally outside the ordinary `*.test.ts` fixture/PG glob; run this gate explicitly in local release and supported Linux CI checks. Current pass/failure evidence belongs in STATUS and release records after the command completes.

A shared dedicated VM and these controls target the owned-repository private alpha. Customer code, private repository credentials, dependency changes, arbitrary commands, writable host mounts, multiple tenants, PR creation, merge and deployment require later explicit capabilities and stronger isolation gates. [Docker run controls](https://docs.docker.com/reference/cli/docker/container/run/), [build contexts](https://docs.docker.com/build/concepts/context/)

## Reusable current-source profile

Provision `web-client-regressions@1` from an explicitly selected full 40-character commit that equals the registered checkout's clean HEAD:

```sh
node --import tsx scripts/setup-development.mjs --profile web-client-regressions --commit <full-40-character-commit>
```

Tracked changes and nonignored untracked files reject preparation. Ignored private/runtime files remain excluded. This does not accept arbitrary repositories, filenames, commands or dependencies from the API or model. The fixed editable catalog contains `apps/web/src/api.ts`, `apps/web/src/draftSession.ts` and `apps/web/src/proposalReview.ts`; a candidate may replace a nonempty subset. Every before hash, returned path, final file and combined candidate fingerprint must verify. Candidate code remains data while a generated COPY-only overlay adds precisely those files as one layer over the sealed base.

The profile binds the full commit/tree, deterministic exact source-archive SHA-256, all three source texts/hashes, lockfile, platform, resolved sealed image ID, 19 exact check names, three committed fixture hashes and a separately hashed trusted wrapper. Its acceptance hash uses the shared canonical fixture/name/command/wrapper manifest. Image labels and base-layer ancestry must match. The wrapper runs the original API-session-expiry, draft-session and proposal-review fixture files as separate offline Node test processes, preserving their original imports and hook/global isolation. It validates complete child results before reporting the corresponding 19 acceptance results. Candidate-printed TAP remains captured diagnostics and cannot supply those results.

Both reusable baseline and candidate must pass all 19 named regressions. The legacy known-red baseline requirement stays unchanged. These checks establish preservation of the named behavior; they do not claim full repository validation or satisfaction of an unrelated brief. No task-specific test editing or automatic test generation is authorized by this profile. The fixed outer command is:

```text
/usr/local/bin/node --import tsx --test /opt/vuzmi/checks/web-client-regressions.test.ts
```

Before activation, provisioning runs a real fresh offline baseline; failure preserves the prior default configuration. Private immutable registry entries live at `.data/dev/development-profiles/<profileHash>/profile.json`, with `source.tar` and provisioning baseline receipts. The private runner configuration retains up to8 profiles and a default. Sealed images also receive a profile-hash tag. Provisioning never prunes old configurations or images; a full catalog fails visibly until retention is reviewed explicitly. Retain these private files with operational backups when repeatable offline execution is required. A database restore alone preserves historical package evidence but cannot reconstruct a missing image; restored work stays quarantined until exact prerequisites are available.

Readiness advertises verified available catalog entries without replacing an unavailable configured default. New admission captures an exact displayed profile hash. Production worker calls pass the run's complete pinned profile; execution must find an exact retained match, even after the default changes. Missing/mismatched entries or images fail closed. Historical packages and their approval bytes remain unchanged; profile switching never retargets an existing run.

The actual runner gate now requires legacy provisioning followed by reusable provisioning. It verifies all prior isolation/failure cases, a green 19-test baseline, a synthetic two-file candidate with 19 passing regressions, and continued execution of the retained historical profile. A synthetic comment-only QA candidate is expressly a confinement/regression probe. It is not evidence of real model task fulfillment. Actual reusable-profile results are recorded only after the clean-commit provisioning and gate complete.

Saving an approved package still changes no checkout or Git ref. The separately authorized local branch application described in architecture §26 has its own persisted plan, authority and receipt; this runner does not perform that effect.
