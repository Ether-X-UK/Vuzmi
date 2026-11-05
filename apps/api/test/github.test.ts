import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { AuthService } from "@vuzmi/auth";
import {
  githubPreviewFingerprintInput,
  type GithubImportInput,
  type GithubPreview,
  type GithubPreviewInput,
  type Source,
} from "@vuzmi/core";
import { PostgresRunRepository } from "@vuzmi/runtime";
import { buildApp } from "../src/app.js";
import { HttpError } from "../src/errors.js";
import {
  GithubKnowledgeImporter,
  type GithubImportRepository,
} from "../src/github.js";

const base = "https://api.github.com/repos/Ether-X-UK/Vuzmi";
const commit = "1".repeat(40);
const fixedTime = Date.parse("2026-11-05T13:00:00.000Z");
const input: GithubPreviewInput = {
  commit,
  path: "docs/README.md",
  title: "Owned release knowledge",
};
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function upstream(
  raw = Buffer.from(
    " \r\n# Owned café 🟢\r\n\r\nSelected local release knowledge.\r\n",
  ),
  path = input.path,
) {
  const blob = createHash("sha1")
    .update(`blob ${raw.length}\0`)
    .update(raw)
    .digest("hex");
  const calls: { url: string; init: RequestInit }[] = [];
  const values = new Map<string, unknown>();
  const parts = path.split("/");
  const trees = parts.map((_, index) => String(index + 2).padStart(40, "0"));
  values.set("", {
    id: 4711,
    name: "Vuzmi",
    owner: { login: "Ether-X-UK" },
    private: false,
    visibility: "public",
  });
  values.set("/hash-algorithm", { hash_algorithm: "sha1" });
  values.set(`/git/commits/${commit}`, {
    sha: commit,
    tree: { sha: trees[0] },
  });
  for (let index = 0; index < parts.length; index++) {
    const last = index === parts.length - 1;
    values.set(`/git/trees/${trees[index]}`, {
      sha: trees[index],
      truncated: false,
      tree: [
        {
          path: parts[index],
          type: last ? "blob" : "tree",
          mode: last ? "100644" : "040000",
          sha: last ? blob : trees[index + 1],
          ...(last ? { size: raw.length } : {}),
        },
      ],
    });
  }
  values.set(`/git/blobs/${blob}`, {
    sha: blob,
    encoding: "base64",
    size: raw.length,
    content: raw.toString("base64").replace(/(.{24})/g, "$1\n"),
  });
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const value = String(url);
    calls.push({ url: value, init: init ?? {} });
    assert.ok(value.startsWith(base));
    const result = values.get(value.slice(base.length));
    assert.notEqual(result, undefined, `Unexpected fixture request: ${value}`);
    return result instanceof Response ? result.clone() : Response.json(result);
  };
  return { fetch, calls, values, raw, blob, trees };
}
function importer(
  fixture = upstream(),
  options: { now?: () => Date; timeoutMs?: number } = {},
) {
  return new GithubKnowledgeImporter({
    fetch: fixture.fetch,
    now: () => new Date(fixedTime),
    ...options,
  });
}
function errorCode(code: string, status?: number) {
  return (error: unknown) =>
    error instanceof HttpError &&
    error.code === code &&
    (status === undefined || error.status === status);
}
function confirmation(preview: GithubPreview): GithubImportInput {
  return {
    importId: randomUUID(),
    previewId: preview.previewId,
    fingerprint: preview.fingerprint,
  };
}
function savedSource(preview: GithubPreview): Source {
  return {
    id: randomUUID(),
    workspaceId: "local-workspace",
    title: preview.title,
    format: preview.format,
    revision: 1,
    activeRevision: null,
    status: "queued",
    contentHash: preview.origin.normalizedSha256,
    chunkCount: 0,
    profile: null,
    createdAt: preview.origin.fetchedAt,
    updatedAt: preview.origin.fetchedAt,
    error: null,
    origin: preview.origin,
  };
}

