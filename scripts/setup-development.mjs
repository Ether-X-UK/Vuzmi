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
  DEVELOPMENT_REGRESSION_PATHS,
  DEVELOPMENT_REGRESSION_COMMAND,
  DEVELOPMENT_REGRESSION_CHECK_FILES,
  DEVELOPMENT_REGRESSION_CHECK_NAMES,
  developmentAcceptanceFingerprintInput,
  developmentBaselineAccepted,
  developmentProfileFingerprintInput,
  developmentProfileSchema,
} from "../packages/core/src/development.ts";
import {
  DEVELOPMENT_BASE_COMMIT,
  DEVELOPMENT_POLICY,
  executeDockerCommand,
  developmentBuildContext,
  createDevelopmentRunner,
  loadDevelopmentRunnerConfig,
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
function git(args, repository = repositoryRoot, missingOkay = false) {
  try {
    return execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-C",
        repository,
        ...args,
      ],
      {
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_PROTOCOL_FROM_USER: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (error) {
    if (missingOkay && error?.status === 1) return Buffer.alloc(0);
    throw genericFailure();
  }
}
/** Export exact regular Git blobs/modes; archive attributes and worktree filters never run. */
export function exportDevelopmentSnapshot({
  repository = repositoryRoot,
  commit,
  requireClean = false,
}) {
  if (
    git(
      [
        "config",
        "--name-only",
        "--get-regexp",
        "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$",
      ],
      repository,
      true,
    ).length
  )
    throw new Error(
      "Development snapshots require complete local Git objects; partial/promisor repositories are not supported.",
    );
  if (
    !/^[a-f0-9]{40}$/.test(commit ?? "") ||
    git(["rev-parse", "--verify", `${commit}^{commit}`], repository)
      .toString("utf8")
      .trim() !== commit
  )
    throw genericFailure();
  if (
    requireClean &&
    (git(["rev-parse", "HEAD"], repository).toString("utf8").trim() !==
      commit ||
      git(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        repository,
      ).length)
  )
    throw new Error(
      "Reusable profiles require the explicitly selected full commit to equal a clean HEAD, including nonignored untracked files.",
    );
  const sourceTree = git(["rev-parse", `${commit}^{tree}`], repository)
    .toString("utf8")
    .trim();
  if (!/^[a-f0-9]{40}$/.test(sourceTree)) throw genericFailure();
  const entries = git(
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    repository,
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!entries.length || entries.length > 2000) throw genericFailure();
  const files = new Map();
  let total = 0;
  const records = entries.map((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw genericFailure();
    const path = match[3];
    if (
      path.startsWith("/") ||
      path
        .split("/")
        .some(
          (part) =>
            part === ".." ||
            [".git", ".data", "node_modules", ".ssh", ".aws"].includes(part) ||
            ((part === ".env" || part.startsWith(".env.")) &&
              part !== ".env.example"),
        )
    )
      throw genericFailure();
    const content = git(["cat-file", "blob", match[2]], repository);
    total += content.length;
    if (total > 32 * 1024 * 1024) throw genericFailure();
    files.set(path, content);
    return { path, content, mode: match[1] === "100755" ? 0o755 : 0o644 };
  });
  return { sourceTree, archive: developmentBuildContext(records), files };
}
const text = (value) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
/** Provision reviewed Git objects only. Never starts/installs a VM or reads the operator's environment files. */
export async function setupDevelopment({
  dockerHost,
  dockerBinary,
  platform,
  profileId = "web-api-status-authority",
  commit,
  repository = repositoryRoot,
  stateRoot,
} = {}) {
  if (
    !["web-api-status-authority", "web-client-regressions"].includes(
      profileId,
    ) ||
    (profileId === "web-api-status-authority" && commit !== undefined)
  )
    throw genericFailure();
  const reusable = profileId === "web-client-regressions";
  const baseCommit = reusable ? commit : DEVELOPMENT_BASE_COMMIT;
  const privateRoot = stateRoot ?? join(repositoryRoot, ".data/dev");
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
  const snapshot = exportDevelopmentSnapshot({
    repository,
    commit: baseCommit,
    requireClean: reusable,
  });
  const paths = reusable ? DEVELOPMENT_REGRESSION_PATHS : [DEVELOPMENT_PATH];
  const sources = paths.map((path) => {
    const bytes = snapshot.files.get(path);
    if (!bytes) throw genericFailure();
    return { path, text: text(bytes), sha256: sha256(bytes) };
  });
  const lockfile = snapshot.files.get("package-lock.json");
  if (!lockfile) throw genericFailure();
  const lockfileHash = sha256(lockfile);
  const harnessName = reusable
    ? "web-client-regressions.test.ts"
    : "web-api-status-authority.test.ts";
  const harness = readFileSync(
    join(repositoryRoot, "scripts/checks", harnessName),
  );
  const command = [
    ...(reusable ? DEVELOPMENT_REGRESSION_COMMAND : DEVELOPMENT_COMMAND),
  ];
  const checkFiles = reusable
    ? DEVELOPMENT_REGRESSION_CHECK_FILES.map((path) => {
        const bytes = snapshot.files.get(path);
        if (!bytes) throw genericFailure();
        return { path, sha256: sha256(bytes) };
      })
    : undefined;
  const extensions = reusable
    ? {
        sourceTree: snapshot.sourceTree,
        sourceArchiveSha256: sha256(snapshot.archive),
        checkFiles,
        checkNames: [...DEVELOPMENT_REGRESSION_CHECK_NAMES],
        baselineExpectation: "green",
        checkHarnessSha256: sha256(harness),
      }
    : {};
  const acceptanceHash = reusable
    ? sha256(developmentAcceptanceFingerprintInput({ ...extensions, command }))
    : sha256(harness);
  const context = mkdtempSync(join(privateRoot, "development-provision-"));
  chmodSync(context, 0o700);
  try {
    const archive = snapshot.archive;
    const sourceContext = join(context, "source");
    mkdirSync(sourceContext, { mode: 0o700 });
    execFileSync("tar", ["-xf", "-", "-C", sourceContext], {
      input: archive,
      stdio: ["pipe", "ignore", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    if (
      sources.some(
        (source) =>
          sha256(readFileSync(join(sourceContext, source.path))) !==
          source.sha256,
      ) ||
      sha256(readFileSync(join(sourceContext, "package-lock.json"))) !==
        lockfileHash
    )
      throw genericFailure();
    if (reusable)
      writeFileSync(
        join(context, "vuzmi-regressions-manifest.json"),
        JSON.stringify({ names: DEVELOPMENT_REGRESSION_CHECK_NAMES }),
        { mode: 0o644 },
      );
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
      "COPY source/ /opt/vuzmi/repository/",
      "RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @vuzmi/core --include-workspace-root",
      `COPY vuzmi-check-harness.ts /opt/vuzmi/checks/${harnessName}`,
      ...(reusable
        ? [
            "COPY vuzmi-regressions-manifest.json /opt/vuzmi/checks/regressions-manifest.json",
          ]
        : []),
      `LABEL io.vuzmi.development.acceptance=\"${acceptanceHash}\" io.vuzmi.development.lockfile=\"${lockfileHash}\" io.vuzmi.development.base=\"${baseCommit}\" io.vuzmi.development.policy=\"${DEVELOPMENT_POLICY}\"`,
      ...(reusable
        ? [
            `LABEL io.vuzmi.development.tree="${snapshot.sourceTree}" io.vuzmi.development.archive="${sha256(snapshot.archive)}"`,
          ]
        : []),
      "USER 1000:1000",
      "",
    ].join("\n");
    writeFileSync(join(context, "VuzmiChecks.Dockerfile"), dockerfile, {
      mode: 0o600,
    });
    const tag = `vuzmi-development-checks:${profileId}-${baseCommit.slice(0, 12)}-${acceptanceHash.slice(0, 12)}-${selectedPlatform.split("/")[1]}`;
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
      id: profileId,
      version: 1,
      repository: "Ether-X-UK/Vuzmi",
      baseCommit,
      files: sources,
      command,
      acceptanceHash,
      lockfileHash,
      baseImage: image.Id,
      platform: selectedPlatform,
      policyId: DEVELOPMENT_POLICY,
      ...extensions,
    };
    const profile = developmentProfileSchema.parse({
      ...unsigned,
      profileHash: sha256(developmentProfileFingerprintInput(unsigned)),
    });
    const destination = join(privateRoot, "development-runner.json"),
      temporary = `${destination}.${randomUUID()}.tmp`;
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink())
      throw genericFailure();
    const previous = existsSync(destination)
      ? loadDevelopmentRunnerConfig(destination)
      : undefined;
    const profiles = [
      ...(previous?.profiles ?? (previous ? [previous.profile] : [])),
    ];
    const same = profiles.find(
      (value) => value.profileHash === profile.profileHash,
    );
    if (same && JSON.stringify(same) !== JSON.stringify(profile))
      throw genericFailure();
    if (!same) profiles.push(profile);
    if (profiles.length > 8)
      throw new Error(
        "The retained profile catalog is full. Review retention explicitly; provisioning never removes profiles or images automatically.",
      );
    const configuration = { version: 1, ...connection, profile, profiles };
    const serialized = JSON.stringify(configuration, null, 2) + "\n";
    if (Buffer.byteLength(serialized) > 256 * 1024)
      throw new Error(
        "The retained profile catalog exceeds its private configuration byte bound. Review retention explicitly.",
      );
    writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
    try {
      let baseline;
      if (reusable) {
        console.log(
          "Verifying all nineteen immutable regressions in a fresh offline baseline before activation.",
        );
        const runId = randomUUID(),
          attemptId = randomUUID();
        baseline = await createDevelopmentRunner({ configPath: temporary }).run(
          {
            runId,
            attemptId,
            executionId: `vuzmi-dev-${runId}-${attemptId}-baseline`,
            phase: "baseline",
            profile,
          },
        );
        if (!developmentBaselineAccepted(baseline, profile))
          throw new Error(
            "The reusable profile baseline did not produce all nineteen required passing results. The prior active configuration remains unchanged.",
          );
      }
      const registry = join(privateRoot, "development-profiles");
      privateDirectory(registry);
      const immutableFile = (path, content) => {
        if (existsSync(path)) {
          const info = lstatSync(path);
          if (
            info.isSymbolicLink() ||
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            info.mode & 0o077 ||
            !readFileSync(path).equals(Buffer.from(content))
          )
            throw genericFailure();
        } else writeFileSync(path, content, { mode: 0o600, flag: "wx" });
      };
      for (const retained of profiles) {
        const directory = join(registry, retained.profileHash);
        privateDirectory(directory);
        immutableFile(
          join(directory, "profile.json"),
          JSON.stringify(retained, null, 2) + "\n",
        );
      }
      const retained = join(registry, profile.profileHash);
      immutableFile(join(retained, "source.tar"), snapshot.archive);
      if (baseline)
        immutableFile(
          join(retained, `baseline-${baseline.executionId}.json`),
          JSON.stringify(baseline, null, 2) + "\n",
        );
      await docker([
        "image",
        "tag",
        profile.baseImage,
        `vuzmi-development-profile:${profile.profileHash}`,
      ]);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
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
  try {
    const args = process.argv.slice(2),
      options = {};
    if (args.length) {
      if (
        args.length !== 4 ||
        args[0] !== "--profile" ||
        args[1] !== "web-client-regressions" ||
        args[2] !== "--commit" ||
        !/^[a-f0-9]{40}$/.test(args[3])
      )
        throw new Error(
          "Use --profile web-client-regressions --commit FULL40 for a clean current commit, or no arguments for the frozen legacy profile.",
        );
      options.profileId = args[1];
      options.commit = args[3];
    }
    await setupDevelopment(options);
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^(?:Use --profile|Reusable profiles require|The retained profile catalog|The reusable profile baseline)/.test(
          error.message,
        )
        ? error.message
        : genericFailure().message,
    );
    process.exitCode = 1;
  }
}
