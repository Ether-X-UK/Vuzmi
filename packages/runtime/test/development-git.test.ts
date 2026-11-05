import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createDevelopmentApplicationPlan,
  createDevelopmentApplication,
  developmentProfileFingerprintInput,
} from "@vuzmi/core";
import { createDevelopmentGitConnector } from "../src/development-git.js";
import {
  applicationGitFixture,
  applicationActor,
  gitFixtureCommand,
  approvedApplicationFixture,
} from "./application-fixtures.js";
import { digest } from "./development-fixtures.js";
async function fixture(t: TestContext) {
  const value = await applicationGitFixture();
  t.after(value.cleanup);
  const connector = createDevelopmentGitConnector({
      repositoryPath: value.directory,
    }),
    ready = await connector.readiness();
  assert.equal(ready.ready, true);
  const plan = createDevelopmentApplicationPlan(
    value.run,
    ready.repositoryIdentity!,
    digest,
  );
  const operation = createDevelopmentApplication(
    plan,
    {
      requestId: randomUUID(),
      packageSha256: plan.packageSha256,
      planFingerprint: plan.fingerprint,
    },
    {
      id: randomUUID(),
      actor: applicationActor,
      now: "2026-11-05T21:00:00.000Z",
      hash: digest,
    },
  );
  return { ...value, connector, operation };
}
test("Git application preserves dirty checkout/index, writes only reviewed tree entries, and deterministically replays", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "apps/web/src/api.ts"),
    "Owner's dirty work remains untouched.\n",
  );
  await writeFile(
    join(f.directory, "untracked.txt"),
    "Private untracked fixture.\n",
  );
  const before = await f.snapshot(),
    prepared = await f.connector.prepare(f.operation, f.run),
    again = await f.connector.prepare(f.operation, f.run);
  assert.deepEqual(prepared, again);
  const operation = { ...f.operation, prepared };
  await Promise.all([
    f.connector.apply(operation),
    f.connector.apply(operation),
  ]);
  assert.equal(await f.connector.inspect(operation), "applied");
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(
    await readFile(join(f.directory, "untracked.txt"), "utf8"),
    "Private untracked fixture.\n",
  );
  assert.equal(
    gitFixtureCommand(f.directory, [
      "show",
      `${prepared.commitOid}:apps/web/src/api.ts`,
    ]),
    f.run.candidate!.files[0].content,
  );
  assert.equal(
    gitFixtureCommand(f.directory, [
      "rev-parse",
      `${prepared.commitOid}^`,
    ]).trim(),
    f.profile.baseCommit,
  );
  assert.deepEqual(
    gitFixtureCommand(f.directory, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      f.profile.baseCommit,
      prepared.commitOid,
    ])
      .trim()
      .split("\n"),
    ["apps/web/src/api.ts"],
  );
});
test("Git application disables hooks/filters/signing and preserves occupied and symbolic branches", async (t) => {
  const f = await fixture(t),
    trap = join(f.directory, "trap-ran"),
    hooks = join(f.directory, ".git/hooks");
  await mkdir(hooks, { recursive: true });
  const script = `#!/bin/sh\ntouch '${trap}'\nexit 1\n`;
  for (const name of [
    "reference-transaction",
    "post-index-change",
    "pre-commit",
    "post-commit",
  ]) {
    const path = join(hooks, name);
    await writeFile(path, script);
    await chmod(path, 0o700);
  }
  gitFixtureCommand(f.directory, ["config", "core.hooksPath", hooks]);
  gitFixtureCommand(f.directory, [
    "config",
    "filter.fixture.clean",
    `touch '${trap}'`,
  ]);
  await writeFile(join(f.directory, ".gitattributes"), "*.ts filter=fixture\n");
  gitFixtureCommand(f.directory, ["config", "commit.gpgSign", "true"]);
  const prepared = await f.connector.prepare(f.operation, f.run),
    operation = { ...f.operation, prepared };
  gitFixtureCommand(f.directory, [
    "update-ref",
    operation.plan.destinationRef,
    f.profile.baseCommit,
  ]);
  await assert.rejects(f.connector.apply(operation), {
    code: "APPLICATION_BRANCH_CONFLICT",
  });
  assert.equal(
    gitFixtureCommand(f.directory, [
      "rev-parse",
      operation.plan.destinationRef,
    ]).trim(),
    f.profile.baseCommit,
  );
  gitFixtureCommand(f.directory, [
    "update-ref",
    "-d",
    operation.plan.destinationRef,
  ]);
  gitFixtureCommand(f.directory, [
    "symbolic-ref",
    operation.plan.destinationRef,
    "refs/heads/main",
  ]);
  await assert.rejects(f.connector.apply(operation), {
    code: "APPLICATION_BRANCH_CONFLICT",
  });
  await assert.rejects(readFile(trap), { code: "ENOENT" });
});
test("Git connector rejects repository grafts before any application effect", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, ".git/info/grafts"),
    "# Unsupported graft fixture\n",
  );
  assert.equal((await f.connector.readiness()).ready, false);
  await assert.rejects(f.connector.prepare(f.operation, f.run), {
    code: "APPLICATION_REPOSITORY_UNAVAILABLE",
  });
});

