import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DEVELOPMENT_COMMAND,
  DEVELOPMENT_PATH,
  developmentProfileFingerprintInput,
  type DevelopmentProfile,
} from "@vuzmi/core";
import { generateDevelopmentPatch, ProviderError } from "../src/index.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const text = 'export const fixture = "before";\n';
const base = {
  id: "web-api-status-authority" as const,
  version: 1 as const,
  repository: "Ether-X-UK/Vuzmi" as const,
  baseCommit: "a".repeat(40),
  files: [{ path: DEVELOPMENT_PATH, sha256: sha(text), text }],
  command: [...DEVELOPMENT_COMMAND],
  acceptanceHash: "b".repeat(64),
  lockfileHash: "c".repeat(64),
  baseImage: `sha256:${"d".repeat(64)}`,
  platform: "linux/arm64" as const,
  policyId: "owned-repository-offline-v1" as const,
};
const profile = {
  ...base,
  profileHash: sha(
    developmentProfileFingerprintInput(
      base as Omit<DevelopmentProfile, "profileHash">,
    ),
  ),
} as DevelopmentProfile;
const patch = {
  summary: "Correct the fixture without claiming execution.",
  files: [
    {
      path: DEVELOPMENT_PATH,
      beforeSha256: sha(text),
      content: 'export const fixture = "after";\n',
    },
  ],
};
function fixture(
  options: {
    content?: unknown;
    chat?: Record<string, unknown>;
    show?: Record<string, unknown>;
  } = {},
) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    if (path === "/api/tags")
      return Response.json({
        models: [
          {
            name: "fixture-local",
            model: "fixture-local",
            digest: "f".repeat(64),
            size: 100,
            details: { format: "gguf" },
          },
        ],
      });
    if (path === "/api/show")
      return Response.json(
        options.show ?? {
          details: { format: "gguf" },
          capabilities: ["completion", "thinking"],
          thinking: { values: [false, true] },
          model_info: {
            "general.architecture": "qwen3",
            "qwen3.context_length": 32768,
          },
        },
      );
    if (path === "/api/chat")
      return Response.json({
        model: "fixture-local",
        done: true,
        done_reason: "stop",
        message: {
          role: "assistant",
          content: options.content ?? JSON.stringify(patch),
        },
        prompt_eval_count: 100,
        eval_count: 200,
        total_duration: 5_000_000,
        ...options.chat,
      });
    throw Error("Unexpected request path");
  };
  return { fetcher, calls };
}
const input = {
  model: "fixture-local",
  title: "Fix owned fixture",
  brief: "Repair the session expiry task using the permitted file.",
  profile,
};
test("development generation uses local schema-constrained JSON and retains observed model identity/usage", async () => {
  const f = fixture();
  const result = await generateDevelopmentPatch({ ...input, fetch: f.fetcher });
  assert.deepEqual(result.patch, patch);
  assert.equal(result.modelDigest, "f".repeat(64));
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 200,
    durationMs: 5,
  });
  const chat = f.calls.find((x) => x.path === "/api/chat")!.body!;
  assert.equal(chat.stream, false);
  assert.equal(chat.think, false);
  assert.ok(chat.format && typeof chat.format === "object");
  assert.equal((chat.options as { temperature: number }).temperature, 0);
  const user = (chat.messages as { content: string }[])[1]!.content;
  assert.deepEqual(JSON.parse(user.split("\n\n")[0]!).permittedFile, {
    path: DEVELOPMENT_PATH,
    sha256: sha(text),
  });
  assert.ok(
    user.includes("\n```typescript\n" + text + "\n```"),
    "Pinned code must retain its readable line breaks rather than being JSON-escaped inside metadata.",
  );
  assert.ok(
    f.calls.every((x) =>
      ["/api/tags", "/api/show", "/api/chat"].includes(x.path),
    ),
  );
});
test("malformed, expanded, mismatched, incomplete or tool-bearing proposals are rejected", async () => {
  for (const content of [
    "```json\n" + JSON.stringify(patch) + "\n```",
    "{}",
    JSON.stringify({ ...patch, command: "execute" }),
    JSON.stringify({
      ...patch,
      files: [{ ...patch.files[0], path: "package.json" }],
    }),
    JSON.stringify({
      ...patch,
      files: [{ ...patch.files[0], beforeSha256: "0".repeat(64) }],
    }),
  ]) {
    const f = fixture({ content });
    await assert.rejects(
      generateDevelopmentPatch({ ...input, fetch: f.fetcher }),
      (e) => e instanceof ProviderError && e.code === "INVALID_RESPONSE",
    );
  }
  for (const chat of [
    { done_reason: "length" },
    {
      message: {
        role: "assistant",
        content: JSON.stringify(patch),
        tool_calls: [{ name: "exec" }],
      },
    },
    { remote_host: "https://cloud.invalid" },
  ]) {
    const f = fixture({ chat });
    await assert.rejects(
      generateDevelopmentPatch({ ...input, fetch: f.fetcher }),
      ProviderError,
    );
  }
});
test("cloud aliases, unsupported metadata and insufficient context cannot reach code inference", async () => {
  const remote = fixture();
  await assert.rejects(
    generateDevelopmentPatch({
      ...input,
      model: "fixture:cloud",
      fetch: remote.fetcher,
    }),
    ProviderError,
  );
  assert.equal(remote.calls.length, 0);
  for (const show of [
    { remote_host: "https://cloud.invalid", capabilities: ["completion"] },
    {
      details: { format: "gguf" },
      capabilities: ["completion"],
      model_info: {
        "general.architecture": "qwen3",
        "qwen3.context_length": 2048,
      },
    },
  ]) {
    const f = fixture({ show });
    await assert.rejects(
      generateDevelopmentPatch({ ...input, fetch: f.fetcher }),
      ProviderError,
    );
    assert.equal(
      f.calls.some((x) => x.path === "/api/chat"),
      false,
    );
  }
});
test("retagging the local model during inference discards the code proposal", async () => {
  const f = fixture();
  let generated = false;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/tags" && generated)
      return Response.json({
        models: [
          {
            name: "fixture-local",
            model: "fixture-local",
            digest: "e".repeat(64),
            size: 100,
            details: { format: "gguf" },
          },
        ],
      });
    const response = await f.fetcher(url, init);
    if (path === "/api/chat") generated = true;
    return response;
  };
  await assert.rejects(
    generateDevelopmentPatch({ ...input, fetch: fetcher }),
    (e) => e instanceof ProviderError && e.code === "MODEL_CHANGED",
  );
});
