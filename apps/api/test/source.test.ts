import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import Fastify from "fastify";
import { registerSourceRoutes } from "../src/source.js";

type PackageResult = {
  archive: string;
  manifest: string;
  revision: string;
  sha256: string;
};
const script = pathToFileURL(
  fileURLToPath(
    new URL("../../../scripts/package-source.mjs", import.meta.url),
  ),
).href;
const { packageSource } = (await import(script)) as {
  packageSource(options: { repositoryRoot: string }): Promise<PackageResult>;
};
const original = 'export const fixture = "reviewed committed source";\n';
function git(root: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-C",
      root,
      ...args,
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
function commit(root: string): void {
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=source@example.test",
    "commit",
    "-m",
    "Reviewed fixture source",
  ]);
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vuzmi-source-fixture-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, ["init"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/index.ts"), original);
  await writeFile(
    join(root, ".gitignore"),
    ".env\n.env.*\n!.env.example\n.data/\nnode_modules/\ndist/\n",
  );
  await writeFile(join(root, ".env.example"), "EXAMPLE=placeholder-only\n");
  await writeFile(
    join(root, "LICENSE"),
    await readFile(new URL("../../../LICENSE", import.meta.url)),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "source-fixture", license: "AGPL-3.0-only" }),
  );
  commit(root);
  const app = Fastify();
  registerSourceRoutes(app, { repositoryRoot: root });
  t.after(async () => app.close());
  const build = () => packageSource({ repositoryRoot: root });
  return { root, app, build };
}

test("HEAD-only source archives exclude ignored secrets/runtime/build files and are deterministic", async (t) => {
  const { root, app, build } = await fixture(t);
  await mkdir(join(root, ".data/private"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "node_modules/fixture"), { recursive: true });
  await mkdir(join(root, "dist"));
  await writeFile(join(root, ".env"), "SYNTHETIC_SECRET=never-in-source\n", {
    mode: 0o600,
  });
  await writeFile(
    join(root, ".data/private/state"),
    "Synthetic private runtime data",
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "node_modules/fixture/private"),
    "Synthetic dependency data",
  );
  await writeFile(join(root, "dist/index.js"), "Synthetic build output");
  const result = await build();
  const bytes = await readFile(result.archive);
  const manifest = await readFile(result.manifest);
  const list = execFileSync("tar", ["-tzf", result.archive], {
    encoding: "utf8",
  });
  assert.match(
    list,
    new RegExp(`vuzmi-source-${result.revision}/src/index.ts`),
  );
  assert.match(list, /\/\.env\.example/);
  assert.equal(
    list
      .split("\n")
      .some((entry) =>
        /\/(?:\.env$|\.data\/|node_modules\/|dist\/|\.git\/)/.test(entry),
      ),
    false,
  );
  assert.equal(
    execFileSync(
      "tar",
      ["-xOf", result.archive, `vuzmi-source-${result.revision}/src/index.ts`],
      { encoding: "utf8" },
    ),
    original,
  );
  assert.equal((await stat(join(root, ".data/releases"))).mode & 0o777, 0o700);
  assert.equal((await stat(result.archive)).mode & 0o777, 0o600);
  assert.equal((await stat(result.manifest)).mode & 0o777, 0o600);
  assert.deepEqual(
    [...bytes.subarray(4, 8)],
    [0, 0, 0, 0],
    "gzip must not encode wall-clock time",
  );
  const repeated = await build();
  assert.equal(repeated.sha256, result.sha256);
  assert.deepEqual(await readFile(repeated.archive), bytes);
  assert.deepEqual(await readFile(repeated.manifest), manifest);
  const download = await app.inject({
    method: "GET",
    url: "/source?path=../../.env",
  });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.equal(download.headers["content-type"], "application/gzip");
  assert.equal(
    download.headers["content-disposition"],
    `attachment; filename="vuzmi-source-${result.revision}.tar.gz"`,
  );
  assert.equal(download.headers["cache-control"], "no-store");
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  assert.equal(download.headers.etag, `"${result.sha256}"`);
  assert.deepEqual((await app.inject("/source/info")).json(), {
    available: true,
    licence: "AGPL-3.0-only",
    revision: result.revision,
  });
});

