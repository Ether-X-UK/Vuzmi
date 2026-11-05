import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, stat, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DevelopmentApplicationError,
  createDevelopmentApplicationPlan,
  parseDevelopmentApplicationIntegrity,
} from "@vuzmi/core";
import type {
  DevelopmentApplication,
  DevelopmentApplicationPrepared,
  DevelopmentRun,
} from "@vuzmi/core";
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const root = fileURLToPath(new URL("../../../", import.meta.url));
export interface DevelopmentGitAdapter {
  readiness(): Promise<{
    ready: boolean;
    reason: string;
    repositoryIdentity?: string;
  }>;
  prepare(
    operation: DevelopmentApplication,
    run: DevelopmentRun,
    signal?: AbortSignal,
  ): Promise<DevelopmentApplicationPrepared>;
  apply(operation: DevelopmentApplication, signal?: AbortSignal): Promise<void>;
  inspect(
    operation: DevelopmentApplication,
    signal?: AbortSignal,
  ): Promise<"applied" | "absent" | "conflict">;
}
class GitFailure extends Error {
  constructor(readonly exitCode: number) {
    super("A bounded local Git operation failed.");
  }
}
/** Fixed executable/argv; no shell, repository hooks, global config, filters or inherited Git environment. */
function git(
  repository: string,
  args: string[],
  options: {
    input?: string;
    index?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  return new Promise((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_PROTOCOL_FROM_USER: "0",
      ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
    };
    const child = spawn(
      "/usr/bin/git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=never",
        "-c",
        "fetch.recurseSubmodules=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.useReplaceRefs=false",
        "-c",
        "core.sparseCheckout=false",
        "-c",
        "core.splitIndex=false",
        "-C",
        repository,
        ...args,
      ],
      { env, stdio: ["pipe", "pipe", "pipe"], signal: options.signal },
    );
    const output: Buffer[] = [];
    let bytes = 0,
      failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new DevelopmentApplicationError(
        "APPLICATION_GIT_TIMEOUT",
        "Local Git did not finish within its bounded deadline.",
        503,
      );
      child.kill("SIGKILL");
    }, 15_000);
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) {
        failure = new DevelopmentApplicationError(
          "APPLICATION_GIT_BOUNDS",
          "The local repository exceeded the bounded Git response.",
          503,
        );
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      collect(chunk);
      output.push(chunk);
    });
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new GitFailure(code ?? 1));
      else resolveResult(Buffer.concat(output));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}
