import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/api";
import { developmentRequest } from "../src/developmentApi";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function clock() {
  let fire = () => {},
    cancelled = false;
  return {
    scheduleDeadline(expire: () => void) {
      fire = expire;
      return () => {
        cancelled = true;
      };
    },
    expire() {
      if (!cancelled) fire();
    },
    get cancelled() {
      return cancelled;
    },
  };
}
const errorCode =
  (code: string, status = 0) =>
  (cause: unknown) =>
    cause instanceof ApiError && cause.code === code && cause.status === status;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("hard deadline releases a fetch that ignores its abort signal and retires late 401 headers", async () => {
  const late = deferred<Response>(),
    timer = clock();
  let expired = 0,
    signal: AbortSignal | null = null,
    parsed = false;
  const result = developmentRequest(
    "/runtime",
    undefined,
    () => {
      parsed = true;
    },
    {
      fetcher: async (_url, init) => {
        signal = init!.signal as AbortSignal;
        return late.promise;
      },
      expireSession: () => {
        expired += 1;
      },
      scheduleDeadline: timer.scheduleDeadline,
    },
  );
  const rejected = assert.rejects(result, errorCode("TIMEOUT"));
  timer.expire();
  await rejected;
  assert.equal(signal!.aborted, true);
  assert.equal(timer.cancelled, true);
  late.resolve(new Response("{}", { status: 401 }));
  await flush();
  assert.equal(expired, 0);
  assert.equal(parsed, false);
});

test("401 authority precedes a stalled body, expires once and still reaches the hard deadline", async () => {
  const body = deferred<string>(),
    timer = clock(),
    order: string[] = [];
  let parsed = false;
  const response = {
    status: 401,
    ok: false,
    text: () => {
      order.push("body");
      return body.promise;
    },
  } as Response;
  const result = developmentRequest(
    "/runtime",
    undefined,
    () => {
      parsed = true;
    },
    {
      fetcher: async () => response,
      expireSession: () => {
        order.push("expired");
      },
      scheduleDeadline: timer.scheduleDeadline,
    },
  );
  await flush();
  assert.deepEqual(order, ["expired", "body"]);
  const rejected = assert.rejects(result, errorCode("TIMEOUT"));
  timer.expire();
  await rejected;
  body.resolve("{}");
  await flush();
  assert.deepEqual(order, ["expired", "body"]);
  assert.equal(parsed, false);
});

test("readable and malformed 401 bodies retain status and emit expiry exactly once per response", async () => {
  for (const content of [
    JSON.stringify({
      error: { code: "OWNER_REQUIRED", message: "Sign in again." },
    }),
    "<unreadable>",
  ]) {
    const timer = clock();
    let expired = 0;
    await assert.rejects(
      developmentRequest("/runtime", undefined, JSON.parse, {
        fetcher: async () => new Response(content, { status: 401 }),
        expireSession: () => {
          expired += 1;
        },
        scheduleDeadline: timer.scheduleDeadline,
      }),
      (cause: unknown) => cause instanceof ApiError && cause.status === 401,
    );
    assert.equal(expired, 1);
    assert.equal(timer.cancelled, true);
  }
});

test("an unreadable non-401 body is an HTTP failure without session expiry", async () => {
  const timer = clock();
  let expired = 0;
  await assert.rejects(
    developmentRequest("/runtime", undefined, JSON.parse, {
      fetcher: async () => new Response("<offline>", { status: 503 }),
      expireSession: () => {
        expired += 1;
      },
      scheduleDeadline: timer.scheduleDeadline,
    }),
    errorCode("REQUEST_FAILED", 503),
  );
  assert.equal(expired, 0);
});

test("deadline covers response reading and asynchronous package validation", async () => {
  const body = deferred<string>(),
    timer = clock();
  let parsed = false;
  const result = developmentRequest(
    "/fixture/package",
    undefined,
    () => {
      parsed = true;
      return {};
    },
    {
      fetcher: async () =>
        ({ status: 200, ok: true, text: () => body.promise }) as Response,
      scheduleDeadline: timer.scheduleDeadline,
    },
  );
  await flush();
  const rejected = assert.rejects(result, errorCode("TIMEOUT"));
  timer.expire();
  await rejected;
  body.resolve("{}");
  await flush();
  assert.equal(parsed, false);

  const validation = deferred<object>(),
    validationClock = clock();
  const validating = developmentRequest(
    "/fixture/package",
    undefined,
    () => validation.promise,
    {
      fetcher: async () => new Response("{}"),
      scheduleDeadline: validationClock.scheduleDeadline,
    },
  );
  await flush();
  const rejectedValidation = assert.rejects(validating, errorCode("TIMEOUT"));
  validationClock.expire();
  await rejectedValidation;
  validation.resolve({});
  await flush();
});

test("explicit cancellation settles immediately and late ignored-abort headers cannot expire a replacement session", async () => {
  const controller = new AbortController(),
    late = deferred<Response>(),
    timer = clock();
  let expired = 0;
  const result = developmentRequest(
    "/runtime",
    { signal: controller.signal },
    JSON.parse,
    {
      fetcher: async () => late.promise,
      expireSession: () => {
        expired += 1;
      },
      scheduleDeadline: timer.scheduleDeadline,
    },
  );
  const rejected = assert.rejects(result, errorCode("ABORTED"));
  controller.abort();
  await rejected;
  late.resolve(new Response("{}", { status: 401 }));
  await flush();
  assert.equal(expired, 0);
  assert.equal(timer.cancelled, true);
});

test("raw package bytes survive parsing; fixed origin and request payload are retained", async () => {
  const timer = clock(),
    content = '{\r\n  "local": true\r\n}\r\n';
  let input: RequestInfo | URL | undefined, init: RequestInit | undefined;
  const result = await developmentRequest(
    "/fixture/package",
    { method: "POST", body: '{"requestId":"same-identity"}' },
    (text) => ({ text, parsed: JSON.parse(text) }),
    {
      fetcher: async (url, options) => {
        input = url;
        init = options;
        return new Response(content);
      },
      scheduleDeadline: timer.scheduleDeadline,
    },
  );
  assert.equal(result.text, content);
  assert.deepEqual(result.parsed, { local: true });
  assert.equal(input, "/v1/development/fixture/package");
  assert.equal(init?.credentials, "same-origin");
  assert.equal(init?.body, '{"requestId":"same-identity"}');
  assert.equal(timer.cancelled, true);
});

test("network and successful-body validation failures remain distinct structured errors", async () => {
  const timer = clock();
  await assert.rejects(
    developmentRequest("/runtime", undefined, JSON.parse, {
      fetcher: async () => {
        throw new TypeError("offline");
      },
      scheduleDeadline: timer.scheduleDeadline,
    }),
    errorCode("CONNECTION_FAILED"),
  );
  const otherTimer = clock();
  await assert.rejects(
    developmentRequest(
      "/runtime",
      undefined,
      () => {
        throw new Error("invalid schema");
      },
      {
        fetcher: async () => new Response("{}"),
        scheduleDeadline: otherTimer.scheduleDeadline,
      },
    ),
    errorCode("INVALID_RESPONSE"),
  );
});
