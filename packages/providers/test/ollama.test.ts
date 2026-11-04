import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateReleaseBrief,
  listLocalModels,
  OLLAMA_LIMITS,
  ProviderError,
} from "../src/index.js";
import type { ProviderErrorCode } from "../src/index.js";

const name = "local-writer:latest";
const summary = {
  name,
  model: name,
  digest: "a".repeat(64),
  size: 2_000_000_000,
  details: { format: "gguf" },
};
const metadata = {
  details: {
    format: "gguf",
    parameter_size: "3B",
    quantization_level: "Q4_K_M",
  },
  capabilities: ["completion", "thinking"],
  thinking: { values: [false, true], default: true },
  model_info: {
    "general.architecture": "qwen3",
    "qwen3.context_length": 32768,
  },
};
const request = {
  model: name,
  title: "Prepare Vuzmi release",
  brief: "Draft a release package from the supplied founder brief.",
  domain: "build" as const,
};
const chat = {
  model: name,
  done: true,
  done_reason: "stop",
  message: {
    role: "assistant",
    content: "## Scope\nPrepare a reviewable release draft.",
    thinking: "PRIVATE REASONING",
  },
  prompt_eval_count: 120,
  eval_count: 45,
  total_duration: 12_500_000,
};

type Seen = {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
};
function fixture(
  overrides: {
    tags?: unknown;
    show?: unknown;
    chat?: unknown;
    respond?: (seen: Seen) => Response | Promise<Response> | undefined;
  } = {},
) {
  const calls: Seen[] = [];
  const fetcher: typeof fetch = async (url, init = {}) => {
    const seen = {
      url: String(url),
      init,
      body: init.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined,
    };
    calls.push(seen);
    const response = overrides.respond?.(seen);
    if (response) return response;
    const path = new URL(seen.url).pathname;
    if (path === "/api/tags")
      return Response.json(overrides.tags ?? { models: [summary] });
    if (path === "/api/show") return Response.json(overrides.show ?? metadata);
    if (path === "/api/chat") return Response.json(overrides.chat ?? chat);
    throw new Error("Unexpected fixture request");
  };
  return { fetcher, calls };
}

function errorCode(code: ProviderErrorCode, retryable?: boolean) {
  return (error: unknown): boolean =>
    error instanceof ProviderError &&
    error.code === code &&
    (retryable === undefined || error.retryable === retryable);
}

test("discovers only metadata-verified local generation models", async () => {
  const { fetcher, calls } = fixture({
    tags: {
      models: [
        summary,
        {
          ...summary,
          name: "remote-alias:latest",
          model: "remote-alias:latest",
          remote_host: "https://ollama.com",
          remote_model: "cloud-writer",
        },
        { ...summary, name: "writer:cloud", model: "writer:cloud" },
        {
          ...summary,
          name: "writer-cloud:latest",
          model: "writer-cloud:latest",
        },
      ],
    },
  });
  const models = await listLocalModels({ fetch: fetcher });
  assert.deepEqual(models, [
    {
      name,
      digest: summary.digest,
      sizeBytes: summary.size,
      parameterSize: "3B",
      quantization: "Q4_K_M",
      capabilities: ["completion", "thinking"],
      contextLength: 32768,
    },
  ]);
  assert.equal(
    calls.length,
    2,
    "cloud/remote entries are excluded before any show request",
  );
  assert.equal(calls[1].body?.verbose, false);
});

test("renamed remote metadata and non-generative/local-evidence-free models are excluded", async () => {
  for (const show of [
    { ...metadata, remote_host: "https://ollama.com" },
    { ...metadata, remote_model: "upstream" },
    {
      ...metadata,
      details: { ...metadata.details, remote_host: "https://ollama.com" },
    },
    { ...metadata, capabilities: ["embedding"] },
    { ...metadata, details: { format: "" } },
    { ...metadata, model_info: {} },
  ]) {
    assert.deepEqual(
      await listLocalModels({ fetch: fixture({ show }).fetcher }),
      [],
    );
  }
});

test("native chat is bounded, disables supported thinking and reports observed usage", async () => {
  const { fetcher, calls } = fixture();
  const result = await generateReleaseBrief({ ...request, fetch: fetcher });
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    outputTokens: 45,
    durationMs: 12.5,
  });
  assert.match(result.content, /^> Local Ollama draft — unverified/);
  assert.match(result.content, /## Scope/);
  assert.doesNotMatch(result.content, /PRIVATE REASONING|LOCAL SIMULATION/);
  const sent = calls.find((call) => call.url.endsWith("/api/chat"))!;
  assert.equal(sent.body?.model, name);
  assert.equal(sent.body?.stream, false);
  assert.equal(sent.body?.think, false);
  assert.deepEqual(sent.body?.options, {
    num_ctx: 8192,
    num_predict: 2048,
    temperature: 0.3,
  });
  assert.equal(sent.body?.tools, undefined);
  assert.match(
    JSON.stringify(sent.body?.messages),
    /Never claim checks passed/,
  );
  for (const call of calls) {
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "omit");
    assert.equal(new URL(call.url).hostname, "127.0.0.1");
    assert.equal(
      (call.init.headers as Record<string, string>).Authorization,
      undefined,
    );
  }
});

