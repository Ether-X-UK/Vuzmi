import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const licence = "AGPL-3.0-only";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
type ReviewedSource = {
  bytes: Buffer;
  filename: string;
  revision: string;
  sha256: string;
};

function git(root: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", root, ...args],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
function clean(root: string, revision: string): boolean {
  return (
    git(root, ["rev-parse", "--verify", "HEAD"]).trim() === revision &&
    !git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ])
  );
}
async function privateDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== process.getuid!() ||
    (value.mode & 0o777) !== 0o700
  )
    throw new Error("Unavailable");
}
async function privateBytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid!() ||
      (info.mode & 0o777) !== 0o600 ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 0 ||
      info.size > limit
    )
      throw new Error("Unavailable");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead) throw new Error("Unavailable");
      offset += result.bytesRead;
    }
    if (
      (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead ||
      (await file.stat()).size !== bytes.length
    )
      throw new Error("Unavailable");
    return bytes;
  } finally {
    await file.close();
  }
}

async function reviewedSource(
  repositoryRoot: string,
): Promise<ReviewedSource | undefined> {
  try {
    const root = await realpath(repositoryRoot);
    if (
      (await realpath(git(root, ["rev-parse", "--show-toplevel"]).trim())) !==
      root
    )
      return undefined;
    const revision = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) ||
      !clean(root, revision)
    )
      return undefined;
    await privateDirectory(join(root, ".data"));
    const directory = join(root, ".data/releases");
    await privateDirectory(directory);
    const value: unknown = JSON.parse(
      (
        await privateBytes(join(directory, "source-manifest.json"), 16_384)
      ).toString("utf8"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const manifest = value as Record<string, unknown>;
    const filename = `vuzmi-source-${revision}.tar.gz`;
    if (
      manifest.format !== "vuzmi-source-v1" ||
      manifest.licence !== licence ||
      manifest.revision !== revision ||
      manifest.archive !== filename ||
      typeof manifest.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      typeof manifest.bytes !== "number" ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes <= 0 ||
      manifest.bytes > MAX_ARCHIVE_BYTES
    )
      return undefined;
    const bytes = await privateBytes(
      join(directory, filename),
      MAX_ARCHIVE_BYTES,
    );
    if (
      bytes.length !== manifest.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== manifest.sha256 ||
      !clean(root, revision)
    )
      return undefined;
    return { bytes, filename, revision, sha256: manifest.sha256 };
  } catch {
    return undefined;
  }
}

/** Public reviewed source offer. The path is fixed; fixture roots are code-injected only. */
export function registerSourceRoutes(
  app: FastifyInstance,
  options: { repositoryRoot?: string } = {},
): void {
  const root = options.repositoryRoot ?? projectRoot;
  app.get("/source/info", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    const source = await reviewedSource(root);
    return source
      ? { available: true, licence, revision: source.revision }
      : { available: false, licence };
  });
  app.get("/source", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const source = await reviewedSource(root);
    if (!source)
      return reply
        .code(404)
        .send({
          error: {
            code: "SOURCE_UNAVAILABLE",
            message:
              "A reviewed source package for this clean committed checkout is not available.",
          },
        });
    return reply
      .type("application/gzip")
      .header(
        "Content-Disposition",
        `attachment; filename="${source.filename}"`,
      )
      .header("Content-Length", source.bytes.length)
      .header("ETag", `"${source.sha256}"`)
      .send(source.bytes);
  });
}
