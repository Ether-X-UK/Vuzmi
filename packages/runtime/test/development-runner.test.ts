import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEVELOPMENT_CHECK_NAMES,
  DEVELOPMENT_COMMAND,
  developmentBaselineReproduced,
  developmentCheckLogsInput,
  developmentProfileFingerprintInput,
  validateDevelopmentCandidate,
  type DevelopmentProfile,
} from "@vuzmi/core";
import {
  DEVELOPMENT_BASE_COMMIT,
  DEVELOPMENT_LABEL,
  DEVELOPMENT_MEMORY,
  DEVELOPMENT_TMPFS,
  createDevelopmentRunner,
  developmentBuildContext,
  executeDockerCommand,
  parseDevelopmentTap,
  verifyDevelopmentContainer,
  type DockerCommandResult,
  type DockerExecutor,
} from "../src/development-runner.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const image = `sha256:${"a".repeat(64)}`,
  childImage = `sha256:${"b".repeat(64)}`;
function profile(): DevelopmentProfile {
  const text =
    "export async function request() { return 'baseline fixture'; }\n";
  const unsigned: Omit<DevelopmentProfile, "profileHash"> = {
    id: "web-api-status-authority",
    version: 1,
    repository: "Ether-X-UK/Vuzmi",
    baseCommit: DEVELOPMENT_BASE_COMMIT,
    files: [{ path: "apps/web/src/api.ts", text, sha256: hash(text) }],
    command: [...DEVELOPMENT_COMMAND],
    acceptanceHash: "c".repeat(64),
    lockfileHash: "d".repeat(64),
    baseImage: image,
    platform: "linux/arm64",
    policyId: "owned-repository-offline-v1",
  };
  return {
    ...unsigned,
    profileHash: hash(developmentProfileFingerprintInput(unsigned)),
  };
}
function tap(pass = true) {
  return [
    "TAP version 13",
    ...DEVELOPMENT_CHECK_NAMES.map(
      (name, i) => `${pass || i >= 2 ? "ok" : "not ok"} ${i + 1} - ${name}`,
    ),
    "1..6",
    "# tests 6",
    "# suites 0",
    `# pass ${pass ? 6 : 4}`,
    `# fail ${pass ? 0 : 2}`,
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "",
  ].join("\n");
}
const candidateExecution = (input: { runId: string; attemptId: string }) => ({
  ...input,
  phase: "candidate" as const,
  executionId: `vuzmi-dev-${input.runId}-${input.attemptId}-candidate`,
});
const result = (
  stdout = "",
  exitCode = 0,
  stderr = "",
): DockerCommandResult => ({
  stdout,
  stderr,
  exitCode,
  timedOut: false,
  aborted: false,
  truncated: false,
});

