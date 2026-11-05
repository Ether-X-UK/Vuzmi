import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  githubImportInputSchema,
  githubOriginSchema,
  githubPreviewFingerprintInput,
  githubPreviewInputSchema,
  githubPreviewSchema,
  sourceInputSchema,
  developmentIssueSchema,
  type DevelopmentIssue,
  type GithubImportInput,
  type GithubOrigin,
  type GithubPreview,
  type GithubPreviewInput,
  type Source,
} from "@vuzmi/core";
import { HttpError } from "./errors.js";

const repositoryPath = "/repos/Ether-X-UK/Vuzmi";
const apiOrigin = "https://api.github.com";
const oid = /^[a-f0-9]{40}$/;
const previewLifetime = 5 * 60_000;
const maxFileBytes = 65_536;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const invalidResponse = () =>
  new HttpError(
    502,
    "GITHUB_INVALID_RESPONSE",
    "GitHub did not return a valid, bounded public file snapshot. No source was saved.",
  );
const timeoutError = () =>
  new HttpError(
    504,
    "GITHUB_TIMEOUT",
    "The public GitHub request exceeded its fifteen-second deadline. No source was saved; try Preview file again.",
  );

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidResponse();
  return value as Record<string, unknown>;
}

type Network = {
  signal: AbortSignal;
  remaining: number;
};

/** Public, fixed-origin GET adapter. Never reads credentials or follows returned URLs.
 * Protocol: https://docs.github.com/en/rest/git/trees and /git/blobs.
 * Nonrecursive trees MUST omit the recursive parameter (even "false" enables it).
 */
export class GithubKnowledgeImporter {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly previews = new Map<
    string,
    { ownerId: string; preview: GithubPreview }
  >();
  private busy = false;
  private closed = false;
  private controller: AbortController | undefined;
  private cooldownUntil = 0;