test("public commit/tree/blob preview pins verified bytes and normalizes only local text", async () => {
  const fixture = upstream();
  const service = importer(fixture);
  const preview = await service.preview("owner-a", input);
  assert.equal(
    preview.text,
    "# Owned café 🟢\n\nSelected local release knowledge.",
  );
  assert.equal(preview.format, "markdown");
  assert.equal(preview.origin.commitOid, commit);
  assert.equal(preview.origin.blobOid, fixture.blob);
  assert.equal(preview.origin.rawSha256, sha256(fixture.raw));
  assert.equal(preview.origin.normalizedSha256, sha256(preview.text));
  assert.equal(preview.origin.rawBytes, fixture.raw.length);
  assert.equal(preview.origin.normalizedBytes, Buffer.byteLength(preview.text));
  assert.equal(
    preview.fingerprint,
    sha256(githubPreviewFingerprintInput(preview)),
  );
  assert.equal(Date.parse(preview.expiresAt), fixedTime + 300_000);
  assert.deepEqual(
    fixture.calls.map((call) => call.url),
    [
      base,
      `${base}/hash-algorithm`,
      `${base}/git/commits/${commit}`,
      ...fixture.trees.map((tree) => `${base}/git/trees/${tree}`),
      `${base}/git/blobs/${fixture.blob}`,
    ],
  );
  for (const call of fixture.calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.credentials, "omit");
    const headers = new Headers(call.init.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    assert.equal(new URL(call.url).search, "");
  }
  const request = confirmation(preview);
  preview.text = "Caller mutation must not change a held preview.";
  assert.notEqual(service.getPreview("owner-a", request).text, preview.text);
  assert.throws(
    () => service.getPreview("owner-b", request),
    errorCode("GITHUB_PREVIEW_EXPIRED", 409),
  );
  assert.throws(
    () =>
      service.getPreview("owner-a", {
        ...request,
        fingerprint: "a".repeat(64),
      }),
    errorCode("GITHUB_PREVIEW_MISMATCH", 409),
  );
});

test("invalid targets and unsupported paths fail before any GET", async () => {
  const fixture = upstream();
  const service = importer(fixture);
  for (const path of [
    "../README.md",
    "/README.md",
    "a//README.md",
    "a\\README.md",
    "README.md?url=http://127.0.0.1",
    "https://github.com/a.md",
    "README.pdf",
    "a/%2e%2e/a.md",
    "a/b/c/d/e/f/g/h/i.md",
  ])
    await assert.rejects(
      service.preview("owner", { ...input, path }),
      errorCode("INVALID_INPUT", 400),
    );
  await assert.rejects(
    service.preview("owner", { ...input, commit: "main" }),
    errorCode("INVALID_INPUT", 400),
  );
  await assert.rejects(
    service.preview("owner", {
      ...input,
      repository: "untrusted",
    } as GithubPreviewInput),
    errorCode("INVALID_INPUT", 400),
  );
  assert.equal(fixture.calls.length, 0);
});

