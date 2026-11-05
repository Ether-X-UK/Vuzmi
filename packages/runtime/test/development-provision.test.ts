import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL(
  "../../../scripts/setup-development.mjs",
  import.meta.url,
).href;
async function fixture(t: test.TestContext) {
  const repository = mkdtempSync(join(tmpdir(), "vuzmi-profile-source-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Vuzmi fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        repository,
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
  git(["init", "--quiet"]);
  writeFileSync(
    join(repository, ".gitattributes"),
    "tracked.txt export-ignore\nsubstitute.txt export-subst\n",
  );
  writeFileSync(join(repository, ".gitignore"), ".env\n");
  writeFileSync(join(repository, "tracked.txt"), "Exact committed bytes\n");
  writeFileSync(join(repository, "substitute.txt"), "$Format:%H$\n");
  writeFileSync(join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(repository, "executable.sh"), 0o755);
  writeFileSync(join(repository, "binary.dat"), Buffer.from([0, 255, 13, 10]));
  writeFileSync(
    join(repository, ".env"),
    "Ignored private fixture, never exported\n",
  );
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "Owned source fixture"]);
  const commit = git(["rev-parse", "HEAD"]).trim();
  const { exportDevelopmentSnapshot } = await import(script);
  return {
    repository,
    commit,
    git,
    snapshot: (value = commit, requireClean = true) =>
      exportDevelopmentSnapshot({ repository, commit: value, requireClean }),
  };
}

test("source snapshots preserve exact Git blobs/modes despite export attributes and exclude ignored runtime data", async (t) => {
  const { snapshot, git, commit } = await fixture(t);
  const first = snapshot();
  assert.equal(first.sourceTree, git(["rev-parse", `${commit}^{tree}`]).trim());
  assert.equal(
    first.files.get("tracked.txt").toString(),
    "Exact committed bytes\n",
  );
  assert.equal(first.files.get("substitute.txt").toString(), "$Format:%H$\n");
  assert.deepEqual(
    first.files.get("binary.dat"),
    Buffer.from([0, 255, 13, 10]),
  );
  assert.equal(first.files.has(".env"), false);
  assert.deepEqual(first.archive, snapshot().archive);
  assert.equal(
    execFileSync("tar", ["-xOf", "-", "substitute.txt"], {
      input: first.archive,
    }).toString(),
    "$Format:%H$\n",
  );
  const entries = execFileSync("tar", ["-tvf", "-"], {
    input: first.archive,
  }).toString();
  assert.match(entries, /-rwxr-xr-x[^\n]*executable\.sh/);
});

test("reusable snapshot preparation rejects dirty, untracked and non-current source", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.repository, "untracked.ts"),
    "export const value = 1;\n",
  );
  assert.throws(() => f.snapshot(), /clean HEAD/);
  rmSync(join(f.repository, "untracked.ts"));
  writeFileSync(join(f.repository, "tracked.txt"), "Modified worktree\n");
  assert.throws(() => f.snapshot(), /clean HEAD/);
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "Changed fixture"]);
  assert.throws(() => f.snapshot(), /clean HEAD/);
});

test("snapshot identity ignores replacement refs and rejects symbolic/private tracked entries", async (t) => {
  const f = await fixture(t);
  writeFileSync(
    join(f.repository, "tracked.txt"),
    "Replacement commit bytes\n",
  );
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "Replacement fixture"]);
  f.git(["replace", f.commit, f.git(["rev-parse", "HEAD"]).trim()]);
  assert.equal(
    f.snapshot(f.commit, false).files.get("tracked.txt").toString(),
    "Exact committed bytes\n",
  );
  symlinkSync("tracked.txt", join(f.repository, "link.txt"));
  f.git(["add", "."]);
  f.git(["commit", "--quiet", "-m", "Symlink fixture"]);
  assert.throws(() => f.snapshot(f.git(["rev-parse", "HEAD"]).trim()));
  rmSync(join(f.repository, "link.txt"));
  f.git(["add", "-A"]);
  f.git(["add", "--force", ".env"]);
  f.git(["commit", "--quiet", "-m", "Private path fixture"]);
  assert.throws(() => f.snapshot(f.git(["rev-parse", "HEAD"]).trim()));
});

test("promisor objects cannot lazy-fetch or execute a repository SSH command", async (t) => {
  const f = await fixture(t);
  const trap = join(f.repository, ".git", "ssh-trap");
  const marker = join(f.repository, ".git", "unexpected-host-execution");
  writeFileSync(trap, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, {
    mode: 0o700,
  });
  const blob = f.git(["rev-parse", `${f.commit}:tracked.txt`]).trim();
  f.git(["config", "extensions.partialClone", "origin"]);
  f.git(["config", "remote.origin.promisor", "true"]);
  f.git([
    "config",
    "remote.origin.url",
    "ssh://fixture@example.invalid/never-contact",
  ]);
  f.git(["config", "core.sshCommand", trap]);
  rmSync(join(f.repository, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  assert.throws(() => f.snapshot(f.commit, false), /partial\/promisor/);
  assert.equal(existsSync(marker), false);
});
