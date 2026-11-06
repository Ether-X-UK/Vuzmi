import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  DevelopmentDeliveryError,
  createDevelopmentDeliveryPlan,
  developmentDeliveryCiSchema,
  developmentDeliveryReceiptSchema,
  developmentDeliveryTargetSchema,
  parseDevelopmentDeliveryIntegrity,
} from "@vuzmi/core";
import type {
  DevelopmentApplication,
  DevelopmentDelivery,
  DevelopmentDeliveryCi,
  DevelopmentDeliveryPhase,
  DevelopmentDeliveryReceipt,
  DevelopmentDeliveryTarget,
  DevelopmentRun,
} from "@vuzmi/core";
import { createDevelopmentGitConnector } from "./development-git.js";
import type { DevelopmentGitAdapter } from "./development-git.js";
import type {
  DevelopmentDeliveryInspection,
  DevelopmentGitHubAdapter,
} from "./development-delivery.js";

const origin = "https://api.github.com";
const repository = "Ether-X-UK/Vuzmi";
const prefix = `/repos/${repository}`;
const oidPattern = /^[a-f0-9]{40}$/;
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const gitOid = (type: string, value: string | Uint8Array) => {
  const bytes = Buffer.from(value);
  return createHash("sha1")
    .update(`${type} ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
};

/** Deliberately excludes upstream response bodies, headers and credential values. */
export class DevelopmentGitHubError extends DevelopmentDeliveryError {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(code, message, statusCode);
  }
}
const invalid = () =>
  new DevelopmentGitHubError(
    "DELIVERY_GITHUB_INVALID_RESPONSE",
    "GitHub returned an unsupported or inconsistent bounded response. Publication was not confirmed.",
    502,
  );
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
};
const oid = (value: unknown): string => {
  if (typeof value !== "string" || !oidPattern.test(value)) throw invalid();
  return value;
};
const positive = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid();
  return value as number;
};
interface Credential {
  identity: string;
  token: string;
}
interface Network {
  signal: AbortSignal;
  remaining: number;
}
interface Options {
  tokenFile?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
  localGit?: Pick<DevelopmentGitAdapter, "inspect">;
}

/** The identity describes an operator-owned file generation, never token bytes. */
async function credential(path: string | undefined): Promise<Credential> {
  const unavailable = () =>
    new DevelopmentGitHubError(
      "DELIVERY_CREDENTIAL_UNAVAILABLE",
      "An explicit absolute, owner-only GitHub delivery token file is required. Publication remains disconnected.",
      503,
    );
  if (!path || !isAbsolute(path)) throw unavailable();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      (before.mode & 0o777) !== 0o600 ||
      before.uid !== process.getuid?.() ||
      before.size < 20 ||
      before.size > 4096
    )
      throw unavailable();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await file.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    )
      throw unavailable();
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const token = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, bytesRead))
      .replace(/\n$/, "");
    if (bytesRead !== opened.size || !/^[A-Za-z0-9_]{20,4095}$/.test(token))
      throw unavailable();
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.mode !== opened.mode ||
      after.uid !== opened.uid
    )
      throw unavailable();
    return {
      identity: digest(
        JSON.stringify({
          version: 1,
          path: await realpath(path),
          device: opened.dev,
          inode: opened.ino,
          size: opened.size,
          modified: opened.mtimeMs,
          changed: opened.ctimeMs,
          mode: opened.mode,
          uid: opened.uid,
        }),
      ),
      token,
    };
  } catch {
    throw unavailable();
  } finally {
    await file?.close();
  }
}

/** Fixed-origin transport shared by public observations and authorized writes. */
class GitHubNetwork {
  readonly now: () => Date;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private busy = false;
  private cooldownUntil = 0;
  constructor(readonly options: Options) {
    this.now = options.now ?? (() => new Date());
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 60_000
    )
      throw new RangeError(
        "GitHub delivery deadline must be within sixty seconds.",
      );
  }
  async operation<T>(
    effect: (context: Network) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) signal.throwIfAborted();
    if (this.now().getTime() < this.cooldownUntil)
      throw new DevelopmentGitHubError(
        "DELIVERY_GITHUB_RATE_LIMITED",
        `GitHub requests are paused until ${new Date(this.cooldownUntil).toISOString()}. No automatic write retry will occur.`,
        429,
      );
    if (this.busy)
      throw new DevelopmentGitHubError(
        "DELIVERY_GITHUB_BUSY",
        "Another bounded GitHub delivery request is still in progress.",
      );
    this.busy = true;
    const controller = new AbortController();
    const combined = AbortSignal.any(
      [controller.signal, signal].filter((item): item is AbortSignal => !!item),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new DevelopmentGitHubError(
            "DELIVERY_GITHUB_TIMEOUT",
            "GitHub delivery exceeded its bounded deadline. Effects may be partial; only read-only reconciliation may follow.",
            504,
          ),
        );
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        effect({ signal: combined, remaining: 4 * 1024 * 1024 }),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof DevelopmentGitHubError) throw error;
      throw new DevelopmentGitHubError(
        "DELIVERY_GITHUB_UNCONFIRMED",
        "The bounded GitHub operation did not confirm its result. Effects may be partial; no automatic write retry will occur.",
        502,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.busy = false;
    }
  }
  async json(
    path: string,
    context: Network,
    options: {
      body?: unknown;
      token?: string;
      absent?: boolean;
      limit?: number;
    } = {},
  ): Promise<unknown | undefined> {
    context.signal.throwIfAborted();
    const url = `${origin}${prefix}${path}`;
    const response = await this.fetch(url, {
      method: options.body === undefined ? "GET" : "POST",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Vuzmi-reviewed-github-delivery",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: context.signal,
    });
    const discard = () => {
      void response.body?.cancel().catch(() => undefined);
    };
    if (context.signal.aborted) {
      discard();
      context.signal.throwIfAborted();
    }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== url)
    ) {
      discard();
      throw new DevelopmentGitHubError(
        "DELIVERY_GITHUB_REDIRECT_REFUSED",
        "GitHub redirected the fixed repository request. No redirect or alternate target was followed.",
        502,
      );
    }
    if (response.status === 403 || response.status === 429) {
      discard();
      const retry = response.headers.get("retry-after"),
        reset = response.headers.get("x-ratelimit-reset"),
        now = this.now().getTime();
      let until = now + 60_000;
      if (retry && /^\d+$/.test(retry)) until = now + Number(retry) * 1000;
      else if (
        response.headers.get("x-ratelimit-remaining") === "0" &&
        reset &&
        /^\d+$/.test(reset)
      )
        until = Number(reset) * 1000;
      this.cooldownUntil = Math.max(
        now + 1000,
        Math.min(now + 86_400_000, until),
      );
      throw new DevelopmentGitHubError(
        "DELIVERY_GITHUB_RATE_LIMITED_OR_FORBIDDEN",
        "GitHub denied or rate limited this request. Effects may be partial; check configured permissions and the recorded result before further action.",
        response.status,
      );
    }
    if (options.absent && response.status === 404) {
      discard();
      return undefined;
    }
    if (response.status !== (options.body === undefined ? 200 : 201)) {
      discard();
      throw new DevelopmentGitHubError(
        response.status === 409 || response.status === 422
          ? "DELIVERY_GITHUB_CONFLICT"
          : "DELIVERY_GITHUB_UNAVAILABLE",
        "GitHub did not confirm the fixed request. Existing objects, branches and pull requests were preserved; the outcome may be partial.",
        response.status === 409 || response.status === 422 ? 409 : 502,
      );
    }
    const limit = options.limit ?? 1024 * 1024;
    const length = response.headers.get("content-length");
    if (
      !/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      (length &&
        (!/^\d+$/.test(length) ||
          Number(length) > limit ||
          Number(length) > context.remaining)) ||
      !response.body
    ) {
      discard();
      throw invalid();
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        context.signal.throwIfAborted();
        const chunk = await reader.read();
        context.signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        context.remaining -= chunk.value.byteLength;
        if (bytes > limit || context.remaining < 0) {
          cancel();
          throw invalid();
        }
        chunks.push(chunk.value);
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch (error) {
      if (error instanceof DevelopmentGitHubError) throw error;
      throw invalid();
    } finally {
      context.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
}

interface Pull {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  url: string;
}

/** No inherited CLI authentication, arbitrary origin, retries or mutation fallback. */
export function createDevelopmentGitHubConnector(
  options: Options = {},
): DevelopmentGitHubAdapter {
  const network = new GitHubNetwork(options),
    localGit = options.localGit ?? createDevelopmentGitConnector();
  let lastTarget: DevelopmentDeliveryTarget | undefined;
  let readyTargetRequest: Promise<DevelopmentDeliveryTarget> | undefined;
  const target = async (
    context: Network,
  ): Promise<DevelopmentDeliveryTarget> => {
    const value = record(await network.json("", context, { limit: 64 * 1024 }));
    if (
      value.full_name !== repository ||
      value.private !== false ||
      value.visibility !== "public" ||
      value.default_branch !== "main" ||
      value.archived === true ||
      value.disabled === true
    )
      throw new DevelopmentGitHubError(
        "DELIVERY_REPOSITORY_UNAVAILABLE",
        "Delivery requires the fixed active public Ether-X-UK/Vuzmi repository with main as its default branch.",
        503,
      );
    const repositoryId = positive(value.id),
      format = record(
        await network.json("/hash-algorithm", context, { limit: 8192 }),
      );
    if (format.hash_algorithm !== "sha1")
      throw new DevelopmentGitHubError(
        "DELIVERY_OBJECT_FORMAT",
        "Only the registered SHA-1 Git object format is supported.",
      );
    const main = record(
        await network.json("/git/ref/heads/main", context, {
          limit: 16 * 1024,
        }),
      ),
      object = record(main.object);
    if (main.ref !== "refs/heads/main" || object.type !== "commit")
      throw invalid();
    lastTarget = developmentDeliveryTargetSchema.parse({
      repositoryId,
      repository,
      visibility: "public",
      targetBranch: "main",
      targetSha: oid(object.sha),
      observedAt: network.now().toISOString(),
    });
    return lastTarget;
  };
  const matchingTarget = (
    operation: DevelopmentDelivery,
    current: DevelopmentDeliveryTarget,
    exact: boolean,
  ) => {
    if (
      current.repositoryId !== operation.plan.repositoryId ||
      (exact && current.targetSha !== operation.plan.targetSha)
    )
      throw new DevelopmentGitHubError(
        "STALE_DELIVERY_TARGET",
        "The public repository identity or main target changed. Review a new exact plan before publication.",
      );
  };
  const branch = (operation: DevelopmentDelivery) =>
    operation.plan.destinationRef.slice("refs/heads/".length);
  const ref = async (
    operation: DevelopmentDelivery,
    context: Network,
  ): Promise<string | undefined> => {
    const result = await network.json(
      `/git/ref/heads/${branch(operation)}`,
      context,
      { absent: true, limit: 16 * 1024 },
    );
    if (result === undefined) return undefined;
    const value = record(result),
      object = record(value.object);
    if (value.ref !== operation.plan.destinationRef || object.type !== "commit")
      throw invalid();
    return oid(object.sha);
  };
  const pull = (operation: DevelopmentDelivery, unknown: unknown): Pull => {
    const value = record(unknown),
      head = record(value.head),
      base = record(value.base),
      headRepo = record(head.repo),
      baseRepo = record(base.repo),
      number = positive(value.number);
    if (
      headRepo.id !== operation.plan.repositoryId ||
      baseRepo.id !== operation.plan.repositoryId ||
      headRepo.full_name !== repository ||
      baseRepo.full_name !== repository ||
      head.ref !== branch(operation) ||
      base.ref !== "main" ||
      typeof value.title !== "string" ||
      typeof value.body !== "string" ||
      typeof value.draft !== "boolean" ||
      !["open", "closed"].includes(value.state as string) ||
      value.html_url !== `https://github.com/${repository}/pull/${number}`
    )
      throw invalid();
    return {
      number,
      title: value.title,
      body: value.body,
      draft: value.draft,
      state: value.state as Pull["state"],
      headSha: oid(head.sha),
      baseSha: oid(base.sha),
      url: value.html_url as string,
      mergeSha:
        value.merge_commit_sha === null ? null : oid(value.merge_commit_sha),
    };
  };
  const pulls = async (
    operation: DevelopmentDelivery,
    context: Network,
  ): Promise<Pull[]> => {
    const query = new URLSearchParams({
      state: "all",
      head: `Ether-X-UK:${branch(operation)}`,
      base: "main",
      per_page: "100",
    });
    const value = await network.json(`/pulls?${query}`, context);
    if (!Array.isArray(value) || value.length >= 100) throw invalid();
    return value.map((item) => pull(operation, item));
  };
  const exactPull = (operation: DevelopmentDelivery, value: Pull) =>
    value.headSha === operation.plan.commitOid &&
    value.title === operation.plan.title &&
    value.body === operation.plan.body &&
    value.draft === true;
  const receipt = (
    operation: DevelopmentDelivery,
    value: Pull,
  ): DevelopmentDeliveryReceipt =>
    developmentDeliveryReceiptSchema.parse({
      repositoryId: operation.plan.repositoryId,
      repository,
      headRef: branch(operation),
      headSha: value.headSha,
      baseBranch: "main",
      baseShaBefore: operation.plan.targetSha,
      baseShaAfter: value.baseSha,
      targetDrift: value.baseSha !== operation.plan.targetSha,
      prNumber: value.number,
      prUrl: value.url,
      title: value.title,
      body: value.body,
      draft: true,
      publishedAt: network.now().toISOString(),
    });
  const observe = async (
    operation: DevelopmentDelivery,
    context: Network,
  ): Promise<DevelopmentDeliveryInspection> => {
    const current = await target(context);
    matchingTarget(operation, current, false);
    const head = await ref(operation, context),
      existing = await pulls(operation, context);
    if (head && head !== operation.plan.commitOid)
      return {
        status: "conflict",
        reason:
          "The fixed public work branch points to a different commit. It was preserved.",
      };
    if (
      existing.length > 1 ||
      (existing.length === 1 && !exactPull(operation, existing[0]))
    )
      return {
        status: "conflict",
        reason:
          "The fixed branch has a conflicting or changed pull request. No PR was modified or replaced.",
      };
    if (existing.length === 1) {
      if (!head)
        return {
          status: "conflict",
          reason:
            "A pull request exists but the fixed work branch is absent. No branch was recreated.",
        };
      return { status: "published", receipt: receipt(operation, existing[0]) };
    }
    return head
      ? {
          status: "partial",
          reason:
            "The exact public work branch exists; no matching draft PR was observed. No write was retried.",
        }
      : {
          status: "absent",
          reason:
            "No fixed public work branch or matching PR was observed. Unreferenced objects or delayed effects may still exist; no write was retried.",
        };
  };
  return {
    async readiness(signal) {
      signal?.throwIfAborted();
      try {
        const authority = await credential(options.tokenFile);
        signal?.throwIfAborted();
        if (
          !lastTarget ||
          network.now().getTime() - Date.parse(lastTarget.observedAt) >= 300_000
        ) {
          readyTargetRequest ??= network
            .operation(target, signal)
            .finally(() => {
              readyTargetRequest = undefined;
            });
          await readyTargetRequest;
        }
        return {
          ready: true,
          reason:
            "An explicit private token file is configured. GitHub identity, permissions and exact target are rechecked at the authorized effect boundary.",
          authorityIdentity: authority.identity,
          ...(lastTarget &&
          network.now().getTime() - Date.parse(lastTarget.observedAt) < 300_000
            ? { target: lastTarget }
            : {}),
        };
      } catch {
        return {
          ready: false,
          reason:
            "GitHub publication is disconnected. Configure the explicit private token file on the trusted worker; public plans and retained receipts remain readable.",
        };
      }
    },
    observeTarget(signal) {
      return network.operation(target, signal);
    },
    inspect(operation, signal) {
      const value = parseDevelopmentDeliveryIntegrity(operation, digest);
      return network.operation((context) => observe(value, context), signal);
    },
    publish(operation, run, application, beforeWrite, signal) {
      const value = parseDevelopmentDeliveryIntegrity(operation, digest);
      if (value.status !== "running" || !value.attemptId || !value.workerId)
        throw new DevelopmentGitHubError(
          "DELIVERY_NOT_RESERVED",
          "A durable owned delivery attempt is required before any publication.",
        );
      return network.operation(async (context) => {
        const authority = await credential(options.tokenFile);
        if (authority.identity !== value.plan.authorityIdentity)
          throw new DevelopmentGitHubError(
            "STALE_DELIVERY_AUTHORITY",
            "The configured token file generation changed. Review a new exact plan.",
          );
        const planned = createDevelopmentDeliveryPlan(
          run,
          application,
          { title: value.plan.title, body: value.plan.inputBody },
          {
            repositoryId: value.plan.repositoryId,
            repository,
            visibility: "public",
            targetBranch: "main",
            targetSha: value.plan.targetSha,
            observedAt: value.plan.targetObservedAt,
          },
          authority.identity,
          digest,
        );
        if (JSON.stringify(planned) !== JSON.stringify(value.plan))
          throw new DevelopmentGitHubError(
            "DELIVERY_PACKAGE_CHANGED",
            "The exact approved package and application no longer match this publication plan.",
          );
        const metadata = value.plan.commit,
          raw = `tree ${value.plan.treeOid}\nparent ${value.plan.baseCommit}\nauthor ${metadata.author.name} <${metadata.author.email}> ${Math.floor(Date.parse(metadata.author.date) / 1000)} +0000\ncommitter ${metadata.committer.name} <${metadata.committer.email}> ${Math.floor(Date.parse(metadata.committer.date) / 1000)} +0000\n\n${metadata.message}`;
        if (gitOid("commit", raw) !== value.plan.commitOid)
          throw new DevelopmentGitHubError(
            "DELIVERY_LOCAL_COMMIT_MISMATCH",
            "The reviewed commit metadata does not reproduce the exact application commit.",
          );
        if ((await localGit.inspect(application, context.signal)) !== "applied")
          throw new DevelopmentGitHubError(
            "DELIVERY_LOCAL_BRANCH_CHANGED",
            "The exact applied local branch could not be verified. No publication was started.",
          );
        context.signal.throwIfAborted();
        const current = await target(context);
        matchingTarget(value, current, true);
        const existingHead = await ref(value, context),
          existingPulls = await pulls(value, context);
        if (existingHead && existingHead !== value.plan.commitOid)
          throw new DevelopmentGitHubError(
            "DELIVERY_BRANCH_CONFLICT",
            "The fixed public branch is occupied by a different commit. It was preserved.",
          );
        if (existingPulls.length) {
          if (
            existingPulls.length !== 1 ||
            !existingHead ||
            !exactPull(value, existingPulls[0])
          )
            throw new DevelopmentGitHubError(
              "DELIVERY_PULL_REQUEST_CONFLICT",
              "A conflicting pull request already exists. It was preserved.",
            );
          return receipt(value, existingPulls[0]);
        }
        const post = async (
          path: string,
          body: unknown,
          phase: Exclude<DevelopmentDeliveryPhase, "reserved">,
        ) => {
          context.signal.throwIfAborted();
          await beforeWrite(phase);
          context.signal.throwIfAborted();
          const fresh = await credential(options.tokenFile);
          if (fresh.identity !== value.plan.authorityIdentity)
            throw new DevelopmentGitHubError(
              "STALE_DELIVERY_AUTHORITY",
              "The configured token file generation changed during publication. Partial effects may exist; no further write occurred.",
            );
          context.signal.throwIfAborted();
          return record(
            await network.json(path, context, { body, token: fresh.token }),
          );
        };
        if (!existingHead) {
          const base = record(
            await network.json(
              `/git/commits/${value.plan.baseCommit}`,
              context,
              { limit: 32 * 1024 },
            ),
          );
          if (oid(base.sha) !== value.plan.baseCommit) throw invalid();
          const baseTree = oid(record(base.tree).sha),
            entries = [];
          for (const file of run.candidate!.files) {
            const approved = value.plan.files.find(
              (item) => item.path === file.path,
            );
            if (!approved || digest(file.content) !== approved.afterSha256)
              throw invalid();
            const expected = gitOid("blob", file.content),
              blob = await post(
                "/git/blobs",
                {
                  content: Buffer.from(file.content).toString("base64"),
                  encoding: "base64",
                },
                "blob",
              );
            if (oid(blob.sha) !== expected)
              throw new DevelopmentGitHubError(
                "DELIVERY_BLOB_OID_MISMATCH",
                "GitHub's uploaded blob differs from the exact approved bytes. Unreferenced objects may exist; no branch was created.",
              );
            entries.push({
              path: file.path,
              mode: approved.mode,
              type: "blob",
              sha: expected,
            });
          }
          const tree = await post(
            "/git/trees",
            { base_tree: baseTree, tree: entries },
            "tree",
          );
          if (oid(tree.sha) !== value.plan.treeOid)
            throw new DevelopmentGitHubError(
              "DELIVERY_TREE_OID_MISMATCH",
              "GitHub's tree differs from the exact local receipt. Unreferenced objects may exist; no branch was created.",
            );
          const commit = await post(
            "/git/commits",
            {
              message: metadata.message,
              tree: value.plan.treeOid,
              parents: [value.plan.baseCommit],
              author: metadata.author,
              committer: metadata.committer,
            },
            "commit",
          );
          if (oid(commit.sha) !== value.plan.commitOid)
            throw new DevelopmentGitHubError(
              "DELIVERY_COMMIT_OID_MISMATCH",
              "GitHub normalized or changed the exact commit identity. Unreferenced objects may exist; no branch was created and no fallback was attempted.",
            );
          const verified = record(
            await network.json(
              `/git/commits/${value.plan.commitOid}`,
              context,
              { limit: 32 * 1024 },
            ),
          );
          if (
            oid(verified.sha) !== value.plan.commitOid ||
            oid(record(verified.tree).sha) !== value.plan.treeOid ||
            !Array.isArray(verified.parents) ||
            verified.parents.length !== 1 ||
            oid(record(verified.parents[0]).sha) !== value.plan.baseCommit
          )
            throw invalid();
          matchingTarget(value, await target(context), true);
          const created = await post(
            "/git/refs",
            { ref: value.plan.destinationRef, sha: value.plan.commitOid },
            "branch",
          );
          if (
            created.ref !== value.plan.destinationRef ||
            oid(record(created.object).sha) !== value.plan.commitOid ||
            record(created.object).type !== "commit"
          )
            throw invalid();
        }
        matchingTarget(value, await target(context), true);
        if ((await ref(value, context)) !== value.plan.commitOid)
          throw new DevelopmentGitHubError(
            "DELIVERY_BRANCH_CONFLICT",
            "The fixed public branch changed before PR creation. It was preserved.",
          );
        if ((await pulls(value, context)).length)
          throw new DevelopmentGitHubError(
            "DELIVERY_PULL_REQUEST_CONFLICT",
            "A pull request appeared before PR creation. No duplicate was created; inspect the recorded result.",
          );
        const created = pull(
          value,
          await post(
            "/pulls",
            {
              title: value.plan.title,
              body: value.plan.body,
              head: branch(value),
              base: "main",
              draft: true,
              maintainer_can_modify: false,
            },
            "pull_request",
          ),
        );
        if (!exactPull(value, created)) throw invalid();
        const verified = pull(
          value,
          await network.json(`/pulls/${created.number}`, context, {
            limit: 256 * 1024,
          }),
        );
        if (
          !exactPull(value, verified) ||
          (await ref(value, context)) !== value.plan.commitOid
        )
          throw invalid();
        const after = await target(context);
        matchingTarget(value, after, false);
        // The API targets a mutable branch name; retain its observed post-create SHA.
        verified.baseSha = after.targetSha;
        return receipt(value, verified);
      }, signal);
    },
    observeCi(operation, signal) {
      const value = parseDevelopmentDeliveryIntegrity(operation, digest);
      return network
        .operation(async (context) => {
          const result: DevelopmentDeliveryCi = {
            observedAt: network.now().toISOString(),
            headSha: value.plan.commitOid,
            currentHeadSha: null,
            currentBaseSha: null,
            targetDrift: false,
            state: "unavailable",
            truncated: false,
            runs: [],
            reason:
              "No verified publication receipt is available for CI observation.",
          };
          if (!value.receipt) return developmentDeliveryCiSchema.parse(result);
          const current = await target(context);
          matchingTarget(value, current, false);
          const head = await ref(value, context),
            pr = pull(
              value,
              await network.json(`/pulls/${value.receipt.prNumber}`, context, {
                limit: 256 * 1024,
              }),
            );
          result.currentHeadSha = head ?? null;
          result.currentBaseSha = current.targetSha;
          result.targetDrift = current.targetSha !== value.plan.targetSha;
          if (
            head !== value.plan.commitOid ||
            !exactPull(value, pr) ||
            pr.state !== "open" ||
            result.targetDrift ||
            current.targetSha !== value.receipt.baseShaAfter ||
            pr.baseSha !== current.targetSha
          ) {
            result.state = "stale";
            result.reason =
              "The public head, target or reviewed draft PR changed. Earlier CI evidence is retained but does not establish the current review state.";
            return developmentDeliveryCiSchema.parse(result);
          }
          const workflow = record(
              await network.json("/actions/workflows/checks.yml", context, {
                limit: 16 * 1024,
              }),
            ),
            workflowId = positive(workflow.id);
          if (workflow.path !== ".github/workflows/checks.yml") throw invalid();
          const query = new URLSearchParams({
              event: "pull_request",
              head_sha: value.plan.commitOid,
              per_page: "20",
            }),
            response = record(
              await network.json(
                `/actions/workflows/checks.yml/runs?${query}`,
                context,
              ),
            );
          if (
            !Array.isArray(response.workflow_runs) ||
            !Number.isSafeInteger(response.total_count) ||
            (response.total_count as number) < response.workflow_runs.length ||
            response.workflow_runs.length > 20
          )
            throw invalid();
          result.truncated =
            (response.total_count as number) > response.workflow_runs.length;
          for (const unknown of response.workflow_runs) {
            const run = record(unknown),
              id = positive(run.id);
            const runAttempt = positive(run.run_attempt);
            if (
              run.workflow_id !== workflowId ||
              run.path !== ".github/workflows/checks.yml" ||
              run.event !== "pull_request" ||
              oid(run.head_sha) !== value.plan.commitOid ||
              run.html_url !==
                `https://github.com/${repository}/actions/runs/${id}` ||
              typeof run.name !== "string" ||
              typeof run.status !== "string" ||
              !(
                run.conclusion === null || typeof run.conclusion === "string"
              ) ||
              !Array.isArray(run.pull_requests) ||
              !run.pull_requests.some((item) => {
                const associated = record(item);
                return (
                  associated.number === value.receipt!.prNumber &&
                  oid(record(associated.head).sha) === value.plan.commitOid
                );
              })
            )
              throw invalid();
            const association = record(
              run.pull_requests.find(
                (item) => record(item).number === value.receipt!.prNumber,
              ),
            );
            const associatedBase = record(association.base);
            const baseSha = oid(associatedBase.sha);
            result.runs.push({
              id,
              workflowName: run.name,
              workflowId,
              workflowPath: ".github/workflows/checks.yml",
              runAttempt,
              baseSha,
              observedPrMergeSha: pr.mergeSha,
              event: run.event,
              headSha: value.plan.commitOid,
              status: run.status,
              conclusion: run.conclusion as string | null,
              url: run.html_url as string,
            });
          }
          // The newest run and its latest attempt govern this one named workflow.
          // Earlier successes cannot hide a newer pending or failed attempt.
          result.runs.sort(
            (a, b) => b.id - a.id || b.runAttempt - a.runAttempt,
          );
          result.runs = result.runs.slice(0, 1);
          if (result.runs[0] && result.runs[0].baseSha !== current.targetSha) {
            result.state = "stale";
            result.reason =
              "The newest workflow records a different PR base. A prior successful integration run is not evidence for the current target.";
            return developmentDeliveryCiSchema.parse(result);
          }
          if (result.truncated)
            result.reason =
              "The bounded run list is incomplete; it cannot establish a passing gate.";
          else if (!result.runs.length) {
            result.state = "waiting";
            result.reason =
              "No matching PR integration workflow run was observed. No workflow was dispatched.";
          } else if (
            result.runs.some((run) =>
              [
                "failure",
                "timed_out",
                "action_required",
                "startup_failure",
                "stale",
              ].includes(run.conclusion ?? ""),
            )
          ) {
            result.state = "failed";
            result.reason =
              "A matching named PR integration workflow reported failure or requires action.";
          } else if (result.runs.some((run) => run.status === "in_progress")) {
            result.state = "running";
            result.reason =
              "The matching PR integration workflow is still running.";
          } else if (
            result.runs.every(
              (run) =>
                run.status === "completed" && run.conclusion === "success",
            )
          ) {
            result.state = "passed";
            result.reason =
              "GitHub Actions reported success for the named workflow and associated PR head/base. The observed PR merge SHA is current context, not verified checkout evidence. This is not merge or release authorization.";
          } else {
            result.state = "waiting";
            result.reason =
              "Matching workflow evidence is pending, skipped, cancelled, neutral or approval-blocked; it is not a passing gate.";
          }
          return developmentDeliveryCiSchema.parse(result);
        }, signal)
        .catch((error) =>
          developmentDeliveryCiSchema.parse({
            observedAt: network.now().toISOString(),
            headSha: value.plan.commitOid,
            currentHeadSha: null,
            currentBaseSha: null,
            targetDrift: false,
            state: "unavailable",
            truncated: false,
            runs: [],
            reason:
              error instanceof DevelopmentDeliveryError
                ? error.message.slice(0, 600)
                : "CI evidence could not be confirmed by bounded public reads.",
          }),
        );
    },
  };
}