test("repository, hash, commit and tree integrity fail closed", async (t) => {
  const cases: {
    name: string;
    code: string;
    mutate: (fixture: ReturnType<typeof upstream>) => void;
  }[] = [
    {
      name: "private repository",
      code: "GITHUB_PUBLIC_ONLY",
      mutate: (f) =>
        f.values.set("", {
          ...(f.values.get("") as object),
          private: true,
          visibility: "private",
        }),
    },
    {
      name: "wrong repository",
      code: "GITHUB_INVALID_RESPONSE",
      mutate: (f) =>
        f.values.set("", { ...(f.values.get("") as object), name: "Other" }),
    },
    {
      name: "malformed numeric identity",
      code: "GITHUB_INVALID_RESPONSE",
      mutate: (f) =>
        f.values.set("", { ...(f.values.get("") as object), id: "4711" }),
    },
    {
      name: "unsupported hash algorithm",
      code: "GITHUB_UNSUPPORTED_HASH",
      mutate: (f) =>
        f.values.set("/hash-algorithm", { hash_algorithm: "sha256" }),
    },
    {
      name: "different commit",
      code: "GITHUB_INVALID_RESPONSE",
      mutate: (f) =>
        f.values.set(`/git/commits/${commit}`, {
          sha: "a".repeat(40),
          tree: { sha: f.trees[0] },
        }),
    },
    {
      name: "truncated tree",
      code: "GITHUB_INVALID_RESPONSE",
      mutate: (f) =>
        f.values.set(`/git/trees/${f.trees[0]}`, {
          ...(f.values.get(`/git/trees/${f.trees[0]}`) as object),
          truncated: true,
        }),
    },
    {
      name: "wrong tree",
      code: "GITHUB_INVALID_RESPONSE",
      mutate: (f) =>
        f.values.set(`/git/trees/${f.trees[0]}`, {
          sha: "f".repeat(40),
          tree: [],
          truncated: false,
        }),
    },
    {
      name: "missing path",
      code: "GITHUB_NOT_FOUND",
      mutate: (f) =>
        f.values.set(`/git/trees/${f.trees[0]}`, {
          sha: f.trees[0],
          tree: [],
          truncated: false,
        }),
    },
  ];
  for (const entry of cases)
    await t.test(entry.name, async () => {
      const fixture = upstream();
      entry.mutate(fixture);
      await assert.rejects(
        importer(fixture).preview("owner", input),
        errorCode(entry.code),
      );
    });
});

test("symlinks and submodules are rejected before requesting their targets", async (t) => {
  for (const [mode, type] of [
    ["120000", "blob"],
    ["160000", "commit"],
    ["040000", "tree"],
  ])
    await t.test(`${mode}/${type}`, async () => {
      const fixture = upstream();
      const path = `/git/trees/${fixture.trees[1]}`;
      const tree = fixture.values.get(path) as {
        tree: { mode: string; type: string }[];
      };
      tree.tree[0]!.mode = mode!;
      tree.tree[0]!.type = type!;
      await assert.rejects(
        importer(fixture).preview("owner", input),
        errorCode("GITHUB_UNSUPPORTED_FILE", 422),
      );
      assert.equal(
        fixture.calls.some((call) => call.url.includes("/git/blobs/")),
        false,
      );
    });
  const fixture = upstream();
  const tree = fixture.values.get(`/git/trees/${fixture.trees[0]}`) as {
    tree: { mode: string; type: string }[];
  };
  tree.tree[0]!.mode = "120000";
  tree.tree[0]!.type = "blob";
  await assert.rejects(
    importer(fixture).preview("owner", input),
    errorCode("GITHUB_UNSUPPORTED_FILE", 422),
  );
});

