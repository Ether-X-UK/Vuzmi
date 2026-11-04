import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { Run, WorkspaceSnapshot } from "@vuzmi/core";
import { buildApp } from "../src/app.js";
import { ProviderError } from "@vuzmi/providers";
import { STATE_FILE_NAME } from "../src/store.js";

const brief = {
  title: "Prepare Vuzmi release",
  brief:
    "Prepare a reviewable release readiness package for the first Vuzmi local simulation.",
  domain: "build",
};
const fixedNow = () => new Date("2026-11-04T20:00:00.000Z");

async function harness(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "vuzmi-api-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const app = await buildApp({ dataDir, now: fixedNow });
  t.after(async () => app.close());
  return { app, dataDir };
}

function decisionFor(run: Run, decision: "approve" | "reject" = "approve") {
  assert.ok(run.proposal);
  return {
    decision,
    fingerprint: run.proposal.fingerprint,
    revision: run.revision,
  };
}

test("new workspace is empty, explicitly simulated, and privately persisted", async (t) => {
  const { app, dataDir } = await harness(t);
  const response = await app.inject({ method: "GET", url: "/v1/workspace" });
  assert.equal(response.statusCode, 200);
  const snapshot = response.json<WorkspaceSnapshot>();
  assert.equal(snapshot.workspace.mode, "simulation");
  assert.equal(snapshot.workspace.cloudExecution, false);
  assert.deepEqual(snapshot.runs, []);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(dataDir, STATE_FILE_NAME))).mode & 0o777,
    0o600,
  );
});

test("runtime failure does not hide stored runs and live requests never fall back to simulation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "vuzmi-runtime-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  let discoveryCalls = 0;
  const app = await buildApp({
    dataDir,
    discoverModels: async () => {
      discoveryCalls += 1;
      throw new ProviderError(
        "UNAVAILABLE",
        "The local Ollama service could not be reached.",
        true,
      );
    },
  });
  t.after(async () => app.close());
  const blocked = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: { ...brief, mode: "ollama", model: "qwen3.5:4b" },
  });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error.code, "LIVE_NOT_CONFIGURED");
  assert.equal(discoveryCalls, 0);
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/v1/runs" })).json().runs,
    [],
  );
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: brief,
  });
  assert.equal(created.statusCode, 201);
  const observed = await app.inject({ method: "GET", url: "/v1/runtime" });
  assert.equal(observed.json().liveAvailable, false);
  assert.equal(observed.json().ollama.reachable, false);
  assert.equal(observed.json().worker.state, "not_configured");
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/workspace" })).json().runs
      .length,
    1,
  );
});

test("valid mission creates an inspectable simulation; invalid inputs create nothing", async (t) => {
  const { app } = await harness(t);
  const invalid = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: { title: "x", brief: "" },
  });
  assert.equal(invalid.statusCode, 400);
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: brief,
  });
  assert.equal(created.statusCode, 201);
  const run = created.json<{ run: Run }>().run;
  assert.equal(run.status, "waiting_approval");
  assert.equal(run.route.executed, false);
  assert.equal(run.route.model, null);
  assert.ok(run.proposal);
  assert.match(run.proposal.content, /LOCAL SIMULATION/);
  assert.equal(run.events.length, 3);
  const found = await app.inject({ method: "GET", url: `/v1/runs/${run.id}` });
  assert.deepEqual(found.json().run, run);
  const list = await app.inject({ method: "GET", url: "/v1/runs" });
  assert.equal(list.json().runs.length, 1);
});

test("approval saves exactly one artifact, replay is idempotent, and restart preserves it", async (t) => {
  const { app, dataDir } = await harness(t);
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: brief,
  });
  const original = created.json<{ run: Run }>().run;
  const request = {
    method: "POST" as const,
    url: `/v1/runs/${original.id}/decisions`,
    payload: decisionFor(original),
  };
  const responses = await Promise.all([
    app.inject(request),
    app.inject(request),
  ]);
  responses.forEach((response) => assert.equal(response.statusCode, 200));
  const decided = responses[0]!.json<{ run: Run }>().run;
  assert.equal(decided.status, "completed");
  assert.equal(decided.artifact?.content, original.proposal!.content);
  assert.equal(
    decided.events.filter((event) => event.type === "artifact.saved").length,
    1,
  );
  assert.deepEqual(responses[1]!.json().run, decided);
  const changedDecision = await app.inject({
    ...request,
    payload: decisionFor(original, "reject"),
  });
  assert.equal(changedDecision.statusCode, 409);
  await app.close();
  const reopened = await buildApp({ dataDir, now: fixedNow });
  t.after(async () => reopened.close());
  const restored = await reopened.inject({
    method: "GET",
    url: `/v1/runs/${original.id}`,
  });
  assert.deepEqual(restored.json().run, decided);
});

test("stale review is rejected; a valid rejection saves no artifact", async (t) => {
  const { app } = await harness(t);
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: brief,
  });
  const run = created.json<{ run: Run }>().run;
  const url = `/v1/runs/${run.id}/decisions`;
  for (const payload of [
    { ...decisionFor(run), revision: run.revision + 1 },
    { ...decisionFor(run), fingerprint: "0".repeat(64) },
  ]) {
    const stale = await app.inject({ method: "POST", url, payload });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "STALE_APPROVAL");
  }
  const rejected = await app.inject({
    method: "POST",
    url,
    payload: decisionFor(run, "reject"),
  });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().run.status, "cancelled");
  assert.equal(rejected.json().run.artifact, undefined);
  assert.equal(
    rejected
      .json()
      .run.events.some(
        (event: { type: string }) => event.type === "artifact.saved",
      ),
    false,
  );
});