  constructor(
    options: {
      fetch?: typeof globalThis.fetch;
      now?: () => Date;
      timeoutMs?: number;
    } = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 15_000
    )
      throw new RangeError(
        "GitHub request deadline must be within fifteen seconds.",
      );
  }

  close(): void {
    this.closed = true;
    this.previews.clear();
    this.controller?.abort();
  }

  private rateLimited(): HttpError {
    const seconds = Math.max(
      1,
      Math.ceil((this.cooldownUntil - this.now().getTime()) / 1000),
    );
    return new HttpError(
      429,
      "GITHUB_RATE_LIMITED",
      `GitHub's public API is rate limited. Wait ${seconds} seconds, until ${new Date(this.cooldownUntil).toISOString()}, before trying again. No source was saved.`,
    );
  }

  private setCooldown(headers: Headers): void {
    const now = this.now().getTime();
    const retry = headers.get("retry-after");
    let until = now + 60_000;
    if (retry && /^\d+$/.test(retry) && Number.isSafeInteger(Number(retry)))
      until = now + Number(retry) * 1000;
    else if (retry && Number.isFinite(Date.parse(retry)))
      until = Date.parse(retry);
    else if (headers.get("x-ratelimit-remaining") === "0") {
      const reset = headers.get("x-ratelimit-reset");
      if (reset && /^\d+$/.test(reset) && Number.isSafeInteger(Number(reset)))
        until = Number(reset) * 1000;
    }
    // Bound malformed upstream dates before exposing a human-readable time.
    this.cooldownUntil = Math.max(
      now + 1000,
      Math.min(now + 24 * 60 * 60_000, until),
    );
  }

  private async network<T>(
    operation: (context: Network) => Promise<T>,
  ): Promise<T> {
    if (this.closed)
      throw new HttpError(
        503,
        "GITHUB_UNAVAILABLE",
        "GitHub import is unavailable while this API is shutting down.",
      );
    if (this.now().getTime() < this.cooldownUntil) throw this.rateLimited();
    if (this.busy)
      throw new HttpError(
        409,
        "GITHUB_BUSY",
        "Another public GitHub request is still running. Wait for it to finish before retrying.",
      );
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, this.timeoutMs);
    });
    const work = async () => {
      try {
        return await operation({
          signal: controller.signal,
          remaining: 2 * 1024 * 1024,
        });
      } catch (error) {
        if (timedOut) throw timeoutError();
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          502,
          "GITHUB_UNAVAILABLE",
          "The public GitHub service could not be reached or its response could not be read. No source was saved.",
        );
      }
    };
    try {
      // Fetch, streamed body reads and injected transports can ignore abort.
      // The hard deadline still releases the admission lock and rejects callers.
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.busy = false;
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private async json(
    path: string,
    limit: number,
    context: Network,
  ): Promise<Record<string, unknown>> {
    context.signal.throwIfAborted();
    const url = `${apiOrigin}${repositoryPath}${path}`;
    const response = await this.fetch(url, {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "Vuzmi-public-knowledge-import",
      },
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== url)
    )
      throw new HttpError(
        422,
        "GITHUB_REDIRECT_REFUSED",
        "The repository request was redirected. Review the canonical repository location before importing; redirects are not followed.",
      );
    if (response.status === 403 || response.status === 429) {
      this.setCooldown(response.headers);
      throw this.rateLimited();
    }
    if (response.status === 404)
      throw new HttpError(
        404,
        "GITHUB_NOT_FOUND",
        "The public repository, commit or file is unavailable. Private repositories cannot be imported.",
      );
    if (response.status !== 200)
      throw new HttpError(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub could not provide this public snapshot. No source was saved; try again later.",
      );
    if (
      !/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw invalidResponse();
    const length = response.headers.get("content-length");
    if (
      length &&
      (!/^\d+$/.test(length) ||
        Number(length) > limit ||
        Number(length) > context.remaining)
    )
      throw new HttpError(
        413,
        "GITHUB_RESPONSE_TOO_LARGE",
        "The GitHub response exceeds this one-file import's supported size. No source was saved.",
      );
    if (!response.body) throw invalidResponse();
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        context.signal.throwIfAborted();
        const chunk = await reader.read();
        context.signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        context.remaining -= chunk.value.byteLength;
        if (bytes > limit || context.remaining < 0) {
          void reader.cancel().catch(() => undefined);
          throw new HttpError(
            413,
            "GITHUB_RESPONSE_TOO_LARGE",
            "The GitHub response exceeds this one-file import's supported size. No source was saved.",
          );
        }
        chunks.push(chunk.value);
      }
      try {
        return object(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          ),
        );
      } catch {
        throw invalidResponse();
      }
    } finally {
      context.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }

  private async repository(context: Network): Promise<number> {
    const repo = await this.json("", 64 * 1024, context);
    if (repo.private !== false || repo.visibility !== "public")
      throw new HttpError(
        422,
        "GITHUB_PUBLIC_ONLY",
        "Only the public Ether-X-UK/Vuzmi repository can be imported.",
      );
    const owner = object(repo.owner);
    if (
      !Number.isSafeInteger(repo.id) ||
      Number(repo.id) <= 0 ||
      typeof repo.name !== "string" ||
      repo.name.toLowerCase() !== "vuzmi" ||
      typeof owner.login !== "string" ||
      owner.login.toLowerCase() !== "ether-x-uk"
    )
      throw invalidResponse();
    return repo.id as number;
  }

  async verifyRepository(preview: GithubPreview): Promise<void> {
    await this.network(async (context) => {
      if ((await this.repository(context)) !== preview.origin.repositoryId)
        throw new HttpError(
          409,
          "GITHUB_REPOSITORY_CHANGED",
          "The public repository identity changed after preview. Preview the file again before saving.",
        );
    });
  }

  async issue(number: number): Promise<DevelopmentIssue> {
    if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Choose a positive public Vuzmi issue number within the supported limit.",
      );
    return this.network(async (context) => {
      await this.repository(context);
      const value = await this.json(`/issues/${number}`, 64 * 1024, context);
      if ("pull_request" in value)
        throw new HttpError(
          422,
          "GITHUB_ISSUE_REQUIRED",
          "Select a public Vuzmi issue, rather than a pull request.",
        );
      const text = `${typeof value.title === "string" ? value.title : ""}${typeof value.body === "string" ? value.body : ""}`;
      if (
        value.number !== number ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
        Buffer.byteLength(text, "utf8") > 24_000 ||
        Buffer.from(text, "utf8").toString("utf8") !== text
      )
        throw invalidResponse();
      const parsed = developmentIssueSchema.safeParse({
        id: value.id,
        number: value.number,
        title: value.title,
        body: value.body ?? "",
        url: value.html_url,
        updatedAt: value.updated_at,
        fetchedAt: this.now().toISOString(),
      });
      if (
        !parsed.success ||
        parsed.data.url !==
          `https://github.com/Ether-X-UK/Vuzmi/issues/${number}`
      )
        throw invalidResponse();
      return parsed.data;
    });
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, entry] of this.previews)
      if (Date.parse(entry.preview.expiresAt) <= now) this.previews.delete(id);
  }

  getPreview(ownerId: string, input: GithubImportInput): GithubPreview {
    this.prune();
    const entry = this.previews.get(input.previewId);
    if (!entry || entry.ownerId !== ownerId)
      throw new HttpError(
        409,
        "GITHUB_PREVIEW_EXPIRED",
        "This owner's preview expired or is unavailable. Preview the file again before saving.",
      );
    if (entry.preview.fingerprint !== input.fingerprint)
      throw new HttpError(
        409,
        "GITHUB_PREVIEW_MISMATCH",
        "The preview fingerprint changed. Preview the exact file again before saving.",
      );
    return structuredClone(entry.preview);
  }

  async preview(
    ownerId: string,
    input: GithubPreviewInput,
  ): Promise<GithubPreview> {
    const parsed = githubPreviewInputSchema.safeParse(input);
    if (!parsed.success)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Provide a full lowercase commit ID, a supported relative Markdown/text path, and a local title.",
      );
    this.prune();
    if (this.previews.size >= 8)
      throw new HttpError(
        429,
        "GITHUB_PREVIEW_LIMIT",
        "Eight previews are already held temporarily. Wait up to five minutes for them to expire before previewing another file.",
      );
    const value = parsed.data;
    const snapshot = await this.network(async (context) => {
      const repositoryId = await this.repository(context);
      const algorithm = await this.json("/hash-algorithm", 8 * 1024, context);
      if (algorithm.hash_algorithm !== "sha1")
        throw new HttpError(
          422,
          "GITHUB_UNSUPPORTED_HASH",
          "This import supports confirmed SHA-1 Git repositories only. No source was saved.",
        );
      const commit = await this.json(
        `/git/commits/${value.commit}`,
        128 * 1024,
        context,
      );
      let tree = object(commit.tree).sha;
      if (
        commit.sha !== value.commit ||
        typeof tree !== "string" ||
        !oid.test(tree)
      )
        throw invalidResponse();
      const parts = value.path.split("/");
      let blob: Record<string, unknown> | undefined;
      for (let index = 0; index < parts.length; index++) {
        const response = await this.json(
          `/git/trees/${tree}`,
          512 * 1024,
          context,
        );
        if (
          response.sha !== tree ||
          response.truncated !== false ||
          !Array.isArray(response.tree)
        )
          throw invalidResponse();
        const matches = response.tree.filter(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).path === parts[index],
        );
        if (!matches.length)
          throw new HttpError(
            404,
            "GITHUB_NOT_FOUND",
            "The selected file does not exist at this exact commit.",
          );
        if (matches.length !== 1) throw invalidResponse();
        const entry = object(matches[0]);
        if (typeof entry.sha !== "string" || !oid.test(entry.sha))
          throw invalidResponse();
        if (index < parts.length - 1) {
          if (entry.type !== "tree" || entry.mode !== "040000")
            throw new HttpError(
              422,
              "GITHUB_UNSUPPORTED_FILE",
              "Only regular text files are supported. Symlinks and submodules are not followed.",
            );
          tree = entry.sha;
        } else {
          if (
            entry.type !== "blob" ||
            !["100644", "100755"].includes(String(entry.mode))
          )
            throw new HttpError(
              422,
              "GITHUB_UNSUPPORTED_FILE",
              "Only regular text files are supported. Symlinks and submodules are not followed.",
            );
          blob = entry;
        }
      }
      if (
        !blob ||
        !Number.isInteger(blob.size) ||
        Number(blob.size) < 10 ||
        Number(blob.size) > maxFileBytes
      )
        throw new HttpError(
          413,
          "GITHUB_FILE_SIZE",
          "The selected file must fit the existing source limits, between ten bytes and 64 KiB.",
        );
      const response = await this.json(
        `/git/blobs/${blob.sha}`,
        128 * 1024,
        context,
      );
      if (
        response.sha !== blob.sha ||
        response.size !== blob.size ||
        response.encoding !== "base64" ||
        typeof response.content !== "string"
      )
        throw invalidResponse();
      const encoded = response.content.replace(/[\r\n]/g, "");
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded,
        )
      )
        throw invalidResponse();
      const raw = Buffer.from(encoded, "base64");
      if (
        raw.byteLength !== blob.size ||
        raw.byteLength > maxFileBytes ||
        raw.toString("base64") !== encoded
      )
        throw invalidResponse();
      const blobHash = createHash("sha1")
        .update(`blob ${raw.byteLength}\0`)
        .update(raw)
        .digest("hex");
      if (blobHash !== blob.sha) throw invalidResponse();
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(raw);
      } catch {
        throw new HttpError(
          422,
          "GITHUB_UNSUPPORTED_FILE",
          "The file is not valid UTF-8 plain text. No source was saved.",
        );
      }
      if (
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
          text,
        )
      )
        throw new HttpError(
          422,
          "GITHUB_UNSUPPORTED_FILE",
          "Binary or control-character file content cannot be imported.",
        );
      text = text.replace(/\r\n?/g, "\n").trim();
      if (
        /^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\n|$)/.test(text)
      )
        throw new HttpError(
          422,
          "GITHUB_UNSUPPORTED_FILE",
          "Git LFS pointers cannot be imported as knowledge text.",
        );
      const format: GithubPreview["format"] = /\.md$/i.test(value.path)
        ? "markdown"
        : "text";
      if (
        !sourceInputSchema.safeParse({ title: value.title, format, text })
          .success
      )
        throw new HttpError(
          422,
          "GITHUB_FILE_SIZE",
          "The normalized file does not fit the existing plain-text source limits. No source was saved.",
        );
      const origin: GithubOrigin = githubOriginSchema.parse({
        kind: "github-public",
        repositoryId,
        owner: "Ether-X-UK",
        repository: "Vuzmi",
        path: value.path,
        gitHashAlgorithm: "sha1",
        commitOid: value.commit,
        blobOid: blob.sha,
        rawSha256: hash(raw),
        rawBytes: raw.byteLength,
        normalizedSha256: hash(text),
        normalizedBytes: Buffer.byteLength(text, "utf8"),
        normalizationVersion: "plain-text-v1",
        fetchedAt: this.now().toISOString(),
      });
      return { title: value.title, format, text, origin };
    });
    if (this.closed)
      throw new HttpError(
        503,
        "GITHUB_UNAVAILABLE",
        "GitHub import stopped before the preview was retained.",
      );
    this.prune();
    if (this.previews.size >= 8)
      throw new HttpError(
        429,
        "GITHUB_PREVIEW_LIMIT",
        "Eight previews are already held temporarily. Wait up to five minutes for them to expire before previewing another file.",
      );
    const unsigned = {
      previewId: randomUUID(),
      expiresAt: new Date(this.now().getTime() + previewLifetime).toISOString(),
      ...snapshot,
    };
    const preview = githubPreviewSchema.parse({
      ...unsigned,
      fingerprint: hash(githubPreviewFingerprintInput(unsigned)),
    });
    this.previews.set(preview.previewId, {
      ownerId,
      preview: structuredClone(preview),
    });
    return preview;
  }
}

