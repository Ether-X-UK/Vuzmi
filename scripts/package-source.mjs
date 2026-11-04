import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const MAX_BYTES = 64 * 1024 * 1024;
export class SourcePackageError extends Error {}
const fail = (message) => {
  throw new SourcePackageError(message);
};
const gitEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
function git(root, args) {
  try {
    return execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", root, ...args],
      {
        env: gitEnvironment(),
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    fail(
      "Git could not verify this committed source checkout. No repository details or file contents were printed.",
    );
  }
}
function clean(root, revision) {
  if (
    git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]) ||
    git(root, ["rev-parse", "--verify", "HEAD"]).trim() !== revision
  )
    fail(
      "Source packaging requires a clean committed checkout, including tracked and untracked nonignored files. Commit reviewed changes first.",
    );
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  )
    fail(
      "Source release directories must be private, owned directories with permissions 0700, without symlinks.",
    );
}
function forbidden(path) {
  return path
    .split("/")
    .some(
      (part) =>
        [
          ".git",
          ".data",
          "node_modules",
          "dist",
          "build",
          ".expo",
          "coverage",
          ".aws",
          ".ssh",
        ].includes(part) ||
        ((part === ".env" || part.startsWith(".env.")) &&
          part !== ".env.example") ||
        part.endsWith(".log") ||
        part.endsWith(".tsbuildinfo"),
    );
}

/** Archives the verified HEAD tree, never the worktree, index, ignored files or an environment-selected path. */
export async function packageSource({ repositoryRoot = projectRoot } = {}) {
  const root = realpathSync(resolve(repositoryRoot));
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
    fail("Package source from the repository root only.");
  const revision = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    fail("A committed source revision is required.");
  clean(root, revision);
  const files = git(root, ["ls-tree", "-r", "-z", "--name-only", revision])
    .split("\0")
    .filter(Boolean);
  if (files.some(forbidden))
    fail(
      "The committed tree contains private/runtime/build paths. Remove them from reviewed source before packaging.",
    );
  if (
    git(root, ["ls-tree", "-r", revision])
      .split("\n")
      .some((line) => line.startsWith("160000 "))
  )
    fail(
      "Submodule source must be incorporated through a reviewed source-package strategy before packaging.",
    );
  const localAttributes = resolve(
    root,
    git(root, ["rev-parse", "--git-path", "info/attributes"]).trim(),
  );
  if (existsSync(localAttributes) && statSync(localAttributes).size > 0)
    fail(
      "Uncommitted Git archive attributes can alter the source offer. Move reviewed attributes into committed source before packaging.",
    );
  for (const file of files.filter(
    (path) => path === ".gitattributes" || path.endsWith("/.gitattributes"),
  )) {
    if (
      git(root, ["show", `${revision}:${file}`])
        .split("\n")
        .some(
          (line) =>
            !line.trimStart().startsWith("#") &&
            /\bexport-(?:ignore|subst)\b/.test(line),
        )
    )
      fail(
        "Git export attributes can omit or rewrite committed source. Review a complete source-package strategy before packaging.",
      );
  }
  const licence = git(root, ["show", `${revision}:LICENSE`]);
  let metadata;
  try {
    metadata = JSON.parse(git(root, ["show", `${revision}:package.json`]));
  } catch {
    fail("Committed source must include valid reviewed licence metadata.");
  }
  if (
    !licence.includes("GNU AFFERO GENERAL PUBLIC LICENSE") ||
    !licence.includes("Version 3, 19 November 2007") ||
    metadata.license !== "AGPL-3.0-only"
  )
    fail(
      "Committed source must contain the reviewed AGPL-3.0-only licence and package metadata.",
    );
  // Release output must itself be ignored so packaging never creates a dirty checkout.
  try {
    execFileSync(
      "git",
      [
        "-C",
        root,
        "check-ignore",
        "--quiet",
        "--no-index",
        ".data/releases/source-manifest.json",
      ],
      { env: gitEnvironment(), stdio: "ignore" },
    );
  } catch {
    fail(
      "The private .data/releases directory must be ignored by Git before source packaging.",
    );
  }
  const dataDirectory = join(root, ".data");
  privateDirectory(dataDirectory);
  const directory = join(dataDirectory, "releases");
  privateDirectory(directory);
  const archiveName = `vuzmi-source-${revision}.tar.gz`;
  const temporary = join(directory, `.archive-${randomUUID()}.tmp`);
  const temporaryManifest = join(directory, `.manifest-${randomUUID()}.tmp`);
  let child;
  try {
    child = spawn(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-C",
        root,
        "archive",
        "--format=tar",
        `--prefix=vuzmi-source-${revision}/`,
        revision,
      ],
      { env: gitEnvironment(), stdio: ["ignore", "pipe", "ignore"] },
    );
    const finished = new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(
          new SourcePackageError(
            "The committed source archive could not be produced.",
          ),
        ),
      );
      child.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new SourcePackageError(
                "The committed source archive could not be produced.",
              ),
            ),
      );
    });
    await Promise.all([
      pipeline(
        child.stdout,
        createGzip({ level: 9 }),
        createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
      ),
      finished,
    ]);
    const bytes = statSync(temporary).size;
    if (bytes <= 0 || bytes > MAX_BYTES)
      fail("The source package exceeds the supported private download limit.");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    const manifest = {
      format: "vuzmi-source-v1",
      licence: "AGPL-3.0-only",
      revision,
      archive: archiveName,
      sha256,
      bytes,
    };
    clean(root, revision);
    renameSync(temporary, join(directory, archiveName));
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    clean(root, revision);
    renameSync(temporaryManifest, join(directory, "source-manifest.json"));
    return {
      archive: join(directory, archiveName),
      manifest: join(directory, "source-manifest.json"),
      revision,
      sha256,
    };
  } catch (error) {
    child?.kill("SIGTERM");
    if (error instanceof SourcePackageError) throw error;
    fail(
      "Source packaging failed. No private files, Git output or source contents were printed.",
    );
  } finally {
    for (const path of [temporary, temporaryManifest])
      if (existsSync(path)) rmSync(path, { force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv.length !== 2)
      fail(
        "Usage: node scripts/package-source.mjs. The repository root and private release directory are fixed.",
      );
    const result = await packageSource();
    console.info(
      `Reviewed source package ready for revision ${result.revision}; SHA-256 ${result.sha256}.`,
    );
  } catch (error) {
    console.error(
      error instanceof SourcePackageError
        ? error.message
        : "Source packaging failed; commit reviewed changes and check private directory permissions.",
    );
    process.exitCode = 1;
  }
}