test("concurrent mission writes all survive persistence and reopening", async (t) => {
  const { app, dataDir } = await harness(t);
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      app.inject({
        method: "POST",
        url: "/v1/runs",
        payload: { ...brief, title: `Release mission ${index}` },
      }),
    ),
  );
  responses.forEach((response) => assert.equal(response.statusCode, 201));
  const persisted = JSON.parse(
    await readFile(join(dataDir, STATE_FILE_NAME), "utf8"),
  ) as { runs: Run[] };
  assert.equal(persisted.runs.length, 12);
  assert.equal(new Set(persisted.runs.map((run) => run.id)).size, 12);
  await app.close();
  const reopened = await buildApp({ dataDir });
  t.after(async () => reopened.close());
  const response = await reopened.inject({ method: "GET", url: "/v1/runs" });
  assert.equal(response.json().runs.length, 12);
});

test("untrusted hosts/origins cannot access or mutate the local workspace", async (t) => {
  const { app } = await harness(t);
  for (const headers of [
    { host: "attacker.example:4310" },
    { host: "127.0.0.1.attacker.example" },
    { origin: "https://attacker.example" },
    { origin: "null" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: brief,
      headers,
    });
    assert.equal(response.statusCode, 403);
  }
  const permitted = await app.inject({
    method: "GET",
    url: "/v1/workspace",
    headers: { host: "127.0.0.1:4310", origin: "http://127.0.0.1:5173" },
  });
  assert.equal(permitted.statusCode, 200);
  assert.equal(permitted.json().runs.length, 0);
});

test("unknown runs and invalid JSON return structured errors", async (t) => {
  const { app } = await harness(t);
  const missing = await app.inject({ method: "GET", url: "/v1/runs/missing" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "RUN_NOT_FOUND");
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "INVALID_REQUEST");
});

test("corrupted or unsupported state refuses startup without overwriting evidence", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "vuzmi-corrupt-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const statePath = join(dataDir, STATE_FILE_NAME);
  for (const contents of ["{broken", '{"schemaVersion":999,"runs":[]}']) {
    await writeFile(statePath, contents, { mode: 0o600 });
    await assert.rejects(buildApp({ dataDir }), /Refusing to overwrite/);
    assert.equal(await readFile(statePath, "utf8"), contents);
  }
});

test("a completed run without an approved artifact refuses startup", async (t) => {
  const { app, dataDir } = await harness(t);
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: brief,
  });
  const run = created.json<{ run: Run }>().run;
  await app.close();
  const contents = JSON.stringify({
    schemaVersion: 1,
    runs: [{ ...run, status: "completed" }],
  });
  const statePath = join(dataDir, STATE_FILE_NAME);
  await writeFile(statePath, contents, { mode: 0o600 });
  await assert.rejects(
    buildApp({ dataDir }),
    /inconsistent approval or artifact/,
  );
  assert.equal(await readFile(statePath, "utf8"), contents);
});

test("a failed disk write does not publish completion or poison later mutations", async (t) => {
  const { app, dataDir } = await harness(t);
  const created = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: brief,
  });
  const run = created.json<{ run: Run }>().run;
  const statePath = join(dataDir, STATE_FILE_NAME);
  const previous = await readFile(statePath, "utf8");
  await rm(statePath);
  await mkdir(statePath);
  const request = {
    method: "POST" as const,
    url: `/v1/runs/${run.id}/decisions`,
    payload: decisionFor(run),
  };
  const failed = await app.inject(request);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().error.code, "PERSISTENCE_ERROR");
  const unchanged = await app.inject({
    method: "GET",
    url: `/v1/runs/${run.id}`,
  });
  assert.deepEqual(unchanged.json().run, run);
  assert.deepEqual(
    (await readdir(dataDir)).filter((file) => file.endsWith(".tmp")),
    [],
  );
  await rm(statePath, { recursive: true });
  await writeFile(statePath, previous, { mode: 0o600 });
  const retried = await app.inject(request);
  assert.equal(retried.statusCode, 200);
  assert.equal(retried.json().run.status, "completed");
});

test("self-host serves only the built client root and minimal dependency health", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "vuzmi-web-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, "public");
  await mkdir(webRoot);
  await writeFile(
    join(webRoot, "index.html"),
    "<title>Vuzmi build fixture</title>",
  );
  await writeFile(
    join(directory, "private-key.txt"),
    "fixture-private-do-not-serve",
  );
  await writeFile(join(webRoot, ".secret"), "fixture-private-dotfile");
  const app = await buildApp({ dataDir: join(directory, "state"), webRoot });
  t.after(() => app.close());
  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Vuzmi build fixture/);
  for (const url of [
    "/private-key.txt",
    "/.secret",
    "/%2e%2e/private-key.txt",
    "/node_modules/pg/package.json",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.notEqual(response.statusCode, 200);
    assert.doesNotMatch(response.body, /fixture-private/);
  }
  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/healthz" })).json(),
    { status: "ok" },
  );
  const readiness = await app.inject({ method: "GET", url: "/readyz" });
  assert.equal(readiness.statusCode, 503);
  assert.deepEqual(readiness.json(), { status: "not_ready" });
});