test("Git application rejects a checked-out unborn destination and prepared trees with extra changes", async (t) => {
  const f = await fixture(t),
    prepared = await f.connector.prepare(f.operation, f.run),
    operation = { ...f.operation, prepared };
  const attached = join(f.directory, "attached-fixture");
  gitFixtureCommand(f.directory, [
    "worktree",
    "add",
    "--detach",
    attached,
    f.profile.baseCommit,
  ]);
  gitFixtureCommand(attached, [
    "symbolic-ref",
    "HEAD",
    operation.plan.destinationRef,
  ]);
  await assert.rejects(f.connector.apply(operation), {
    code: "APPLICATION_BRANCH_CONFLICT",
  });
  gitFixtureCommand(attached, [
    "symbolic-ref",
    "HEAD",
    "refs/heads/unborn-fixture",
  ]);
  await writeFile(
    join(f.directory, "outside.txt"),
    "An unauthorized extra tree entry.\n",
  );
  gitFixtureCommand(f.directory, ["add", "outside.txt"]);
  gitFixtureCommand(f.directory, ["commit", "-m", "Synthetic foreign tree"]);
  const treeOid = gitFixtureCommand(f.directory, [
      "rev-parse",
      "HEAD^{tree}",
    ]).trim(),
    original = gitFixtureCommand(f.directory, [
      "cat-file",
      "commit",
      prepared.commitOid,
    ]);
  const raw = original.replace(
      `tree ${prepared.treeOid}\n`,
      `tree ${treeOid}\n`,
    ),
    commitOid = gitFixtureCommand(
      f.directory,
      ["hash-object", "-t", "commit", "-w", "--stdin", "--no-filters"],
      raw,
    ).trim();
  await assert.rejects(
    f.connector.apply({
      ...operation,
      prepared: { ...prepared, treeOid, commitOid },
    }),
    { code: "APPLICATION_TREE_CHANGED" },
  );
});
test("Git connector rejects changed registration and symlink replacement targets", async (t) => {
  const f = await fixture(t),
    prepared = await f.connector.prepare(f.operation, f.run);
  gitFixtureCommand(f.directory, [
    "config",
    "remote.origin.url",
    "https://github.com/other/repository.git",
  ]);
  await assert.rejects(f.connector.apply({ ...f.operation, prepared }), {
    code: "APPLICATION_REPOSITORY_UNAVAILABLE",
  });
  gitFixtureCommand(f.directory, [
    "config",
    "remote.origin.url",
    "git@github.com:Ether-X-UK/Vuzmi.git",
  ]);
  const path = join(f.directory, "apps/web/src/api.ts");
  await rm(path);
  await symlink("../../../untouched.txt", path);
  gitFixtureCommand(f.directory, ["add", "apps/web/src/api.ts"]);
  gitFixtureCommand(f.directory, ["commit", "-m", "Synthetic symlink base"]);
  const unsigned = {
      ...f.profile,
      baseCommit: gitFixtureCommand(f.directory, ["rev-parse", "HEAD"]).trim(),
    },
    profile = {
      ...unsigned,
      profileHash: digest(developmentProfileFingerprintInput(unsigned)),
    },
    run = approvedApplicationFixture(profile),
    plan = createDevelopmentApplicationPlan(
      run,
      f.operation.plan.repositoryIdentity,
      digest,
    );
  const operation = createDevelopmentApplication(
    plan,
    {
      requestId: randomUUID(),
      packageSha256: plan.packageSha256,
      planFingerprint: plan.fingerprint,
    },
    {
      id: randomUUID(),
      actor: applicationActor,
      now: f.operation.authorizedAt,
      hash: digest,
    },
  );
  await assert.rejects(f.connector.prepare(operation, run), {
    code: "APPLICATION_FILE_CHANGED",
  });
});

test("partial clones with missing approved blobs cannot lazy-fetch or execute configured SSH commands", async (t) => {
  const f = await fixture(t),
    marker = join(f.directory, "ssh-marker"),
    script = join(f.directory, "ssh-trap.sh");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  await chmod(script, 0o700);
  gitFixtureCommand(f.directory, ["config", "core.sshCommand", script]);
  gitFixtureCommand(f.directory, [
    "config",
    "extensions.partialClone",
    "origin",
  ]);
  gitFixtureCommand(f.directory, ["config", "remote.origin.promisor", "true"]);
  gitFixtureCommand(f.directory, [
    "config",
    "remote.origin.partialCloneFilter",
    "blob:none",
  ]);
  const blob = gitFixtureCommand(f.directory, [
    "ls-tree",
    f.profile.baseCommit,
    "--",
    "apps/web/src/api.ts",
  ]).split(/\s+/)[2];
  await rm(join(f.directory, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  assert.equal((await f.connector.readiness()).ready, false);
  await assert.rejects(f.connector.prepare(f.operation, f.run), {
    code: "APPLICATION_REPOSITORY_UNAVAILABLE",
  });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});