export interface GithubImportRepository {
  getGithubImport(
    workspaceId: string,
    input: GithubImportInput,
  ): Promise<Source | undefined>;
  importGithubSource(
    workspaceId: string,
    input: GithubImportInput,
    preview: GithubPreview,
  ): Promise<{ source: Source; replayed: boolean }>;
}

export function registerGithubKnowledgeRoutes(
  app: FastifyInstance,
  options: {
    knowledge: () => GithubImportRepository;
    ownerId: (request: FastifyRequest) => string | undefined;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
  },
): void {
  const importer = new GithubKnowledgeImporter(options);
  const owner = (request: FastifyRequest) => {
    const id = options.ownerId(request);
    if (!id)
      throw new HttpError(
        401,
        "SESSION_REQUIRED",
        "Sign in as the workspace owner before previewing or importing GitHub knowledge.",
      );
    return id;
  };
  app.addHook("onClose", async () => importer.close());
  app.post(
    "/v1/knowledge/github/preview",
    { bodyLimit: 4096 },
    async (request) => {
      const ownerId = owner(request);
      options.knowledge();
      const input = githubPreviewInputSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide a full lowercase commit ID, a supported relative Markdown/text path, and a local title.",
        );
      return importer.preview(ownerId, input.data);
    },
  );
  app.post(
    "/v1/knowledge/github/import",
    { bodyLimit: 4096 },
    async (request, reply) => {
      const ownerId = owner(request);
      const repository = options.knowledge();
      const input = githubImportInputSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide the import UUID, preview UUID and exact preview fingerprint.",
        );
      const existing = await repository.getGithubImport(
        "local-workspace",
        input.data,
      );
      if (existing) return { source: existing, replayed: true };
      const preview = importer.getPreview(ownerId, input.data);
      await importer.verifyRepository(preview);
      const result = await repository.importGithubSource(
        "local-workspace",
        input.data,
        preview,
      );
      return reply.code(result.replayed ? 200 : 202).send(result);
    },
  );
}