function fixture(
  t: test.TestContext,
  settings: {
    badPolicy?: boolean;
    badTap?: boolean;
    cleanupFails?: boolean;
    collision?: boolean;
    timeout?: boolean;
    badAncestry?: boolean;
    onCleanup?: () => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "vuzmi-runner-unit-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const p = profile(),
    configPath = join(directory, "development-runner.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      dockerBinary: "/fixture/docker",
      dockerHost: "unix:///fixture/vuzmi.sock",
      dockerConfig: directory,
      profile: p,
    }),
    { mode: 0o600 },
  );
  const calls: string[][] = [];
  let container: any, child: any;
  const execute: DockerExecutor = async (_connection, args, options) => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") {
      if (args[2] === image)
        return result(
          JSON.stringify([
            {
              Id: image,
              Os: "linux",
              Architecture: "arm64",
              RootFS: { Layers: [image] },
              Config: {
                Labels: {
                  "io.vuzmi.development.acceptance": p.acceptanceHash,
                  "io.vuzmi.development.lockfile": p.lockfileHash,
                  "io.vuzmi.development.base": p.baseCommit,
                  "io.vuzmi.development.policy": p.policyId,
                },
              },
            },
          ]),
        );
      return child
        ? result(JSON.stringify([child]))
        : result("", 1, "Error: No such image");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (settings.collision && !container)
        return result(
          JSON.stringify([
            {
              Name: `/${args[2]}`,
              Config: { Labels: { [DEVELOPMENT_LABEL]: args[2] } },
            },
          ]),
        );
      return container
        ? result(JSON.stringify([container]))
        : result("", 1, "Error: No such container");
    }
    if (args[0] === "build") {
      assert.ok(
        options.input?.includes(
          Buffer.from("COPY --chown=1000:1000 candidate.ts"),
        ),
      );
      assert.ok(!options.input?.includes(Buffer.from("\nRUN ")));
      const id = args[args.indexOf("--tag") + 1].replace(":candidate", "");
      const invocation = /io\.vuzmi\.development\.invocation="([^"]+)"/.exec(
        options.input!.toString(),
      )![1];
      child = {
        Id: childImage,
        Os: "linux",
        Architecture: "arm64",
        RootFS: {
          Layers: [settings.badAncestry ? childImage : image, childImage],
        },
        Config: {
          Labels: {
            [DEVELOPMENT_LABEL]: id,
            "io.vuzmi.development.invocation": invocation,
            "io.vuzmi.development.run":
              /io\.vuzmi\.development\.run="([^"]+)"/.exec(
                options.input!.toString(),
              )![1],
            "io.vuzmi.development.attempt":
              /io\.vuzmi\.development\.attempt="([^"]+)"/.exec(
                options.input!.toString(),
              )![1],
            "io.vuzmi.development.profile": p.profileHash,
            "io.vuzmi.development.acceptance": p.acceptanceHash,
            "io.vuzmi.development.lockfile": p.lockfileHash,
            "io.vuzmi.development.base": p.baseCommit,
            "io.vuzmi.development.policy": p.policyId,
          },
        },
      };
      return result("built trusted COPY-only context");
    }
    if (args[0] === "create") {
      const value = (key: string) => args[args.indexOf(key) + 1];
      const labels = Object.fromEntries(
        args.flatMap((arg, i) =>
          arg === "--label"
            ? [[args[i + 1].split("=")[0], args[i + 1].split("=")[1]]]
            : [],
        ),
      );
      const id = value("--name"),
        selected = args.find(
          (value) => value === image || value === childImage,
        )!;
      container = {
        Name: `/${id}`,
        Image: selected,
        Mounts: [],
        Config: {
          Image: selected,
          User: "1000:1000",
          Entrypoint: [DEVELOPMENT_COMMAND[0]],
          Cmd: DEVELOPMENT_COMMAND.slice(1),
          WorkingDir: "/opt/vuzmi/repository",
          Labels: labels,
          Env: ["PATH=/usr/local/bin"],
          Healthcheck: { Test: ["NONE"] },
        },
        HostConfig: {
          NetworkMode: settings.badPolicy ? "default" : "none",
          Privileged: false,
          ReadonlyRootfs: true,
          PidsLimit: 128,
          Memory: DEVELOPMENT_MEMORY,
          MemorySwap: DEVELOPMENT_MEMORY,
          NanoCpus: 2_000_000_000,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PublishAllPorts: false,
          IpcMode: "none",
          Tmpfs: { "/tmp": DEVELOPMENT_TMPFS },
          LogConfig: { Type: "none" },
          RestartPolicy: { Name: "no" },
          Init: true,
        },
        State: {
          StartedAt: "0001-01-01T00:00:00Z",
          Running: false,
          ExitCode: 0,
          OOMKilled: false,
        },
      };
      return result("fixture-container-id");
    }
    if (args[0] === "start") {
      const passed = container.Image === childImage;
      container.State = {
        StartedAt: new Date().toISOString(),
        Running: !!settings.timeout,
        ExitCode: passed ? 0 : 1,
        OOMKilled: false,
      };
      return {
        ...result(
          settings.badTap ? "TAP version 13\n1..0\n# tests 0\n" : tap(passed),
          passed ? 0 : 1,
        ),
        timedOut: !!settings.timeout,
      };
    }
    if (args[0] === "container" && args[1] === "rm") {
      settings.onCleanup?.();
      if (settings.cleanupFails) return result("", 1, "fixture failure");
      container = undefined;
      return result();
    }
    if (args[0] === "image" && args[1] === "rm") {
      child = undefined;
      return result();
    }
    throw new Error("Unexpected fixture Docker command");
  };
  const runner = createDevelopmentRunner({ configPath, execute });
  const runId = randomUUID(),
    attemptId = randomUUID();
  const input = {
    runId,
    attemptId,
    executionId: `vuzmi-dev-${runId}-${attemptId}-baseline`,
    phase: "baseline" as const,
  };
  return { p, runner, input, calls, configPath };
}