test("blob sizes, Base64 and Git header hashes must match", async (t) => {
  const cases: [string, (value: Record<string, unknown>) => void][] = [
    [
      "invalid Base64",
      (value) => {
        value.content = "this is not base64";
      },
    ],
    [
      "wrong size",
      (value) => {
        value.size = Number(value.size) + 1;
      },
    ],
    [
      "wrong identity",
      (value) => {
        value.sha = "a".repeat(40);
      },
    ],
    [
      "wrong encoding",
      (value) => {
        value.encoding = "none";
      },
    ],
    [
      "modified content",
      (value) => {
        value.content = Buffer.alloc(Number(value.size), 65).toString("base64");
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, async () => {
      const fixture = upstream();
      mutate(
        fixture.values.get(`/git/blobs/${fixture.blob}`) as Record<
          string,
          unknown
        >,
      );
      await assert.rejects(
        importer(fixture).preview("owner", input),
        errorCode("GITHUB_INVALID_RESPONSE", 502),
      );
    });
  const fixture = upstream(Buffer.alloc(65_537, 65));
  await assert.rejects(
    importer(fixture).preview("owner", input),
    errorCode("GITHUB_FILE_SIZE", 413),
  );
  assert.equal(
    fixture.calls.some((call) => call.url.includes("/git/blobs/")),
    false,
  );
});

test("malformed UTF-8, binary/control content, LFS pointers and source limits reject exact blobs", async (t) => {
  const cases = [
    Buffer.concat([
      Buffer.from([0xc3, 0x28]),
      Buffer.from("invalid UTF8 content"),
    ]),
    Buffer.from("Some binary\0content"),
    Buffer.from("Some ANSI \x1b[31m content"),
    Buffer.from("Spoof \u202e file text"),
    Buffer.from(
      "version https://git-lfs.github.com/spec/v1\noid sha256:" +
        "a".repeat(64) +
        "\nsize 123\n",
    ),
    Buffer.alloc(64_001, 65),
  ];
  for (let index = 0; index < cases.length; index++)
    await t.test(`content ${index}`, async () => {
      const fixture = upstream(cases[index]);
      await assert.rejects(
        importer(fixture).preview("owner", input),
        (error) => error instanceof HttpError && error.status === 422,
      );
    });
});

test("redirects and upstream errors never echo opaque content or request a returned URL", async (t) => {
  for (const status of [301, 302, 307, 404, 500])
    await t.test(String(status), async () => {
      const fixture = upstream();
      fixture.values.set(
        "",
        new Response("opaque-private-upstream-body", {
          status,
          headers: {
            location: "http://127.0.0.1:1/private",
            "content-type": "text/html",
          },
        }),
      );
      await assert.rejects(
        importer(fixture).preview("owner", input),
        (error) => {
          assert.ok(error instanceof HttpError);
          assert.doesNotMatch(
            error.message,
            /opaque-private|127\.0\.0\.1|\/private/,
          );
          return true;
        },
      );
      assert.equal(fixture.calls.length, 1);
    });
  await assert.rejects(
    new GithubKnowledgeImporter({
      fetch: async () => {
        throw new Error("secret token in transport error");
      },
    }).preview("owner", input),
    (error) =>
      error instanceof HttpError && !error.message.includes("secret token"),
  );
});

test("streamed JSON is bounded without Content-Length and malformed data fails safely", async () => {
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65_537));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    new GithubKnowledgeImporter({ fetch: async () => oversized }).preview(
      "owner",
      input,
    ),
    errorCode("GITHUB_RESPONSE_TOO_LARGE", 413),
  );
  for (const response of [
    new Response("{bad-json", {
      headers: { "content-type": "application/json" },
    }),
    new Response("opaque", { headers: { "content-type": "text/html" } }),
    Response.json({
      id: null,
      private: false,
      visibility: "public",
      name: "Vuzmi",
      owner: { login: "Ether-X-UK" },
    }),
  ])
    await assert.rejects(
      new GithubKnowledgeImporter({ fetch: async () => response }).preview(
        "owner",
        input,
      ),
      errorCode("GITHUB_INVALID_RESPONSE", 502),
    );
});

test("rate cooldown is concrete, enforced without a new request, and expires", async () => {
  let now = fixedTime;
  const fixture = upstream();
  fixture.values.set(
    "",
    new Response("opaque token", {
      status: 429,
      headers: { "retry-after": "120" },
    }),
  );
  const service = importer(fixture, { now: () => new Date(now) });
  await assert.rejects(
    service.preview("owner", input),
    (error) =>
      error instanceof HttpError &&
      error.code === "GITHUB_RATE_LIMITED" &&
      error.message.includes("120 seconds") &&
      error.message.includes("2026-11-05T13:02:00.000Z") &&
      !error.message.includes("opaque"),
  );
  await assert.rejects(
    service.preview("owner", input),
    errorCode("GITHUB_RATE_LIMITED", 429),
  );
  assert.equal(fixture.calls.length, 1);
  now += 120_000;
  fixture.values.set("", {
    id: 4711,
    name: "Vuzmi",
    owner: { login: "Ether-X-UK" },
    private: false,
    visibility: "public",
  });
  assert.ok(await service.preview("owner", input));
});