test("uses supported think false only; ignores separate thinking and strips inline think blocks", async () => {
  const { fetcher, calls } = fixture({
    show: {
      ...metadata,
      thinking: { values: ["low", "high"], default: "low" },
    },
    chat: {
      ...chat,
      message: {
        ...chat.message,
        content:
          "<think>PRIVATE INLINE</think>\n```markdown\n## Scope\nUnverified draft.\n```",
      },
    },
  });
  const result = await generateReleaseBrief({ ...request, fetch: fetcher });
  assert.equal(calls.at(-1)?.body?.think, undefined);
  assert.doesNotMatch(result.content, /PRIVATE|```/);
  assert.match(result.content, /## Scope/);
});

test("accepts registry-qualified models installed locally", async () => {
  const imported = "hf.co/unsloth/Qwen3.6-27B-GGUF:IQ4_XS";
  const { fetcher } = fixture({
    tags: { models: [{ ...summary, name: imported, model: imported }] },
    chat: { ...chat, model: imported },
  });
  assert.match(
    (
      await generateReleaseBrief({
        ...request,
        model: imported,
        fetch: fetcher,
      })
    ).content,
    /## Scope/,
  );
});

test("generation rejects cloud names before requesting metadata or sending a brief", async () => {
  for (const model of [
    "writer:cloud",
    "writer-cloud:latest",
    "vendor/writer:20b-cloud",
    "writer:CLOUD",
  ]) {
    const { fetcher, calls } = fixture();
    await assert.rejects(
      generateReleaseBrief({ ...request, model, fetch: fetcher }),
      errorCode("MODEL_NOT_LOCAL", false),
    );
    assert.equal(calls.length, 0);
  }
});

test("generation rechecks remote metadata and never sends the brief for remote aliases", async () => {
  for (const options of [
    { tags: { models: [{ ...summary, remote_host: "https://ollama.com" }] } },
    { show: { ...metadata, remote_model: "remote-backed-writer" } },
  ]) {
    const { fetcher, calls } = fixture(options);
    await assert.rejects(
      generateReleaseBrief({ ...request, fetch: fetcher }),
      errorCode("MODEL_NOT_LOCAL"),
    );
    assert.ok(calls.every((call) => !call.url.endsWith("/api/chat")));
    assert.ok(
      calls.every(
        (call) => !JSON.stringify(call.body ?? {}).includes(request.brief),
      ),
    );
  }
});

test("remote/credentialed/path-bearing endpoints are rejected without network calls", async () => {
  for (const baseUrl of [
    "https://ollama.com",
    "http://192.168.1.20:11434",
    "http://127.0.0.1.evil.test",
    "http://user:secret@127.0.0.1:11434",
    "http://127.0.0.1:11434/proxy",
    "http://127.0.0.1:11434?secret=yes",
    "file:///tmp/ollama",
    "http://127.0.0.1:0",
  ]) {
    const { fetcher, calls } = fixture();
    await assert.rejects(
      listLocalModels({ baseUrl, fetch: fetcher }),
      errorCode("INVALID_CONFIGURATION"),
    );
    assert.equal(calls.length, 0);
  }
  const allowed = fixture();
  await listLocalModels({
    baseUrl: "http://localhost:11434",
    fetch: allowed.fetcher,
  });
  assert.ok(
    allowed.calls.every((call) =>
      call.url.startsWith("http://127.0.0.1:11434/"),
    ),
  );
});

test("no redirects or hidden retries are followed", async () => {
  const { fetcher, calls } = fixture({
    respond: () =>
      new Response("opaque", {
        status: 302,
        headers: { Location: "https://ollama.com" },
      }),
  });
  await assert.rejects(
    listLocalModels({ fetch: fetcher }),
    errorCode("INVALID_CONFIGURATION"),
  );
  assert.equal(calls.length, 1);
});

test("missing models and service failures have clear sanitised error codes", async () => {
  const missing = fixture({ tags: { models: [] } });
  await assert.rejects(
    generateReleaseBrief({ ...request, fetch: missing.fetcher }),
    errorCode("MODEL_NOT_FOUND", false),
  );
  assert.equal(missing.calls.length, 1);
  for (const [status, code, retryable] of [
    [404, "MODEL_NOT_FOUND", false],
    [503, "UNAVAILABLE", true],
    [429, "RATE_LIMITED", true],
    [400, "REQUEST_REJECTED", false],
  ] as const) {
    const { fetcher } = fixture({
      respond: (seen) =>
        seen.url.endsWith("/api/show")
          ? Response.json({ error: "SECRET RAW PROVIDER BODY" }, { status })
          : undefined,
    });
    await assert.rejects(
      generateReleaseBrief({ ...request, fetch: fetcher }),
      (error: unknown) => {
        assert.ok(errorCode(code, retryable)(error));
        assert.doesNotMatch(String(error), /SECRET RAW PROVIDER BODY/);
        return true;
      },
    );
  }
  const fetcher: typeof fetch = async () => {
    throw new Error("SECRET PROMPT OR CREDENTIAL");
  };
  await assert.rejects(
    listLocalModels({ fetch: fetcher }),
    (error: unknown) => {
      assert.ok(errorCode("UNAVAILABLE", true)(error));
      assert.doesNotMatch(String(error), /SECRET PROMPT OR CREDENTIAL/);
      return true;
    },
  );
});

test("aborts before requests, during generation and on the bounded deadline", async () => {
  const stopped = new AbortController();
  stopped.abort(new Error("PRIVATE ABORT REASON"));
  const early = fixture();
  await assert.rejects(
    listLocalModels({ fetch: early.fetcher, signal: stopped.signal }),
    errorCode("ABORTED", false),
  );
  assert.equal(early.calls.length, 0);
  const never: typeof fetch = async () =>
    new Promise<Response>(() => undefined);
  await assert.rejects(
    listLocalModels({ fetch: never, timeoutMs: 10 }),
    errorCode("TIMEOUT", true),
  );
  const active = new AbortController();
  const pending = fixture({
    respond: (seen) =>
      seen.url.endsWith("/api/chat")
        ? new Promise<Response>(() => {
            active.abort(new Error("PRIVATE"));
          })
        : undefined,
  });
  await assert.rejects(
    generateReleaseBrief({
      ...request,
      fetch: pending.fetcher,
      signal: active.signal,
    }),
    errorCode("ABORTED", false),
  );
});

test("malformed metadata cannot become an eligible model", async () => {
  for (const tags of [
    {},
    { models: "not-an-array" },
    { models: [null] },
    { models: [{ ...summary, name: "bad name" }] },
    { models: [summary, summary] },
    { models: [{ ...summary, model: "other-name" }] },
  ]) {
    await assert.rejects(
      listLocalModels({ fetch: fixture({ tags }).fetcher }),
      errorCode("INVALID_RESPONSE"),
    );
  }
  const malformed = fixture({
    respond: () =>
      new Response("SECRET NOT JSON", {
        headers: { "Content-Type": "application/json" },
      }),
  });
  await assert.rejects(
    listLocalModels({ fetch: malformed.fetcher }),
    (error: unknown) => {
      assert.ok(errorCode("INVALID_RESPONSE")(error));
      assert.doesNotMatch(String(error), /SECRET NOT JSON/);
      return true;
    },
  );
});

test("rejects malformed, empty, incomplete, tool or mismatched generation responses", async () => {
  for (const value of [
    {},
    { ...chat, done: false },
    { ...chat, model: "different-model" },
    { ...chat, message: { role: "assistant", content: "" } },
    {
      ...chat,
      message: { role: "assistant", content: "<think>PRIVATE ONLY</think>" },
    },
    { ...chat, message: { role: "assistant", content: '{"not":"markdown"}' } },
    {
      ...chat,
      message: {
        ...chat.message,
        tool_calls: [{ function: { name: "send_mail" } }],
      },
    },
    { ...chat, error: "SECRET ERROR" },
  ]) {
    await assert.rejects(
      generateReleaseBrief({
        ...request,
        fetch: fixture({ chat: value }).fetcher,
      }),
      errorCode("INVALID_RESPONSE"),
    );
  }
  await assert.rejects(
    generateReleaseBrief({
      ...request,
      fetch: fixture({ chat: { ...chat, done_reason: "length" } }).fetcher,
    }),
    errorCode("INCOMPLETE_OUTPUT"),
  );
});

test("unknown usage remains null rather than an invented measurement", async () => {
  const result = await generateReleaseBrief({
    ...request,
    fetch: fixture({
      chat: {
        ...chat,
        prompt_eval_count: -1,
        eval_count: "45",
        total_duration: null,
      },
    }).fetcher,
  });
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
  });
});

test("bounds response bodies even when Content-Length is absent", async () => {
  const oversized = fixture({
    respond: () =>
      new Response("x".repeat(OLLAMA_LIMITS.maxResponseBytes + 1), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  await assert.rejects(
    listLocalModels({ fetch: oversized.fetcher }),
    errorCode("RESPONSE_TOO_LARGE"),
  );
});

test("input, context and timeout limits fail before an inference call", async () => {
  const invalid = fixture();
  await assert.rejects(
    generateReleaseBrief({ ...request, title: "", fetch: invalid.fetcher }),
    errorCode("INVALID_INPUT"),
  );
  assert.equal(invalid.calls.length, 0);
  const small = fixture({
    show: {
      ...metadata,
      model_info: {
        "general.architecture": "qwen3",
        "qwen3.context_length": 2048,
      },
    },
  });
  await assert.rejects(
    generateReleaseBrief({
      ...request,
      brief: "x".repeat(6000),
      fetch: small.fetcher,
    }),
    errorCode("INVALID_INPUT"),
  );
  assert.equal(small.calls.length, 2);
  for (const timeoutMs of [0, -1, 0.5, OLLAMA_LIMITS.maxTimeoutMs + 1]) {
    await assert.rejects(
      listLocalModels({ timeoutMs, fetch: invalid.fetcher }),
      errorCode("INVALID_CONFIGURATION"),
    );
  }
});