test("baseline reproduces exactly the two status-authority failures and removes its owned container", async (t) => {
  const { runner, input, calls } = fixture(t);
  assert.equal((await runner.readiness()).ready, true);
  const check = await runner.run(input);
  assert.equal(check.status, "failed");
  assert.equal(developmentBaselineReproduced(check), true);
  assert.equal(check.logsSha256, hash(developmentCheckLogsInput(check)));
  assert.ok(calls.some((args) => args[0] === "container" && args[1] === "rm"));
});

test("candidate creates a COPY-only child, pins all effective controls and requires six passing tests", async (t) => {
  const { runner, input, p, calls } = fixture(t);
  const candidate = validateDevelopmentCandidate(
    {
      summary: "Repair the status-authority fixture code.",
      files: [
        {
          path: p.files[0].path,
          beforeSha256: p.files[0].sha256,
          content: p.files[0].text.replace("baseline", "candidate"),
        },
      ],
    },
    p,
    hash,
  );
  const check = await runner.run({ ...candidateExecution(input), candidate });
  assert.equal(check.status, "passed");
  assert.equal(check.imageId, childImage);
  assert.equal(check.tests.length, 6);
  const create = calls.find((args) => args[0] === "create")!;
  assert.ok(
    create.includes("--pull=never") &&
      create.includes("--network=none") &&
      create.includes("--security-opt=no-new-privileges"),
  );
  assert.equal(
    calls.filter((args) => args[0] === "image" && args[1] === "rm").length,
    1,
  );
});

test("missing policy never starts the candidate and incomplete TAP cannot pass", async (t) => {
  const first = fixture(t, { badPolicy: true });
  assert.equal((await first.runner.run(first.input)).status, "unavailable");
  assert.ok(!first.calls.some((args) => args[0] === "start"));
  const second = fixture(t, { badTap: true });
  assert.equal((await second.runner.run(second.input)).tests.length, 0);
});

test("a reserved name collision is never attached to or removed by a duplicate invocation", async (t) => {
  const { runner, input, calls } = fixture(t, { collision: true });
  assert.equal((await runner.run(input)).status, "unavailable");
  assert.equal(await runner.cleanup(input.executionId), false);
  assert.ok(!calls.some((args) => args[0] === "start" || args[1] === "rm"));
});

test("wrong image ancestry blocks creation and cancellation during cleanup cannot settle as passed", async (t) => {
  const altered = fixture(t, { badAncestry: true });
  const make = (p: DevelopmentProfile) =>
    validateDevelopmentCandidate(
      {
        summary: "Repair the fixture status-authority implementation.",
        files: [
          {
            path: p.files[0].path,
            beforeSha256: p.files[0].sha256,
            content: p.files[0].text.replace("baseline", "candidate"),
          },
        ],
      },
      p,
      hash,
    );
  assert.equal(
    (
      await altered.runner.run({
        ...candidateExecution(altered.input),
        candidate: make(altered.p),
      })
    ).status,
    "unavailable",
  );
  assert.ok(!altered.calls.some((args) => args[0] === "create"));
  const controller = new AbortController();
  const cancelled = fixture(t, { onCleanup: () => controller.abort() });
  assert.equal(
    (
      await cancelled.runner.run({
        ...candidateExecution(cancelled.input),
        candidate: make(cancelled.p),
        signal: controller.signal,
      })
    ).status,
    "cancelled",
  );
});

