# Local development checks runner

This is the bounded `web-api-status-authority@1` development profile described in architecture §25. It targets Vuzmi's owned public repository at commit `a7d088e4954f848da392eed91684dfb445d5ce45`. Only `apps/web/src/api.ts` may change. It produces observed check evidence for an exact local patch package; the real checkout stays unchanged. Checks do not establish that arbitrary generated code is safe.

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

Provisioning reads reviewed Git objects at the full pinned commit, never the live working tree, environment files, operator data or model output. The commit must exist locally; shallow CI checkouts must fetch it. It exports regular tracked source, rejects symlinks/submodules/private paths, verifies the API source and lockfile, and adds the sealed acceptance harness. Public official Node22 slim is pulled anonymously for the native Linux platform and resolved to a repository digest. The trusted provisioning build installs the pinned lockfile with `npm ci --ignore-scripts --no-audit --no-fund --workspace @vuzmi/core --include-workspace-root`. Dependency downloads occur only during this explicit setup stage. It does not run repository lifecycle scripts, make paid requests or inherit registry credentials.

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
