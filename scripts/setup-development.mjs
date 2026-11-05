import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_PATH,
  developmentProfileFingerprintInput,
  developmentProfileSchema,
} from "../packages/core/src/development.ts";
import {
  DEVELOPMENT_BASE_COMMIT,
  DEVELOPMENT_POLICY,
  executeDockerCommand,
} from "../packages/runtime/src/development-runner.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const genericFailure = () =>
  new Error(
    "Development checks provisioning failed. No configuration was activated; inspect the runtime prerequisites and retry. No private content was printed.",
  );
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw genericFailure();
}
function git(args) {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", repositoryRoot, ...args],
    {
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}
/** Provision reviewed Git objects only. Never starts/installs a VM or reads the operator's environment files. */
export async function setupDevelopment({
  dockerHost,
  dockerBinary,
  platform,
} = {}) {
  const privateRoot = join(repositoryRoot, ".data/dev");
  privateDirectory(privateRoot);
  const dockerConfig = join(privateRoot, "development-docker-cli");
  privateDirectory(dockerConfig);
  const configFile = join(dockerConfig, "config.json");
  if (existsSync(configFile)) {
    const info = lstatSync(configFile);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 1024 ||
      Object.keys(JSON.parse(readFileSync(configFile, "utf8"))).length
    )
      throw genericFailure();
  } else writeFileSync(configFile, "{}\n", { mode: 0o600, flag: "wx" });
  const connection = {
    dockerHost:
      dockerHost ??
      (process.platform === "darwin"
        ? `unix://${join(homedir(), ".colima/vuzmi/docker.sock")}`
        : "unix:///var/run/docker.sock"),
    dockerBinary:
      dockerBinary ??
      [
        "/opt/homebrew/bin/docker",
        "/usr/local/bin/docker",
        "/usr/bin/docker",
      ].find(existsSync),
    dockerConfig,
  };
  if (
    !connection.dockerBinary ||
    !/^unix:\/\/\/[^\u0000\r\n]+$/.test(connection.dockerHost)
  )
    throw genericFailure();
  const selectedPlatform =
    platform ??
    (process.arch === "arm64"
      ? "linux/arm64"
      : process.arch === "x64"
        ? "linux/amd64"
        : undefined);
  if (!selectedPlatform) throw genericFailure();
  async function docker(args, timeoutMs = 15000) {
    const result = await executeDockerCommand(connection, args, {
      timeoutMs,
      maxBytes: 512 * 1024,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.truncated
    ) {
      console.error(
        `Trusted provisioning ${args[0]} failed (exit ${result.exitCode ?? "unknown"}; timeout ${result.timedOut}; truncated ${result.truncated}).`,
      );
      // These processes receive an empty Docker credential configuration and
      // public reviewed source only. Keep diagnostics bounded; never print the
      // operator environment, private configuration or command-line arguments.
      console.error(
        (result.stderr + "\n" + result.stdout)
          .slice(-6000)
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""),
      );
      throw genericFailure();
    }
    return result.stdout;
  }
  const server = (
    await docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])
  ).trim();
  if (server !== selectedPlatform) throw genericFailure();
  const source = git([
    "show",
    `${DEVELOPMENT_BASE_COMMIT}:${DEVELOPMENT_PATH}`,
  ]).toString("utf8");
  const lockfile = git([
    "show",
    `${DEVELOPMENT_BASE_COMMIT}:package-lock.json`,
  ]);
  const harness = readFileSync(
    join(repositoryRoot, "scripts/checks/web-api-status-authority.test.ts"),
  );
  const acceptanceHash = sha256(harness),
    lockfileHash = sha256(lockfile);
  const tree = git(["ls-tree", "-r", "--name-only", DEVELOPMENT_BASE_COMMIT])
    .toString("utf8")
    .trim()
    .split("\n");
  if (
    tree.some(
      (path) =>
        path.startsWith("/") ||
        path.split("/").includes("..") ||
        path
          .split("/")
          .some(
            (part) =>
              [".git", ".data", "node_modules", ".ssh", ".aws"].includes(
                part,
              ) ||
              ((part === ".env" || part.startsWith(".env.")) &&
                part !== ".env.example"),
          ),
    )
  )
    throw genericFailure();
  if (
    git(["ls-tree", "-r", DEVELOPMENT_BASE_COMMIT])
      .toString("utf8")
      .split("\n")
      .some((line) => /^(?:120000|160000) /.test(line))
  )
    throw genericFailure();
  const context = mkdtempSync(join(privateRoot, "development-provision-"));
  chmodSync(context, 0o700);
  try {
    const archive = git(["archive", "--format=tar", DEVELOPMENT_BASE_COMMIT]);
    execFileSync("tar", ["-xf", "-", "-C", context], {
      input: archive,
      stdio: ["pipe", "ignore", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    if (
      sha256(readFileSync(join(context, DEVELOPMENT_PATH))) !==
        sha256(source) ||
      sha256(readFileSync(join(context, "package-lock.json"))) !== lockfileHash
    )
      throw genericFailure();
    writeFileSync(join(context, "vuzmi-check-harness.ts"), harness, {
      mode: 0o600,
    });
    // Git extraction creates ordinary readable source; this separate check must
    // also be readable by the unprivileged final container user.
    chmodSync(join(context, "vuzmi-check-harness.ts"), 0o644);
    writeFileSync(join(context, ".dockerignore"), "", { mode: 0o600 });
    console.log(
      "Provisioning public Node 22 Linux image using the dedicated Docker connection.",
    );
    await docker(
      [
        "pull",
        "--platform",
        selectedPlatform,
        "docker.io/library/node:22-bookworm-slim",
      ],
      120000,
    );
    const upstream = JSON.parse(
      await docker([
        "image",
        "inspect",
        "docker.io/library/node:22-bookworm-slim",
      ]),
    )[0];
    const upstreamDigest = upstream?.RepoDigests?.find((value) =>
      /^(?:docker\.io\/library\/)?node@sha256:[a-f0-9]{64}$/.test(value),
    );
    if (
      !upstreamDigest ||
      upstream.Os !== "linux" ||
      `linux/${upstream.Architecture}` !== selectedPlatform ||
      upstream.Config?.OnBuild?.length ||
      Object.keys(upstream.Config?.Volumes ?? {}).length
    )
      throw genericFailure();
    const dockerfile = [
      `FROM ${upstreamDigest}`,
      "WORKDIR /opt/vuzmi/repository",
      "COPY . /opt/vuzmi/repository",
      "RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @vuzmi/core --include-workspace-root",
      "COPY vuzmi-check-harness.ts /opt/vuzmi/checks/web-api-status-authority.test.ts",
      `LABEL io.vuzmi.development.acceptance=\"${acceptanceHash}\" io.vuzmi.development.lockfile=\"${lockfileHash}\" io.vuzmi.development.base=\"${DEVELOPMENT_BASE_COMMIT}\" io.vuzmi.development.policy=\"${DEVELOPMENT_POLICY}\"`,
      "USER 1000:1000",
      "",
    ].join("\n");
    writeFileSync(join(context, "VuzmiChecks.Dockerfile"), dockerfile, {
      mode: 0o600,
    });
    const tag = `vuzmi-development-checks:${acceptanceHash.slice(0, 16)}-${selectedPlatform.split("/")[1]}`;
    console.log(
      "Installing pinned reviewed dependencies with lifecycle scripts disabled; candidate execution remains offline.",
    );
    await docker(
      [
        "build",
        "--pull=false",
        "--network=default",
        "--file",
        join(context, "VuzmiChecks.Dockerfile"),
        "--tag",
        tag,
        context,
      ],
      240000,
    );
    const image = JSON.parse(await docker(["image", "inspect", tag]))[0];
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image?.Id ?? "") ||
      image.Config?.OnBuild?.length ||
      Object.keys(image.Config?.Volumes ?? {}).length
    )
      throw genericFailure();
    const unsigned = {
      id: "web-api-status-authority",
      version: 1,
      repository: "Ether-X-UK/Vuzmi",
      baseCommit: DEVELOPMENT_BASE_COMMIT,
      files: [{ path: DEVELOPMENT_PATH, sha256: sha256(source), text: source }],
      command: [...DEVELOPMENT_COMMAND],
      acceptanceHash,
      lockfileHash,
      baseImage: image.Id,
      platform: selectedPlatform,
      policyId: DEVELOPMENT_POLICY,
    };
    const profile = developmentProfileSchema.parse({
      ...unsigned,
      profileHash: sha256(developmentProfileFingerprintInput(unsigned)),
    });
    const destination = join(privateRoot, "development-runner.json"),
      temporary = `${destination}.${randomUUID()}.tmp`;
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink())
      throw genericFailure();
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, ...connection, profile }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, destination);
    console.log(
      `Development profile provisioned for ${selectedPlatform}; private configuration saved. Isolated baseline/candidate verification is a separate gate.`,
    );
    return { profile, configPath: destination };
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv.length !== 2) {
    console.error(
      "Run node --import tsx scripts/setup-development.mjs with the documented dedicated local Docker VM already running.",
    );
    process.exitCode = 1;
  } else {
    try {
      await setupDevelopment();
    } catch {
      console.error(genericFailure().message);
      process.exitCode = 1;
    }
  }
}
