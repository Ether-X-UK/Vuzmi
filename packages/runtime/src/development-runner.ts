import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEVELOPMENT_CHECK_NAMES,
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_PATH,
  developmentCheckLogsInput,
  developmentCheckSchema,
  developmentProfileFingerprintInput,
  developmentProfileSchema,
  validateDevelopmentCandidate,
  type CheckReceipt,
  type DevelopmentCandidate,
  type DevelopmentProfile,
} from "@vuzmi/core";

export const DEVELOPMENT_BASE_COMMIT =
  "a7d088e4954f848da392eed91684dfb445d5ce45";
export const DEVELOPMENT_POLICY = "owned-repository-offline-v1";
export const DEVELOPMENT_LABEL = "io.vuzmi.development.execution";
export const DEVELOPMENT_MEMORY = 512 * 1024 * 1024;
export const DEVELOPMENT_TMPFS =
  "rw,noexec,nosuid,nodev,size=67108864,mode=1777";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const defaultConfigPath = join(root, ".data/dev/development-runner.json");
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const imageId = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const executionId = (value: string) =>
  /^vuzmi-dev-[a-z0-9-]{1,140}$/.test(value);
function executionOwner(
  value: string,
): { runId: string; attemptId: string } | undefined {
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const match = new RegExp(
    `^vuzmi-dev-(${uuid})-(${uuid})-(?:baseline|candidate)$`,
  ).exec(value);
  return match ? { runId: match[1], attemptId: match[2] } : undefined;
}

export interface DockerConnection {
  dockerBinary: string;
  dockerHost: string;
  dockerConfig: string;
}
export interface DevelopmentRunnerConfig extends DockerConnection {
  version: 1;
  profile: DevelopmentProfile;
}
export interface DockerCommandOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  input?: Buffer;
}
export interface DockerCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}
export type DockerExecutor = (
  connection: DockerConnection,
  args: readonly string[],
  options: DockerCommandOptions,
) => Promise<DockerCommandResult>;
export interface DevelopmentRunner {
  readiness(): Promise<{
    ready: boolean;
    reason: string;
    profile?: DevelopmentProfile;
  }>;
  run(input: {
    runId: string;
    attemptId: string;
    phase: "baseline" | "candidate";
    executionId: string;
    candidate?: DevelopmentCandidate;
    signal?: AbortSignal;
  }): Promise<CheckReceipt>;
  cleanup(executionId: string): Promise<boolean>;
}
export class DevelopmentRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DevelopmentRunnerError";
  }
}

