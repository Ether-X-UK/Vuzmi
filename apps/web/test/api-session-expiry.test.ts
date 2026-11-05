import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ApiError, request } from "../src/api.js";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let expired = 0;

beforeEach(() => {
  expired = 0;
  const target = new EventTarget();
  target.addEventListener("vuzmi:session-expired", () => expired++);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("an unreadable 401 invalidates the session before body decoding", async () => {
  globalThis.fetch = async () => {
    const response = new Response(null, { status: 401 });
    response.json = async () => {
      assert.equal(expired, 1);
      throw new Error("Unreadable fixture body");
    };
    return response;
  };
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(expired, 1);
});

test("a malformed 401 invalidates the session exactly once", async () => {
  globalThis.fetch = async () => new Response("{", { status: 401 });
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(expired, 1);
});

test("a stalled 401 body cannot postpone session invalidation", async () => {
  let decoding!: () => void;
  let finishBody!: (value: unknown) => void;
  const started = new Promise<void>((resolve) => {
    decoding = resolve;
  });
  const body = new Promise<unknown>((resolve) => {
    finishBody = resolve;
  });
  globalThis.fetch = async () => {
    const response = new Response(null, { status: 401 });
    response.json = () => {
      decoding();
      return body;
    };
    return response;
  };
  const rejected = assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "AUTH_REQUIRED");
    return true;
  });
  try {
    await started;
    assert.equal(expired, 1, "Do not wait for the 401 response body to finish");
  } finally {
    finishBody({ error: { code: "AUTH_REQUIRED", message: "Sign in" } });
    await rejected;
  }
  assert.equal(expired, 1);
});

test("a readable 401 preserves its structured error and expires once", async () => {
  globalThis.fetch = async () =>
    Response.json(
      { error: { code: "AUTH_REQUIRED", message: "Fixture sign-in required" } },
      { status: 401 },
    );
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.message, "Fixture sign-in required");
    return true;
  });
  assert.equal(expired, 1);
});

test("unreadable non-401 failures do not invalidate the session", async () => {
  globalThis.fetch = async () => new Response("{", { status: 503 });
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(expired, 0);
});

test("successful JSON is preserved without invalidating the session", async () => {
  globalThis.fetch = async () => Response.json({ fixture: "preserved" });
  assert.deepEqual(await request("/fixture"), { fixture: "preserved" });
  assert.equal(expired, 0);
});

test("connection failure remains distinct from session expiry", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Fixture offline");
  };
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.equal(error.code, "CONNECTION_FAILED");
    return true;
  });
  assert.equal(expired, 0);
});