test("hard deadline releases the active request even if fetch or body reads ignore abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = upstream();
  let blocked = true;
  const service = new GithubKnowledgeImporter({
    fetch: (url, init) =>
      blocked ? new Promise(() => {}) : fixture.fetch(url, init),
  });
  const pending = service.preview("owner", input);
  const rejected = assert.rejects(pending, errorCode("GITHUB_TIMEOUT", 504));
  await assert.rejects(
    service.preview("owner", input),
    errorCode("GITHUB_BUSY", 409),
  );
  t.mock.timers.tick(15_000);
  await rejected;
  blocked = false;
  assert.ok(await service.preview("owner", input));
  let cancelled = false;
  const stalled = new GithubKnowledgeImporter({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start() {},
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const stalledResult = assert.rejects(
    stalled.preview("owner", input),
    errorCode("GITHUB_TIMEOUT", 504),
  );
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await stalledResult;
  assert.equal(cancelled, true);
});

test("eight previews expire after five minutes and close removes retained state", async () => {
  let now = fixedTime;
  const service = importer(upstream(), { now: () => new Date(now) });
  const first = await service.preview("owner", input);
  for (let index = 1; index < 8; index++) await service.preview("owner", input);
  await assert.rejects(
    service.preview("owner", input),
    errorCode("GITHUB_PREVIEW_LIMIT", 429),
  );
  now += 300_000;
  assert.throws(
    () => service.getPreview("owner", confirmation(first)),
    errorCode("GITHUB_PREVIEW_EXPIRED", 409),
  );
  const next = await service.preview("owner", input);
  service.close();
  assert.throws(
    () => service.getPreview("owner", confirmation(next)),
    errorCode("GITHUB_PREVIEW_EXPIRED", 409),
  );
  await assert.rejects(
    service.preview("owner", input),
    errorCode("GITHUB_UNAVAILABLE", 503),
  );
});

async function appHarness(t: TestContext, fixture = upstream()) {
  const writes: { input: GithubImportInput; preview: GithubPreview }[] = [];
  const receipts = new Map<
    string,
    { input: GithubImportInput; source: Source }
  >();
  const repository: GithubImportRepository = {
    async getGithubImport(_workspaceId, value) {
      const receipt = receipts.get(value.importId);
      if (receipt && JSON.stringify(receipt.input) !== JSON.stringify(value))
        throw new HttpError(
          409,
          "GITHUB_IMPORT_CONFLICT",
          "The import identity is already bound to another request.",
        );
      return receipt?.source;
    },
    async importGithubSource(_workspaceId, value, preview) {
      writes.push({ input: value, preview });
      const source = savedSource(preview);
      receipts.set(value.importId, { input: value, source });
      return { source, replayed: false };
    },
  };
  t.mock.method(
    PostgresRunRepository,
    "connect",
    async () =>
      ({
        knowledge: repository,
        close: async () => {},
      }) as unknown as PostgresRunRepository,
  );
  const auth = {
    session: async (headers: Headers) =>
      headers.get("cookie")?.startsWith("owner=")
        ? {
            id: headers.get("cookie")!.slice(6),
            name: "Fixture owner",
            email: "fixture@example.invalid",
          }
        : null,
    close: async () => {},
  } as unknown as AuthService;
  const create = () =>
    buildApp({
      databaseUrl: "postgresql://fixture:fixture@127.0.0.1:1/unused",
      auth,
      githubFetch: fixture.fetch,
      now: () => new Date(fixedTime),
    });
  const app = await create();
  t.after(() => app.close());
  return { app, create, fixture, writes, receipts };
}
const headers = { origin: "http://127.0.0.1:4310", cookie: "owner=owner-a" };

test("production GitHub routes require owner, trusted origin and strict input before transport", async (t) => {
  const { app, fixture, writes } = await appHarness(t);
  for (const request of [
    { headers: { origin: headers.origin }, expected: 401 },
    { headers: { cookie: headers.cookie }, expected: 403 },
    {
      headers: { ...headers, origin: "http://untrusted.invalid" },
      expected: 403,
    },
    { headers: { ...headers, host: "untrusted.invalid" }, expected: 403 },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/knowledge/github/preview",
          headers: request.headers,
          payload: input,
        })
      ).statusCode,
      request.expected,
    );
  for (const payload of [
    { ...input, path: "../README.md" },
    { ...input, owner: "someone" },
    { ...input, url: "http://127.0.0.1/private" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/knowledge/github/preview",
          headers,
          payload,
        })
      ).statusCode,
      400,
    );
  assert.equal(fixture.calls.length, 0);
  assert.equal(writes.length, 0);
  const development = await buildApp({
    databaseUrl: "postgresql://fixture:fixture@127.0.0.1:1/unused",
    githubFetch: fixture.fetch,
  });
  t.after(() => development.close());
  assert.equal(
    (
      await development.inject({
        method: "POST",
        url: "/v1/knowledge/github/preview",
        headers,
        payload: input,
      })
    ).statusCode,
    401,
  );
  assert.equal(fixture.calls.length, 0);
});