test("timeout and failed cleanup remain nonpassing, and pre-aborted work creates nothing", async (t) => {
  const timeout = fixture(t, { timeout: true });
  assert.equal((await timeout.runner.run(timeout.input)).status, "timed_out");
  const cleanup = fixture(t, { cleanupFails: true });
  assert.equal((await cleanup.runner.run(cleanup.input)).status, "unavailable");
  const aborted = fixture(t);
  assert.equal(
    (
      await aborted.runner.run({
        ...aborted.input,
        signal: AbortSignal.abort(),
      })
    ).status,
    "cancelled",
  );
  assert.ok(!aborted.calls.some((args) => args[0] === "create"));
});

test("profile corruption and broad Docker client configuration fail closed", async (t) => {
  const { runner, configPath } = fixture(t);
  const other = profile();
  other.profileHash = "f".repeat(64);
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      dockerBinary: "/fixture/docker",
      dockerHost: "unix:///fixture.sock",
      dockerConfig: join(configPath, ".."),
      profile: other,
    }),
  );
  assert.equal((await runner.readiness()).ready, false);
});

test("TAP validation rejects omitted, duplicate, renamed, extra and skipped checks", () => {
  assert.equal(parseDevelopmentTap(tap())?.length, 6);
  for (const invalid of [
    tap().replace("# skipped 0", "# skipped 1"),
    tap().replace("# tests 6", "# tests 5"),
    tap() + `ok 7 - extra\n`,
    tap().replace(DEVELOPMENT_CHECK_NAMES[0], "forged name"),
    tap().replace("1..6", "1..5"),
    tap() + `# pass 6\n`,
  ])
    assert.equal(parseDevelopmentTap(invalid), undefined);
});

test("build context contains only regular bounded paths", () => {
  assert.throws(() =>
    developmentBuildContext([{ path: "../escape", content: "fixture" }]),
  );
  const context = developmentBuildContext([
    { path: "candidate.ts", content: "export const value = 1;" },
  ]);
  assert.equal(context[156], "0".charCodeAt(0));
  assert.equal(context.length % 512, 0);
});

test("real Docker transport excludes inherited secrets and bounds timeout/output without a shell", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vuzmi-runner-transport-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, "fixture-docker");
  writeFileSync(
    binary,
    `#!${process.execPath}\nif(process.argv.includes('flood'))process.stdout.write('x'.repeat(100000));else if(process.argv.includes('stall'))setInterval(()=>{},1000);else process.stdout.write(JSON.stringify(Object.keys(process.env)));\n`,
    { mode: 0o700 },
  );
  const connection = {
    dockerBinary: binary,
    dockerHost: "unix:///fixture.sock",
    dockerConfig: directory,
  };
  const options = { timeoutMs: 1000, maxBytes: 2048 };
  const env = await executeDockerCommand(connection, ["environment"], options);
  assert.equal(env.exitCode, 0);
  assert.deepEqual(
    JSON.parse(env.stdout)
      .filter((key: string) => key !== "__CF_USER_TEXT_ENCODING")
      .sort(),
    ["DOCKER_BUILDKIT", "DOCKER_CONFIG", "DOCKER_HOST", "LANG", "PATH"].sort(),
  );
  assert.equal(
    (await executeDockerCommand(connection, ["flood"], options)).truncated,
    true,
  );
  assert.equal(
    (
      await executeDockerCommand(connection, ["stall"], {
        ...options,
        timeoutMs: 50,
      })
    ).timedOut,
    true,
  );
});