/** No shell, inherited environment, registry credentials, daemon discovery or host execution. */
export const executeDockerCommand: DockerExecutor = async (
  connection,
  args,
  options,
) => {
  if (options.signal?.aborted)
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      aborted: true,
      truncated: false,
    };
  return new Promise((resolve) => {
    const child = spawn(
      connection.dockerBinary,
      [
        "--host",
        connection.dockerHost,
        "--config",
        connection.dockerConfig,
        ...args,
      ],
      {
        env: {
          PATH: `${dirname(connection.dockerBinary)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
          DOCKER_HOST: connection.dockerHost,
          DOCKER_CONFIG: connection.dockerConfig,
          // The fixed COPY-only Dockerfile uses the local engine's builder. No
          // buildx plugin, remote frontend, or builder credential discovery.
          DOCKER_BUILDKIT: "0",
          LANG: "C.UTF-8",
        },
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0);
    let timedOut = false,
      aborted = false,
      truncated = false,
      finished = false;
    const stop = () => child.kill("SIGKILL");
    const abort = () => {
      aborted = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    function append(chunk: Buffer, channel: "stdout" | "stderr") {
      const previous = channel === "stdout" ? stdout : stderr;
      const room = options.maxBytes - previous.length;
      if (chunk.length > room) {
        truncated = true;
        stop();
      }
      const value = Buffer.concat([
        previous,
        chunk.subarray(0, Math.max(0, room)),
      ]);
      if (channel === "stdout") stdout = value;
      else stderr = value;
    }
    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
    function complete(exitCode: number | null, unavailable = false) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: unavailable
          ? "The Docker client could not be started."
          : stderr.toString("utf8"),
        timedOut,
        aborted,
        truncated,
      });
    }
    child.on("error", () => complete(null, true));
    child.on("close", (code) => complete(code));
    if (options.signal?.aborted) abort();
  });
};

function privatePath(path: string, directory: boolean) {
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new DevelopmentRunnerError(
      "RUNNER_CONFIGURATION",
      "Development runner configuration must use private owned files and directories.",
    );
  return info;
}
export function loadDevelopmentRunnerConfig(
  path = defaultConfigPath,
): DevelopmentRunnerConfig {
  privatePath(dirname(path), true);
  if (privatePath(path, false).size > 256 * 1024)
    throw new Error("Bounded runner configuration required.");
  const raw = JSON.parse(readFileSync(path, "utf8")) as DevelopmentRunnerConfig;
  if (
    raw.version !== 1 ||
    !isAbsolute(raw.dockerBinary ?? "") ||
    !/^unix:\/\/\/[^\u0000\r\n]+$/.test(raw.dockerHost ?? "") ||
    !isAbsolute(raw.dockerConfig ?? "")
  )
    throw new Error("An explicit local Docker connection is required.");
  privatePath(raw.dockerConfig, true);
  const dockerConfigFile = join(raw.dockerConfig, "config.json");
  if (existsSync(dockerConfigFile)) {
    if (
      privatePath(dockerConfigFile, false).size > 1024 ||
      Object.keys(JSON.parse(readFileSync(dockerConfigFile, "utf8"))).length !==
        0
    )
      throw new Error(
        "The runner Docker configuration must not contain credentials or client settings.",
      );
  }
  const profile = developmentProfileSchema.parse(raw.profile);
  if (
    profile.baseCommit !== DEVELOPMENT_BASE_COMMIT ||
    sha256(developmentProfileFingerprintInput(profile)) !==
      profile.profileHash ||
    sha256(profile.files[0].text) !== profile.files[0].sha256
  )
    throw new Error("The pinned development profile could not be verified.");
  return {
    version: 1,
    dockerBinary: raw.dockerBinary,
    dockerHost: raw.dockerHost,
    dockerConfig: raw.dockerConfig,
    profile,
  };
}

/** Minimal regular-file ustar context. Candidate code is copied as bytes, never evaluated on the host. */
export function developmentBuildContext(
  files: ReadonlyArray<{ path: string; content: string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(file.path) ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..") ||
      Buffer.byteLength(file.path) > 100
    )
      throw new Error("Unsafe build-context path.");
    const content = Buffer.from(file.content, "utf8"),
      header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8");
    const octal = (value: number, offset: number, size: number) =>
      header.write(
        value.toString(8).padStart(size - 1, "0") + "\0",
        offset,
        size,
        "ascii",
      );
    octal(0o644, 100, 8);
    octal(1000, 108, 8);
    octal(1000, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const sum = [...header].reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

/** Strict top-level TAP records and summary; extra/duplicate/missing tests cannot pass. */
export function parseDevelopmentTap(
  stdout: string,
): Array<{ name: string; passed: boolean }> | undefined {
  const lines = stdout.split(/\r?\n/);
  if (
    !lines.includes("TAP version 13") ||
    lines.filter((line) => /^1\.\./.test(line)).length !== 1 ||
    !lines.includes(`1..${DEVELOPMENT_CHECK_NAMES.length}`)
  )
    return undefined;
  const results = lines.flatMap((line) => {
    const match = /^(not ok|ok) ([1-9][0-9]*) - (.+)$/.exec(line);
    return match
      ? [{ index: Number(match[2]), name: match[3], passed: match[1] === "ok" }]
      : [];
  });
  if (
    results.length !== DEVELOPMENT_CHECK_NAMES.length ||
    results.some(
      (result, i) =>
        result.index !== i + 1 || result.name !== DEVELOPMENT_CHECK_NAMES[i],
    )
  )
    return undefined;
  const passed = results.filter((result) => result.passed).length;
  for (const [key, value] of Object.entries({
    tests: 6,
    pass: passed,
    fail: 6 - passed,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  }))
    if (
      lines.filter((line) => line.startsWith(`# ${key} `)).length !== 1 ||
      !lines.includes(`# ${key} ${value}`)
    )
      return undefined;
  return results.map(({ name, passed }) => ({ name, passed }));
}

function parseSingle(result: DockerCommandResult): any {
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.truncated
  )
    throw new Error("The Docker resource could not be verified.");
  const parsed: unknown = JSON.parse(result.stdout);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !parsed[0] ||
    typeof parsed[0] !== "object"
  )
    throw new Error("Expected one Docker resource.");
  return parsed[0];
}
function verifyBase(image: any, profile: DevelopmentProfile) {
  if (
    image.Id !== profile.baseImage ||
    image.Os !== "linux" ||
    `linux/${image.Architecture}` !== profile.platform ||
    image.Config?.OnBuild?.length ||
    Object.keys(image.Config?.Volumes ?? {}).length ||
    image.Config?.Labels?.["io.vuzmi.development.acceptance"] !==
      profile.acceptanceHash ||
    image.Config?.Labels?.["io.vuzmi.development.lockfile"] !==
      profile.lockfileHash ||
    image.Config?.Labels?.["io.vuzmi.development.base"] !==
      profile.baseCommit ||
    image.Config?.Labels?.["io.vuzmi.development.policy"] !== profile.policyId
  )
    throw new Error(
      "The sealed local checks image does not match the pinned profile.",
    );
}
function equal(value: unknown, expected: unknown) {
  return JSON.stringify(value) === JSON.stringify(expected);
}
export function verifyDevelopmentContainer(
  container: any,
  input: {
    id: string;
    runId: string;
    attemptId: string;
    image: string;
    profile: DevelopmentProfile;
  },
) {
  const h = container.HostConfig,
    c = container.Config;
  if (
    container.Name !== `/${input.id}` ||
    container.Image !== input.image ||
    c?.Image !== input.image ||
    c?.User !== "1000:1000" ||
    !equal(c?.Entrypoint, [DEVELOPMENT_COMMAND[0]]) ||
    !equal(c?.Cmd, DEVELOPMENT_COMMAND.slice(1)) ||
    c?.WorkingDir !== "/opt/vuzmi/repository" ||
    c?.Labels?.[DEVELOPMENT_LABEL] !== input.id ||
    c?.Labels?.["io.vuzmi.development.run"] !== input.runId ||
    c?.Labels?.["io.vuzmi.development.attempt"] !== input.attemptId ||
    c?.Labels?.["io.vuzmi.development.profile"] !== input.profile.profileHash ||
    h?.NetworkMode !== "none" ||
    h?.Privileged !== false ||
    h?.ReadonlyRootfs !== true ||
    h?.PidsLimit !== 128 ||
    h?.Memory !== DEVELOPMENT_MEMORY ||
    h?.MemorySwap !== DEVELOPMENT_MEMORY ||
    h?.NanoCpus !== 2_000_000_000 ||
    !equal(h?.CapDrop, ["ALL"]) ||
    (h?.CapAdd?.length ?? 0) !== 0 ||
    !h?.SecurityOpt?.includes("no-new-privileges") ||
    h?.SecurityOpt?.length !== 1 ||
    (h?.Binds?.length ?? 0) !== 0 ||
    (h?.VolumesFrom?.length ?? 0) !== 0 ||
    (container.Mounts?.length ?? 0) !== 0 ||
    Object.keys(c?.Volumes ?? {}).length !== 0 ||
    (h?.Devices?.length ?? 0) !== 0 ||
    (h?.DeviceRequests?.length ?? 0) !== 0 ||
    Object.keys(h?.PortBindings ?? {}).length !== 0 ||
    h?.PublishAllPorts !== false ||
    h?.PidMode ||
    h?.UTSMode ||
    h?.IpcMode !== "none" ||
    !equal(h?.Tmpfs, { "/tmp": DEVELOPMENT_TMPFS }) ||
    h?.LogConfig?.Type !== "none" ||
    c?.Healthcheck?.Test?.[0] !== "NONE" ||
    h?.RestartPolicy?.Name !== "no" ||
    h?.Init !== true ||
    c?.Env?.some((entry: string) =>
      /^(?:NODE_OPTIONS|NODE_PATH|DOCKER_HOST|DOCKER_CONFIG|SSH_AUTH_SOCK|.*(?:TOKEN|SECRET|PASSWORD|API_KEY)|(?:HTTP|HTTPS|ALL)_PROXY)=/i.test(
        entry,
      ),
    )
  )
    throw new Error(
      "The container did not enforce the complete offline execution policy.",
    );
}

export function createDevelopmentRunner(
  options: { configPath?: string; execute?: DockerExecutor } = {},
): DevelopmentRunner {
  const configPath = options.configPath ?? defaultConfigPath;
  const execute = options.execute ?? executeDockerCommand;
  async function command(
    connection: DockerConnection,
    args: readonly string[],
    settings: Partial<DockerCommandOptions> = {},
  ) {
    const deadline = settings.timeoutMs ?? 4000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    settings.signal?.addEventListener("abort", abort, { once: true });
    if (settings.signal?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        execute(connection, args, {
          timeoutMs: deadline,
          maxBytes: 65536,
          ...settings,
          signal: controller.signal,
        }),
        new Promise<DockerCommandResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({
              exitCode: null,
              stdout: "",
              stderr: "The isolated runner command exceeded its deadline.",
              timedOut: true,
              aborted: !!settings.signal?.aborted,
              truncated: false,
            });
          }, deadline + 100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      settings.signal?.removeEventListener("abort", abort);
    }
  }
  async function cleanupWith(
    config: DevelopmentRunnerConfig,
    id: string,
    invocation?: string,
  ): Promise<boolean> {
    const owner = executionOwner(id);
    if (!executionId(id) || !owner) return false;
    const owned = (labels: Record<string, string> | undefined) =>
      labels?.[DEVELOPMENT_LABEL] === id &&
      labels?.["io.vuzmi.development.run"] === owner.runId &&
      labels?.["io.vuzmi.development.attempt"] === owner.attemptId &&
      /^[a-f0-9]{64}$/.test(labels?.["io.vuzmi.development.profile"] ?? "") &&
      (!invocation ||
        labels?.["io.vuzmi.development.invocation"] === invocation);
    let success = true;
    const inspect = await command(config, ["container", "inspect", id]);
    if (inspect.exitCode === 0) {
      try {
        const container = parseSingle(inspect);
        if (container.Name !== `/${id}` || !owned(container.Config?.Labels))
          return false;
        const removed = await command(config, [
          "container",
          "rm",
          "--force",
          id,
        ]);
        success = removed.exitCode === 0 && !removed.timedOut;
      } catch {
        return false;
      }
    } else if (
      inspect.timedOut ||
      inspect.aborted ||
      inspect.exitCode === null ||
      !/No such (?:object|container)/i.test(inspect.stderr)
    )
      success = false;
    const tag = `${id}:candidate`;
    const image = await command(config, ["image", "inspect", tag]);
    if (image.exitCode === 0) {
      try {
        const parsed = parseSingle(image);
        if (
          !owned(parsed.Config?.Labels) ||
          parsed.Id === config.profile.baseImage
        )
          return false;
        const removed = await command(config, ["image", "rm", parsed.Id]);
        success = removed.exitCode === 0 && !removed.timedOut && success;
      } catch {
        return false;
      }
    } else if (
      image.timedOut ||
      image.aborted ||
      image.exitCode === null ||
      !/No such (?:object|image)/i.test(image.stderr)
    )
      success = false;
    return success;
  }
  return {
    async readiness() {
      let config: DevelopmentRunnerConfig;
      try {
        config = loadDevelopmentRunnerConfig(configPath);
      } catch {
        return {
          ready: false,
          reason:
            "Provision the private development checks profile with the documented setup command.",
        };
      }
      try {
        verifyBase(
          parseSingle(
            await command(config, [
              "image",
              "inspect",
              config.profile.baseImage,
            ]),
          ),
          config.profile,
        );
        return {
          ready: true,
          reason: "The pinned local isolated checks image is available.",
          profile: config.profile,
        };
      } catch {
        return {
          ready: false,
          reason:
            "The dedicated Docker VM or pinned local checks image is unavailable; no host fallback is permitted.",
          profile: config.profile,
        };
      }
    },
    async cleanup(id) {
      try {
        return await cleanupWith(loadDevelopmentRunnerConfig(configPath), id);
      } catch {
        return false;
      }
    },
    async run(input) {
      const config = loadDevelopmentRunnerConfig(configPath),
        profile = config.profile;
      if (
        !executionOwner(input.executionId) ||
        input.executionId !==
          `vuzmi-dev-${input.runId}-${input.attemptId}-${input.phase}`
      )
        throw new DevelopmentRunnerError(
          "RUNNER_INPUT",
          "Reserve valid execution and attempt identities before running checks.",
        );
      if (input.phase === "candidate") {
        if (!input.candidate)
          throw new DevelopmentRunnerError(
            "RUNNER_INPUT",
            "A validated candidate is required.",
          );
        const candidate = validateDevelopmentCandidate(
          {
            summary: input.candidate.summary,
            files: input.candidate.files.map(
              ({ afterSha256: _, ...file }) => file,
            ),
          },
          profile,
          sha256,
        );
        if (!equal(candidate, input.candidate))
          throw new DevelopmentRunnerError(
            "RUNNER_INPUT",
            "The candidate fingerprint could not be verified.",
          );
      } else if (input.candidate)
        throw new DevelopmentRunnerError(
          "RUNNER_INPUT",
          "Baseline checks cannot include a candidate.",
        );
      const began = Date.now(),
        invocation = randomUUID();
      let ownsEffects = false;
      let selectedImage = profile.baseImage,
        started = false,
        policyVerified = false;
      let exitCode: number | null = null,
        status: CheckReceipt["status"] = "unavailable",
        stdout = "",
        stderr = "",
        truncated = false;
      let tests: CheckReceipt["tests"] = [];
      try {
        if (input.signal?.aborted) {
          status = "cancelled";
          throw new Error("aborted");
        }
        const base = parseSingle(
          await command(config, ["image", "inspect", profile.baseImage], {
            signal: input.signal,
          }),
        );
        verifyBase(base, profile);
        // Refuse to attach/reuse a resource from an uncertain prior attempt.
        const existing = await command(
          config,
          ["container", "inspect", input.executionId],
          { signal: input.signal },
        );
        if (
          existing.exitCode === 0 ||
          existing.exitCode === null ||
          existing.timedOut ||
          !/No such (?:object|container)/i.test(existing.stderr)
        )
          throw new Error("reserved name already exists or cannot be verified");
        if (input.phase === "candidate") {
          const tag = `${input.executionId}:candidate`;
          const priorImage = await command(config, ["image", "inspect", tag], {
            signal: input.signal,
          });
          if (
            priorImage.exitCode === 0 ||
            priorImage.exitCode === null ||
            priorImage.timedOut ||
            !/No such (?:object|image)/i.test(priorImage.stderr)
          )
            throw new Error(
              "reserved image already exists or cannot be verified",
            );
          const dockerfile = [
            `FROM ${profile.baseImage}`,
            `COPY --chown=1000:1000 candidate.ts /opt/vuzmi/repository/${DEVELOPMENT_PATH}`,
            `LABEL ${DEVELOPMENT_LABEL}="${input.executionId}" io.vuzmi.development.invocation="${invocation}" io.vuzmi.development.run="${input.runId}" io.vuzmi.development.attempt="${input.attemptId}" io.vuzmi.development.profile="${profile.profileHash}"`,
            "",
          ].join("\n");
          ownsEffects = true;
          const built = await command(
            config,
            ["build", "--pull=false", "--network=none", "--tag", tag, "-"],
            {
              signal: input.signal,
              timeoutMs: 20000,
              input: developmentBuildContext([
                { path: "Dockerfile", content: dockerfile },
                {
                  path: "candidate.ts",
                  content: input.candidate!.files[0].content,
                },
              ]),
            },
          );
          if (
            built.exitCode !== 0 ||
            built.timedOut ||
            built.aborted ||
            built.truncated
          )
            throw new Error("candidate image unavailable");
          const child = parseSingle(
            await command(config, ["image", "inspect", tag], {
              signal: input.signal,
            }),
          );
          const baseLayers: unknown = base.RootFS?.Layers,
            childLayers: unknown = child.RootFS?.Layers;
          if (
            !imageId(child.Id) ||
            child.Config?.Labels?.[DEVELOPMENT_LABEL] !== input.executionId ||
            child.Config?.Labels?.["io.vuzmi.development.invocation"] !==
              invocation ||
            child.Config?.Labels?.["io.vuzmi.development.run"] !==
              input.runId ||
            child.Config?.Labels?.["io.vuzmi.development.attempt"] !==
              input.attemptId ||
            child.Config?.Labels?.["io.vuzmi.development.profile"] !==
              profile.profileHash ||
            child.Os !== base.Os ||
            child.Architecture !== base.Architecture ||
            child.Config?.OnBuild?.length ||
            Object.keys(child.Config?.Volumes ?? {}).length ||
            !Array.isArray(baseLayers) ||
            !Array.isArray(childLayers) ||
            childLayers.length !== baseLayers.length + 1 ||
            baseLayers.some(
              (layer, i) => !imageId(layer) || layer !== childLayers[i],
            ) ||
            !imageId(childLayers.at(-1)) ||
            [
              "io.vuzmi.development.acceptance",
              "io.vuzmi.development.lockfile",
              "io.vuzmi.development.base",
              "io.vuzmi.development.policy",
            ].some(
              (label) =>
                child.Config?.Labels?.[label] !== base.Config?.Labels?.[label],
            )
          )
            throw new Error("candidate image identity mismatch");
          selectedImage = child.Id;
        }
        ownsEffects = true;
        const created = await command(
          config,
          [
            "create",
            "--name",
            input.executionId,
            "--pull=never",
            "--platform",
            profile.platform,
            "--label",
            `${DEVELOPMENT_LABEL}=${input.executionId}`,
            "--label",
            `io.vuzmi.development.run=${input.runId}`,
            "--label",
            `io.vuzmi.development.attempt=${input.attemptId}`,
            "--label",
            `io.vuzmi.development.profile=${profile.profileHash}`,
            "--label",
            `io.vuzmi.development.invocation=${invocation}`,
            "--network=none",
            "--user=1000:1000",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=128",
            `--memory=${DEVELOPMENT_MEMORY}`,
            `--memory-swap=${DEVELOPMENT_MEMORY}`,
            "--cpus=2",
            "--tmpfs",
            `/tmp:${DEVELOPMENT_TMPFS}`,
            "--ipc=none",
            "--init",
            "--log-driver=none",
            "--no-healthcheck",
            "--restart=no",
            "--workdir=/opt/vuzmi/repository",
            "--entrypoint",
            profile.command[0],
            selectedImage,
            ...profile.command.slice(1),
          ],
          { signal: input.signal },
        );
        if (created.exitCode !== 0 || created.timedOut || created.aborted)
          throw new Error("create failed");
        verifyDevelopmentContainer(
          parseSingle(
            await command(config, ["container", "inspect", input.executionId], {
              signal: input.signal,
            }),
          ),
          {
            id: input.executionId,
            runId: input.runId,
            attemptId: input.attemptId,
            image: selectedImage,
            profile,
          },
        );
        policyVerified = true;
        if (input.signal?.aborted) {
          status = "cancelled";
          throw new Error("aborted");
        }
        const result = await command(
          config,
          ["start", "--attach", input.executionId],
          { signal: input.signal, timeoutMs: 30000 },
        );
        stdout = result.stdout;
        stderr = result.stderr;
        truncated = result.truncated;
        if (result.timedOut) status = "timed_out";
        if (result.aborted) status = "cancelled";
        const final = parseSingle(
          await command(config, ["container", "inspect", input.executionId]),
        );
        started =
          !!final.State?.StartedAt &&
          !final.State.StartedAt.startsWith("0001-");
        if (
          final.State?.Running ||
          !started ||
          !Number.isInteger(final.State?.ExitCode)
        ) {
          status =
            input.signal?.aborted || result.aborted
              ? "cancelled"
              : result.timedOut
                ? "timed_out"
                : "unavailable";
        } else {
          exitCode = final.State.ExitCode;
          tests = parseDevelopmentTap(stdout) ?? [];
          status =
            input.signal?.aborted || result.aborted
              ? "cancelled"
              : result.timedOut
                ? "timed_out"
                : final.State.OOMKilled
                  ? "oom_killed"
                  : exitCode === 0 &&
                      result.exitCode === 0 &&
                      !truncated &&
                      tests.length === 6 &&
                      tests.every((test) => test.passed)
                    ? "passed"
                    : "failed";
        }
      } catch {
        if (input.signal?.aborted) status = "cancelled";
        if (!stderr)
          stderr =
            status === "cancelled"
              ? "Isolated checks were cancelled."
              : "The isolated checks could not be completed or their policy/evidence could not be verified.";
      } finally {
        if (
          ownsEffects &&
          !(await cleanupWith(config, input.executionId, invocation))
        ) {
          status = input.signal?.aborted ? "cancelled" : "unavailable";
          stderr +=
            "\nOwned runner resources could not be confirmed removed; reconciliation is required.";
        }
      }
      if (input.signal?.aborted) status = "cancelled";
      const logs = {
        stdout,
        stderr: stderr.slice(0, 65536),
        truncated: truncated || stderr.length > 65536,
      };
      return developmentCheckSchema.parse({
        executionId: input.executionId,
        phase: input.phase,
        startedAt: new Date(began).toISOString(),
        finishedAt: new Date().toISOString(),
        imageId: selectedImage,
        baseImageId: profile.baseImage,
        profileHash: profile.profileHash,
        candidateFingerprint: input.candidate?.fingerprint ?? null,
        status,
        started,
        exitCode,
        durationMs: Date.now() - began,
        ...logs,
        logsSha256: sha256(developmentCheckLogsInput(logs)),
        command: profile.command,
        policyVerified,
        tests,
      });
    },
  };
}
