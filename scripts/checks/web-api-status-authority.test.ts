import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ApiError, request } from "/opt/vuzmi/repository/apps/web/src/api.ts";

// This sealed harness is provisioned outside the model-editable repository.
// It makes no network requests: fetch and the browser event target are fixtures.
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

test("unreadable 401 expires the session before body parsing", async () => {
  globalThis.fetch = async () =>
    ({
      status: 401,
      ok: false,
      json: async () => {
        assert.equal(expired, 1, "HTTP status must invalidate before decoding");
        throw new SyntaxError("unreadable fixture");
      },
    }) as Response;
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(expired, 1);
});

test("malformed 401 expires the session before body parsing", async () => {
  globalThis.fetch = async () => new Response("{", { status: 401 });
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(expired, 1);
});

test("readable 401 expires the session once", async () => {
  globalThis.fetch = async () =>
    Response.json(
      { error: { code: "AUTH_REQUIRED", message: "Fixture sign-in required" } },
      { status: 401 },
    );
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "AUTH_REQUIRED");
    return true;
  });
  assert.equal(expired, 1);
});

test("unreadable non-401 does not expire the session", async () => {
  globalThis.fetch = async () => new Response("{", { status: 503 });
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(expired, 0);
});

test("successful JSON response is preserved", async () => {
  globalThis.fetch = async () => Response.json({ fixture: "preserved" });
  assert.deepEqual(await request("/fixture"), { fixture: "preserved" });
  assert.equal(expired, 0);
});

test("connection failure stays distinct from session expiry", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("unreachable fixture");
  };
  await assert.rejects(request("/fixture"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 0);
    assert.equal(error.code, "CONNECTION_FAILED");
    return true;
  });
  assert.equal(expired, 0);
});