test("preview is read-only; exact owner confirmation saves only the server snapshot and receipt replay bypasses cache/network", async (t) => {
  const { app, create, fixture, writes } = await appHarness(t);
  const response = await app.inject({
    method: "POST",
    url: "/v1/knowledge/github/preview",
    headers,
    payload: input,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(writes.length, 0);
  const preview = response.json<GithubPreview>();
  const payload = confirmation(preview);
  const requests = fixture.calls.length;
  const otherOwner = await app.inject({
    method: "POST",
    url: "/v1/knowledge/github/import",
    headers: { ...headers, cookie: "owner=owner-b" },
    payload,
  });
  assert.equal(otherOwner.statusCode, 409);
  assert.equal(fixture.calls.length, requests);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/knowledge/github/import",
        headers,
        payload: { ...payload, text: "Injected text" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/knowledge/github/import",
        headers,
        payload: { ...payload, fingerprint: "a".repeat(64) },
      })
    ).statusCode,
    409,
  );
  const saved = await app.inject({
    method: "POST",
    url: "/v1/knowledge/github/import",
    headers,
    payload,
  });
  assert.equal(saved.statusCode, 202);
  assert.equal(saved.json().replayed, false);
  assert.equal(fixture.calls.length, requests + 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.preview, preview);
  const restarted = await create();
  t.after(() => restarted.close());
  const replay = await restarted.inject({
    method: "POST",
    url: "/v1/knowledge/github/import",
    headers,
    payload,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().source.id, saved.json().source.id);
  assert.equal(writes.length, 1);
  assert.equal(fixture.calls.length, requests + 1);
});

test("repository identity and public visibility are rechecked before local save", async (t) => {
  const { app, fixture, writes } = await appHarness(t);
  const preview = (
    await app.inject({
      method: "POST",
      url: "/v1/knowledge/github/preview",
      headers,
      payload: input,
    })
  ).json<GithubPreview>();
  const payload = confirmation(preview);
  const original = fixture.values.get("") as object;
  fixture.values.set("", { ...original, id: 9999 });
  const changed = await app.inject({
    method: "POST",
    url: "/v1/knowledge/github/import",
    headers,
    payload,
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, "GITHUB_REPOSITORY_CHANGED");
  fixture.values.set("", { ...original, private: true, visibility: "private" });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/knowledge/github/import",
        headers,
        payload,
      })
    ).statusCode,
    422,
  );
  assert.equal(writes.length, 0);
});
