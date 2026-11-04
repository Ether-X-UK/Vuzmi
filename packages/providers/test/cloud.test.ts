import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_CONTRACT_LIMITS,
  CloudProviderError,
  generateClaudeText,
  generateOpenAIText,
} from "../src/cloud.js";
import type { CloudProviderErrorCode } from "../src/cloud.js";

// Synthetic values; these tests do not read environment credentials or call a network.
const input = {
  model: "configured-model",
  instructions: "Draft a concise release note.",
  input: "This release is unverified.",
  apiKey: "fixture-credential",
  allowRemoteExecution: true,
};
const openai = {
  status: "completed",
  model: "configured-model-snapshot",
  usage: { input_tokens: 12, output_tokens: 8 },
  output: [
    {
      type: "reasoning",
      encrypted_content: "OPAQUE PRIVATE REASONING",
      summary: [],
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "First text block." },
        { type: "output_text", text: "Second text block." },
      ],
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Third text block." }],
    },
  ],
};
const claude = {
  type: "message",
  role: "assistant",
  model: "configured-model-snapshot",
  stop_reason: "end_turn",
  usage: {
    input_tokens: 12,
    output_tokens: 8,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 2,
  },
  content: [
    { type: "thinking", thinking: "OPAQUE PRIVATE REASONING" },
    { type: "text", text: "First text block." },
    { type: "redacted_thinking", data: "OPAQUE" },
    { type: "text", text: "Second text block." },
  ],
};
type Seen = { url: string; init: RequestInit; body: Record<string, unknown> };
function fixture(value: unknown) {
  const calls: Seen[] = [];
  const fetcher: typeof fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Response.json(value);
  };
  return { calls, fetcher };
}
function code(expected: CloudProviderErrorCode, retryable?: boolean) {
  return (error: unknown) =>
    error instanceof CloudProviderError &&
    error.code === expected &&
    (retryable === undefined || retryable === error.retryable);
}

test("cloud requests remain disabled before fetch even with a credential", async () => {
  for (const generate of [generateOpenAIText, generateClaudeText]) {
    const { fetcher, calls } = fixture({});
    await assert.rejects(
      generate({ ...input, allowRemoteExecution: undefined, fetch: fetcher }),
      code("REMOTE_EXECUTION_DISABLED"),
    );
    await assert.rejects(
      generate({
        ...input,
        model: "",
        apiKey: undefined,
        allowRemoteExecution: false,
        fetch: fetcher,
      }),
      code("REMOTE_EXECUTION_DISABLED"),
    );
    assert.equal(calls.length, 0);
    await assert.rejects(
      generate(input),
      code("INVALID_CONFIGURATION"),
      "even allowed execution has no implicit network transport",
    );
  }
});

test("Responses request uses the native API-key contract and aggregates every text block", async () => {
  const { fetcher, calls } = fixture(openai);
  const result = await generateOpenAIText({ ...input, fetch: fetcher });
  assert.deepEqual(result, {
    provider: "openai",
    model: "configured-model-snapshot",
    content: "First text block.\n\nSecond text block.\n\nThird text block.",
    usage: { inputTokens: 12, outputTokens: 8, durationMs: null },
  });
  assert.doesNotMatch(result.content, /OPAQUE|REASONING/);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.deepEqual(call.body, {
    model: input.model,
    instructions: input.instructions,
    input: [{ role: "user", content: input.input }],
    store: false,
    stream: false,
    max_output_tokens: 2048,
  });
  assert.equal(
    (call.init.headers as Record<string, string>).Authorization,
    "Bearer fixture-credential",
  );
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  assert.equal("tools" in call.body, false);
});

test("Messages request pins the supported version and omits removed sampling fields", async () => {
  const { fetcher, calls } = fixture(claude);
  const result = await generateClaudeText({
    ...input,
    fetch: fetcher,
    workspaceId: "wrkspc_fixture123",
    maxOutputTokens: 1024,
  });
  assert.deepEqual(result, {
    provider: "anthropic",
    model: "configured-model-snapshot",
    content: "First text block.\n\nSecond text block.",
    usage: { inputTokens: 18, outputTokens: 8, durationMs: null },
  });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(calls[0].body, {
    model: input.model,
    system: input.instructions,
    messages: [{ role: "user", content: input.input }],
    max_tokens: 1024,
    stream: false,
  });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["anthropic-version"], "2026-10-21");
  assert.equal(headers["anthropic-workspace-id"], "wrkspc_fixture123");
  assert.equal(headers.Authorization, "Bearer fixture-credential");
  for (const field of ["temperature", "top_p", "top_k", "tools"])
    assert.equal(field in calls[0].body, false);
});