test("tracked and untracked dirty changes refuse packaging and make the source offer unavailable", async (t) => {
  const { root, app, build } = await fixture(t);
  const result = await build();
  const manifest = await readFile(result.manifest);
  await writeFile(
    join(root, "src/index.ts"),
    `${original}// Uncommitted change\n`,
  );
  await assert.rejects(build(), /clean committed checkout/);
  assert.equal((await app.inject("/source")).statusCode, 404);
  assert.deepEqual((await app.inject("/source/info")).json(), {
    available: false,
    licence: "AGPL-3.0-only",
  });
  assert.deepEqual(
    await readFile(result.manifest),
    manifest,
    "Dirty packaging cannot replace the reviewed manifest",
  );
  await writeFile(join(root, "src/index.ts"), original);
  await writeFile(join(root, "unreviewed.txt"), "Untracked source");
  await assert.rejects(build(), /clean committed checkout/);
  assert.equal((await app.inject("/source")).statusCode, 404);
  await rm(join(root, "unreviewed.txt"));
  assert.equal((await app.inject("/source")).statusCode, 200);
});

test("missing, damaged, forged, stale, symlinked and nonprivate packages never expose filesystem content", async (t) => {
  const { root, app, build } = await fixture(t);
  const missing = await app.inject("/source");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "SOURCE_UNAVAILABLE");
  assert.equal(missing.body.includes(root), false);
  const result = await build();
  const originalArchive = await readFile(result.archive);
  const originalManifest = JSON.parse(
    await readFile(result.manifest, "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    result.archive,
    Buffer.concat([originalArchive, Buffer.from("corruption")]),
  );
  assert.equal((await app.inject("/source")).statusCode, 404);
  const sameSizeCorruption = Buffer.from(originalArchive);
  sameSizeCorruption[0] = sameSizeCorruption[0]! ^ 1;
  await writeFile(result.archive, sameSizeCorruption);
  assert.equal(
    (await app.inject("/source")).statusCode,
    404,
    "A matching length cannot bypass SHA-256 verification",
  );
  await writeFile(result.archive, originalArchive);
  await writeFile(
    result.manifest,
    JSON.stringify({ ...originalManifest, archive: "../../.env" }),
  );
  assert.equal((await app.inject("/source")).statusCode, 404);
  await writeFile(
    result.manifest,
    JSON.stringify({ ...originalManifest, revision: "0".repeat(40) }),
  );
  assert.equal((await app.inject("/source")).statusCode, 404);
  await writeFile(result.manifest, JSON.stringify(originalManifest));
  await chmod(result.archive, 0o644);
  assert.equal((await app.inject("/source")).statusCode, 404);
  await chmod(result.archive, 0o600);
  await writeFile(join(root, ".env"), "SYNTHETIC_SECRET=private\n", {
    mode: 0o600,
  });
  await unlink(result.archive);
  await symlink(join(root, ".env"), result.archive);
  assert.equal((await app.inject("/source")).statusCode, 404);
  await unlink(result.archive);
  await build();
  await writeFile(
    join(root, "src/index.ts"),
    `${original}// New reviewed revision\n`,
  );
  commit(root);
  assert.equal(
    (await app.inject("/source")).statusCode,
    404,
    "Old packages cannot represent the new HEAD",
  );
  const next = await build();
  assert.notEqual(next.revision, result.revision);
  assert.equal((await app.inject("/source")).statusCode, 200);
  await rm(next.manifest);
  assert.equal((await app.inject("/source")).statusCode, 404);
});

test("a clean tree with accidentally committed private files is rejected rather than partly archived", async (t) => {
  const { root, build } = await fixture(t);
  await writeFile(join(root, ".env"), "SYNTHETIC_SECRET=tracked-by-mistake\n");
  git(root, ["add", "-f", ".env"]);
  commit(root);
  await assert.rejects(build(), /private\/runtime\/build paths/);
});

test("Git export attributes cannot silently remove or rewrite reviewed source", async (t) => {
  const { root, build } = await fixture(t);
  await writeFile(join(root, ".gitattributes"), "LICENSE export-ignore\n");
  commit(root);
  await assert.rejects(build(), /omit or rewrite committed source/);
  await rm(join(root, ".gitattributes"));
  commit(root);
  await writeFile(
    join(root, ".git/info/attributes"),
    "src/index.ts export-ignore\n",
  );
  await assert.rejects(build(), /Uncommitted Git archive attributes/);
});