export function createDevelopmentGitConnector(
  options: { repositoryPath?: string } = {},
): DevelopmentGitAdapter {
  const repository = resolve(options.repositoryPath ?? root);
  const inspectRepository = async (signal?: AbortSignal) => {
    const common = await realpath(
      (
        await git(
          repository,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          { signal },
        )
      )
        .toString()
        .trim(),
    );
    if (
      !(await stat(common)).isDirectory() ||
      (await git(repository, ["rev-parse", "--show-object-format"], { signal }))
        .toString()
        .trim() !== "sha1" ||
      (
        await git(repository, ["rev-parse", "--is-shallow-repository"], {
          signal,
        })
      )
        .toString()
        .trim() !== "false"
    )
      throw new DevelopmentApplicationError(
        "APPLICATION_REPOSITORY_UNAVAILABLE",
        "Use the registered complete SHA-1 Vuzmi repository.",
        503,
      );
    const remote = (
      await git(
        repository,
        ["config", "--local", "--get", "remote.origin.url"],
        { signal },
      )
    )
      .toString()
      .trim();
    if (
      ![
        "git@github.com:Ether-X-UK/Vuzmi.git",
        "https://github.com/Ether-X-UK/Vuzmi.git",
        "https://github.com/Ether-X-UK/Vuzmi",
      ].includes(remote)
    )
      throw new DevelopmentApplicationError(
        "APPLICATION_REPOSITORY_UNAVAILABLE",
        "The local repository does not match the registered owned Vuzmi repository.",
        503,
      );
    let partialClone = false;
    try {
      await git(
        repository,
        [
          "config",
          "--get-regexp",
          "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$",
        ],
        { signal },
      );
      partialClone = true;
    } catch (error) {
      if (!(error instanceof GitFailure) || error.exitCode !== 1) throw error;
    }
    if (partialClone)
      throw new DevelopmentApplicationError(
        "APPLICATION_REPOSITORY_UNAVAILABLE",
        "Partial clones and promisor remotes are unsupported. Local application never fetches missing objects.",
        503,
      );
    for (const path of [
      join(common, "info/grafts"),
      join(common, "objects/info/alternates"),
    ]) {
      let exists = false;
      try {
        await access(path);
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (exists)
        throw new DevelopmentApplicationError(
          "APPLICATION_REPOSITORY_UNAVAILABLE",
          "Grafts and alternate object stores are unsupported by the local application policy.",
          503,
        );
    }
    return hash(common);
  };
  const validate = async (
    operation: DevelopmentApplication,
    signal?: AbortSignal,
  ) => {
    parseDevelopmentApplicationIntegrity(operation, hash);
    const identity = await inspectRepository(signal);
    if (identity !== operation.plan.repositoryIdentity)
      throw new DevelopmentApplicationError(
        "APPLICATION_REPOSITORY_CHANGED",
        "The registered repository identity changed; no local branch was written.",
      );
    const base = (
      await git(
        repository,
        ["rev-parse", "--verify", `${operation.plan.baseCommit}^{commit}`],
        { signal },
      )
    )
      .toString()
      .trim();
    if (base !== operation.plan.baseCommit)
      throw new DevelopmentApplicationError(
        "APPLICATION_BASE_CHANGED",
        "The pinned base is unavailable or differs from its recorded object.",
      );
  };
  const validatePrepared = async (
    operation: DevelopmentApplication,
    signal?: AbortSignal,
  ) => {
    if (!operation.prepared)
      throw new DevelopmentApplicationError(
        "APPLICATION_NOT_PREPARED",
        "An exact prepared commit is required.",
      );
    const raw = (
      await git(
        repository,
        ["cat-file", "commit", operation.prepared.commitOid],
        { signal },
      )
    ).toString();
    if (raw !== commitContent(operation, operation.prepared.treeOid))
      throw new DevelopmentApplicationError(
        "APPLICATION_COMMIT_CHANGED",
        "The prepared commit differs from its exact authorized parent, tree or metadata.",
      );
    const paths = (
      await git(
        repository,
        [
          "diff-tree",
          "--no-ext-diff",
          "--no-textconv",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-r",
          "-z",
          operation.plan.baseCommit,
          operation.prepared.treeOid,
        ],
        { signal },
      )
    )
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify(paths) !==
      JSON.stringify(operation.plan.files.map((file) => file.path).sort())
    )
      throw new DevelopmentApplicationError(
        "APPLICATION_TREE_CHANGED",
        "The prepared tree changes entries outside the approved replacements.",
      );
    for (const file of operation.prepared.files) {
      const entries = [];
      for (const tree of [
        operation.plan.baseCommit,
        operation.prepared.treeOid,
      ]) {
        const entry = (
            await git(repository, ["ls-tree", "-z", tree, "--", file.path], {
              signal,
            })
          ).toString(),
          match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(
            entry,
          );
        if (!match || match[1] !== file.mode || match[3] !== file.path)
          throw new DevelopmentApplicationError(
            "APPLICATION_FILE_CHANGED",
            "Prepared tree entries must preserve approved regular file modes.",
          );
        entries.push(
          hash(
            await git(repository, ["cat-file", "blob", match[2]], { signal }),
          ),
        );
      }
      if (entries[0] !== file.beforeSha256 || entries[1] !== file.afterSha256)
        throw new DevelopmentApplicationError(
          "APPLICATION_FILE_CHANGED",
          "Prepared blob bytes differ from the exact approved hashes.",
        );
    }
  };
  const refState = async (
    operation: DevelopmentApplication,
    signal?: AbortSignal,
  ): Promise<"applied" | "absent" | "conflict"> => {
    await validate(operation, signal);
    try {
      await git(
        repository,
        ["symbolic-ref", "-q", operation.plan.destinationRef],
        { signal },
      );
      return "conflict";
    } catch (error) {
      if (!(error instanceof GitFailure) || error.exitCode !== 1) throw error;
      signal?.throwIfAborted();
    }
    let current: string;
    try {
      current = (
        await git(
          repository,
          ["rev-parse", "--verify", "--quiet", operation.plan.destinationRef],
          { signal },
        )
      )
        .toString()
        .trim();
    } catch (error) {
      if (error instanceof GitFailure && error.exitCode === 1) return "absent";
      throw error;
    }
    if (!operation.prepared || current !== operation.prepared.commitOid)
      return "conflict";
    await validatePrepared(operation, signal);
    return "applied";
  };
  return {
    async readiness() {
      try {
        return {
          ready: true,
          reason:
            "Registered local Git repository is available; application remains separately owner-authorized.",
          repositoryIdentity: await inspectRepository(),
        };
      } catch {
        return {
          ready: false,
          reason:
            "The registered local Git repository is unavailable or violates the application policy. Existing receipts remain readable.",
        };
      }
    },
    async prepare(operation, run, signal) {
      await validate(operation, signal);
      const plan = createDevelopmentApplicationPlan(
        run,
        operation.plan.repositoryIdentity,
        hash,
      );
      if (JSON.stringify(plan) !== JSON.stringify(operation.plan))
        throw new DevelopmentApplicationError(
          "APPLICATION_PACKAGE_CHANGED",
          "The exact approved package no longer matches its authorized application plan.",
        );
      if (
        run.profile.sourceTree &&
        (
          await git(
            repository,
            ["rev-parse", `${operation.plan.baseCommit}^{tree}`],
            { signal },
          )
        )
          .toString()
          .trim() !== run.profile.sourceTree
      )
        throw new DevelopmentApplicationError(
          "APPLICATION_BASE_CHANGED",
          "The base tree differs from the operator-provisioned snapshot.",
        );
      const files: DevelopmentApplicationPrepared["files"] = [];
      const directory = await mkdtemp(join(tmpdir(), "vuzmi-git-index-")),
        index = join(directory, "index");
      try {
        await git(repository, ["read-tree", operation.plan.baseCommit], {
          index,
          signal,
        });
        for (const file of run.candidate!.files) {
          const tree = (
            await git(
              repository,
              ["ls-tree", "-z", operation.plan.baseCommit, "--", file.path],
              { signal },
            )
          ).toString();
          const match =
            /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree);
          if (!match || match[3] !== file.path)
            throw new DevelopmentApplicationError(
              "APPLICATION_FILE_CHANGED",
              "Only the approved existing regular file entries can be replaced.",
            );
          const before = await git(repository, ["cat-file", "blob", match[2]], {
            signal,
          });
          if (hash(before) !== file.beforeSha256)
            throw new DevelopmentApplicationError(
              "APPLICATION_FILE_CHANGED",
              "The pinned base file bytes differ from the approved before hash.",
            );
          if (hash(file.content) !== file.afterSha256)
            throw new DevelopmentApplicationError(
              "APPLICATION_FILE_CHANGED",
              "Replacement bytes differ from the approved after hash.",
            );
          files.push({
            path: file.path,
            beforeSha256: file.beforeSha256,
            afterSha256: file.afterSha256,
            mode: match[1] as "100644" | "100755",
          });
          const blob = (
            await git(
              repository,
              ["hash-object", "-w", "--stdin", "--no-filters"],
              { input: file.content, signal },
            )
          )
            .toString()
            .trim();
          await git(repository, ["update-index", "-z", "--index-info"], {
            input: `${match[1]} ${blob}\t${file.path}\0`,
            index,
            signal,
          });
        }
        const treeOid = (
          await git(repository, ["write-tree"], { index, signal })
        )
          .toString()
          .trim();
        const changed = (
          await git(
            repository,
            [
              "diff-tree",
              "--no-ext-diff",
              "--no-textconv",
              "--no-commit-id",
              "--name-only",
              "--no-renames",
              "-r",
              "-z",
              operation.plan.baseCommit,
              treeOid,
            ],
            { signal },
          )
        )
          .toString()
          .split("\0")
          .filter(Boolean)
          .sort();
        if (
          JSON.stringify(changed) !==
          JSON.stringify(operation.plan.files.map((file) => file.path).sort())
        )
          throw new DevelopmentApplicationError(
            "APPLICATION_TREE_CHANGED",
            "The materialized tree differs outside the approved replacement list.",
          );
        const raw = commitContent(operation, treeOid);
        const commitOid = (
          await git(
            repository,
            ["hash-object", "-t", "commit", "-w", "--stdin", "--no-filters"],
            { input: raw, signal },
          )
        )
          .toString()
          .trim();
        return { treeOid, commitOid, files };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    async apply(operation, signal) {
      if (!operation.prepared)
        throw new DevelopmentApplicationError(
          "APPLICATION_NOT_PREPARED",
          "A persisted exact commit is required before branch creation.",
        );
      await validate(operation, signal);
      await validatePrepared(operation, signal);
      const state = await refState(operation, signal);
      if (state === "applied") return;
      if (state === "conflict")
        throw new DevelopmentApplicationError(
          "APPLICATION_BRANCH_CONFLICT",
          "The fixed local branch is occupied by a different object. It was preserved.",
        );
      const worktrees = (
        await git(repository, ["worktree", "list", "--porcelain", "-z"], {
          signal,
        })
      )
        .toString()
        .split("\0");
      if (worktrees.includes(`branch ${operation.plan.destinationRef}`))
        throw new DevelopmentApplicationError(
          "APPLICATION_BRANCH_CONFLICT",
          "The reserved branch is checked out in another worktree. It was preserved.",
        );
      signal?.throwIfAborted();
      try {
        await git(repository, ["update-ref", "--stdin"], {
          input: `start\noption no-deref\ncreate ${operation.plan.destinationRef} ${operation.prepared.commitOid}\nprepare\ncommit\n`,
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        const observed = await refState(operation, signal);
        if (observed === "applied") return;
        if (observed === "conflict")
          throw new DevelopmentApplicationError(
            "APPLICATION_BRANCH_CONFLICT",
            "The fixed local branch is occupied by another reference. It was preserved.",
          );
        throw new DevelopmentApplicationError(
          "APPLICATION_UNCONFIRMED",
          "Git did not confirm branch creation and the reserved ref is currently absent. No automatic retry was started.",
        );
      }
      if ((await refState(operation, signal)) !== "applied")
        throw new DevelopmentApplicationError(
          "APPLICATION_UNCONFIRMED",
          "Local branch creation has an unconfirmed outcome; inspect the recorded expected commit.",
        );
    },
    inspect: refState,
  };
}
function commitContent(
  operation: DevelopmentApplication,
  treeOid: string,
): string {
  const seconds = Math.floor(Date.parse(operation.authorizedAt) / 1000),
    identity = "Vuzmi Local <local@vuzmi.invalid>";
  return `tree ${treeOid}\nparent ${operation.plan.baseCommit}\nauthor ${identity} ${seconds} +0000\ncommitter ${identity} ${seconds} +0000\n\nVuzmi approved development package ${operation.runId}\n\nApplication: ${operation.id}\nActor: ${Buffer.from(operation.actor).toString("hex")}\nPackage-SHA256: ${operation.plan.packageSha256}\nPlan-SHA256: ${operation.plan.fingerprint}\n`;
}