test("incomplete, refused, tool and malformed Responses outputs never become completed text", async () => {
  for (const [value, expected] of [
    [{ ...openai, status: "incomplete" }, "INCOMPLETE_OUTPUT"],
    [
      {
        ...openai,
        status: "failed",
        error: { message: "SECRET OPAQUE ERROR" },
      },
      "REQUEST_REJECTED",
    ],
    [
      {
        ...openai,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "PRIVATE" }],
          },
        ],
      },
      "REFUSED",
    ],
    [
      { ...openai, output: [{ type: "function_call", name: "send_email" }] },
      "UNSUPPORTED_RESPONSE",
    ],
    [{ ...openai, output: [] }, "INVALID_RESPONSE"],
    [
      { ...openai, output: [{ type: "reasoning", summary: "OPAQUE" }] },
      "INVALID_RESPONSE",
    ],
    [
      {
        ...openai,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: 99 }],
          },
        ],
      },
      "INVALID_RESPONSE",
    ],
    [{ ...openai, usage: {}, model: null }, "INVALID_RESPONSE"],
    [{ ...openai, status: "in_progress" }, "INVALID_RESPONSE"],
  ] as const) {
    await assert.rejects(
      generateOpenAIText({ ...input, fetch: fixture(value).fetcher }),
      (error: unknown) => {
        assert.ok(code(expected)(error));
        assert.doesNotMatch(String(error), /SECRET|OPAQUE|PRIVATE/);
        return true;
      },
    );
  }
});

test("Messages truncation, refusal, tool calls and incomplete turns are explicit failures", async () => {
  for (const [value, expected] of [
    [{ ...claude, stop_reason: "max_tokens" }, "INCOMPLETE_OUTPUT"],
    [
      { ...claude, stop_reason: "model_context_window_exceeded" },
      "INCOMPLETE_OUTPUT",
    ],
    [{ ...claude, stop_reason: "refusal" }, "REFUSED"],
    [{ ...claude, stop_reason: "tool_use" }, "UNSUPPORTED_RESPONSE"],
    [{ ...claude, stop_reason: "pause_turn" }, "UNSUPPORTED_RESPONSE"],
    [
      { ...claude, content: [{ type: "tool_use", name: "send_email" }] },
      "UNSUPPORTED_RESPONSE",
    ],
    [{ ...claude, content: [] }, "INVALID_RESPONSE"],
    [{ ...claude, role: "user" }, "INVALID_RESPONSE"],
  ] as const) {
    await assert.rejects(
      generateClaudeText({ ...input, fetch: fixture(value).fetcher }),
      code(expected),
    );
  }
});

test("missing or invalid usage remains unknown; cache usage is not silently omitted", async () => {
  const a = await generateOpenAIText({
    ...input,
    fetch: fixture({
      ...openai,
      usage: { input_tokens: "12", output_tokens: -1 },
    }).fetcher,
  });
  assert.deepEqual(a.usage, {
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
  });
  const b = await generateClaudeText({
    ...input,
    fetch: fixture({ ...claude, usage: { input_tokens: 0, output_tokens: 0 } })
      .fetcher,
  });
  assert.deepEqual(b.usage, {
    inputTokens: 0,
    outputTokens: 0,
    durationMs: null,
  });
  const c = await generateClaudeText({
    ...input,
    fetch: fixture({
      ...claude,
      usage: { input_tokens: 12, cache_read_input_tokens: -1 },
    }).fetcher,
  });
  assert.deepEqual(c.usage, {
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
  });
});

