import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSimulationRun, decideRun } from "@vuzmi/core";
import { NativeApi, NativeApiError, normalizeBackendUrl } from "../src/api";

const now = "2026-11-04T12:00:00.000Z";
function fixture() {
  return createSimulationRun(
    {
      title: "Owned approval fixture",
      brief:
        "Prepare a local-only test artifact for native contract verification.",
      domain: "build",
    },
    {
      id: "native-test-run",
      now,
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
    },
  );
}

test("native endpoint validation permits loopback origins and rejects remote or credential-bearing URLs", () => {
  assert.equal(
    normalizeBackendUrl(" http://127.0.0.1:4310/ "),
    "http://127.0.0.1:4310",
  );
  assert.equal(
    normalizeBackendUrl("http://localhost:4311"),
    "http://localhost:4311",
  );
  assert.equal(normalizeBackendUrl("http://[::1]:4310"), "http://[::1]:4310");
  for (const value of [
    "https://example.com",
    "http://192.168.1.10:4310",
    "http://127.0.0.1.evil.example:4310",
    "http://user:secret@localhost:4310",
    "http://localhost:4310/v1",
    "http://localhost:4310?token=secret",
    "file:///tmp/workspace",
  ]) {
    assert.throws(() => normalizeBackendUrl(value), NativeApiError);
  }
});

test("native approval sends the displayed fingerprint and revision and accepts only the persisted server result", async (context) => {
  const run = fixture();
  const input = {
    decision: "approve" as const,
    fingerprint: run.proposal.fingerprint,
    revision: run.revision,
  };
  const saved = decideRun(run, input, now);
  let captured: { url: string; init?: RequestInit } | undefined;
  context.mock.method(
    globalThis,
    "fetch",
    async (url: string, init?: RequestInit) => {
      captured = { url: String(url), init };
      return Response.json({ run: saved });
    },
  );
  const api = new NativeApi("http://127.0.0.1:4310", async () => ({
    "X-Native-Contract": "test",
    Cookie: "owned-fixture-session",
    Origin: "vuzmi://",
  }));
  const result = await api.decide(run, "approve");
  assert.equal(
    captured?.url,
    "http://127.0.0.1:4310/v1/runs/native-test-run/decisions",
  );
  assert.deepEqual(JSON.parse(String(captured?.init?.body)), input);
  assert.equal(
    (captured?.init?.headers as Record<string, string>)["X-Native-Contract"],
    "test",
  );
  assert.equal(
    (captured?.init?.headers as Record<string, string>).Cookie,
    "owned-fixture-session",
  );
  assert.equal(
    (captured?.init?.headers as Record<string, string>).Origin,
    "vuzmi://",
  );
  assert.equal(captured?.init?.credentials, "omit");
  assert.equal(captured?.init?.redirect, "error");
  assert.equal(result.status, "completed");
  assert.equal(result.artifact?.content, run.proposal.content);
});

test("a stale approval is a visible conflict, never a local success", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: "STALE_APPROVAL",
          message: "Refresh and review the changed proposal.",
        },
      },
      { status: 409 },
    ),
  );
  const api = new NativeApi("http://localhost:4310");
  await assert.rejects(
    api.decide(fixture(), "approve"),
    (error: unknown) =>
      error instanceof NativeApiError &&
      error.status === 409 &&
      error.code === "STALE_APPROVAL",
  );
});

test("a run without a proposal cannot make a native decision request", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return Response.json({});
  });
  const run = {
    ...fixture(),
    mode: "ollama" as const,
    status: "queued" as const,
    proposal: null,
  };
  await assert.rejects(
    new NativeApi("http://localhost:4310").decide(run, "reject"),
    (error: unknown) =>
      error instanceof NativeApiError && error.code === "INVALID_STATE",
  );
  assert.equal(requests, 0);
});

test("owner state is validated before the native app can treat it as a session", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ mode: "owner", setupNeeded: false, user: null }),
  );
  assert.deepEqual(await new NativeApi("http://localhost:4310").authState(), {
    mode: "owner",
    setupNeeded: false,
    user: null,
  });
});

test("unauthorised business requests do not retry through a development endpoint", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return Response.json(
      { error: { code: "AUTH_REQUIRED", message: "Sign in." } },
      { status: 401 },
    );
  });
  await assert.rejects(
    new NativeApi("http://localhost:4310").workspace(),
    (error: unknown) => error instanceof NativeApiError && error.status === 401,
  );
  assert.equal(requests, 1);
});