test("status and transport failures are sanitised without retrying or leaking opaque errors", async () => {
  for (const generate of [generateOpenAIText, generateClaudeText]) {
    for (const [status, expected, retryable] of [
      [400, "REQUEST_REJECTED", false],
      [401, "AUTHENTICATION_FAILED", false],
      [403, "AUTHENTICATION_FAILED", false],
      [429, "RATE_LIMITED", true],
      [503, "UNAVAILABLE", true],
      [302, "REQUEST_REJECTED", false],
    ] as const) {
      let calls = 0;
      const fetcher: typeof fetch = async () => {
        calls += 1;
        return Response.json(
          { error: "PRIVATE PROVIDER BODY fixture-credential" },
          { status },
        );
      };
      await assert.rejects(
        generate({ ...input, fetch: fetcher }),
        (error: unknown) => {
          assert.ok(code(expected, retryable)(error));
          assert.doesNotMatch(String(error), /PRIVATE|fixture-credential/);
          return true;
        },
      );
      assert.equal(calls, 1);
    }
    const fetcher: typeof fetch = async () => {
      throw new Error("PRIVATE PROMPT fixture-credential");
    };
    await assert.rejects(
      generate({ ...input, fetch: fetcher }),
      (error: unknown) => {
        assert.ok(code("UNAVAILABLE", true)(error));
        assert.doesNotMatch(String(error), /PRIVATE|fixture-credential/);
        return true;
      },
    );
  }
});

test("input/configuration bounds reject before fixture transport", async () => {
  for (const generate of [generateOpenAIText, generateClaudeText]) {
    for (const changes of [
      { model: "" },
      { input: "" },
      { instructions: "" },
      { input: "x".repeat(CLOUD_CONTRACT_LIMITS.maxInputBytes + 1) },
    ]) {
      const { fetcher, calls } = fixture({});
      await assert.rejects(
        generate({ ...input, ...changes, fetch: fetcher }),
        code("INVALID_INPUT"),
      );
      assert.equal(calls.length, 0);
    }
    for (const changes of [
      { apiKey: "" },
      { apiKey: "secret\nheader" },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 4097 },
      { timeoutMs: 0 },
      { timeoutMs: 180001 },
    ]) {
      await assert.rejects(
        generate({ ...input, ...changes, fetch: fixture({}).fetcher }),
        code("INVALID_CONFIGURATION"),
      );
    }
  }
  await assert.rejects(
    generateClaudeText({
      ...input,
      workspaceId: "not-a-workspace",
      fetch: fixture({}).fetcher,
    }),
    code("INVALID_CONFIGURATION"),
  );
});

test("timeouts and caller cancellation stop waiting even for an inert injected fetch", async () => {
  const never: typeof fetch = async () =>
    new Promise<Response>(() => undefined);
  for (const generate of [generateOpenAIText, generateClaudeText]) {
    await assert.rejects(
      generate({ ...input, fetch: never, timeoutMs: 5 }),
      code("TIMEOUT", true),
    );
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE ABORT REASON"));
    await assert.rejects(
      generate({ ...input, fetch: never, signal: controller.signal }),
      (error: unknown) => {
        assert.ok(code("ABORTED", false)(error));
        assert.doesNotMatch(String(error), /PRIVATE ABORT REASON/);
        return true;
      },
    );
  }
  const active = new AbortController();
  let wasAborted = false;
  const activeFetch: typeof fetch = async (_url, options) => {
    options?.signal?.addEventListener(
      "abort",
      () => {
        wasAborted = true;
      },
      { once: true },
    );
    active.abort();
    return new Promise<Response>(() => undefined);
  };
  await assert.rejects(
    generateOpenAIText({ ...input, fetch: activeFetch, signal: active.signal }),
    code("ABORTED"),
  );
  assert.equal(wasAborted, true);
  const stalledBody: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  await assert.rejects(
    generateClaudeText({ ...input, fetch: stalledBody, timeoutMs: 5 }),
    code("TIMEOUT"),
  );
});

test("response bytes and generated text stay bounded without accepting partial text", async () => {
  const oversized: typeof fetch = async () =>
    new Response("x".repeat(CLOUD_CONTRACT_LIMITS.maxResponseBytes + 1), {
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    generateOpenAIText({ ...input, fetch: oversized }),
    code("RESPONSE_TOO_LARGE"),
  );
  const invalid: typeof fetch = async () =>
    new Response("SECRET NOT JSON", {
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(
    generateClaudeText({ ...input, fetch: invalid }),
    (error: unknown) => {
      assert.ok(code("INVALID_RESPONSE")(error));
      assert.doesNotMatch(String(error), /SECRET NOT JSON/);
      return true;
    },
  );
  const output = {
    ...openai,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "x".repeat(CLOUD_CONTRACT_LIMITS.maxOutputCharacters + 1),
          },
        ],
      },
    ],
  };
  await assert.rejects(
    generateOpenAIText({ ...input, fetch: fixture(output).fetcher }),
    code("INCOMPLETE_OUTPUT"),
  );
});
