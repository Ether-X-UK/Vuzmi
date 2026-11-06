import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createDevelopmentDelivery,
  createDevelopmentDeliveryPlan,
  developmentDeliveryCommitMetadata,
  withDevelopmentDeliveryEvent,
} from "@vuzmi/core";
import type {
  DevelopmentDelivery,
  DevelopmentDeliveryPhase,
} from "@vuzmi/core";
import { createDevelopmentGitHubConnector } from "../src/development-github.js";
import { approvedDeliveryFixture } from "./delivery-fixtures.js";
import { digest } from "./development-fixtures.js";

const response = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const gitHash = (kind: string, text: string) =>
  createHash("sha1")
    .update(`${kind} ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
type Call = {
  path: string;
  method: string;
  body: any;
  authorization: string | null;
};
async function fixture(t: TestContext, timeoutMs = 1000) {
  const f = approvedDeliveryFixture(),
    directory = await mkdtemp(join(tmpdir(), "vuzmi-github-fixture-")),
    tokenFile = join(directory, "token");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    tokenFile,
    "github_pat_disposable_fixture_only_1234567890\n",
    { mode: 0o600 },
  );
  const metadata = developmentDeliveryCommitMetadata(f.application),
    seconds = Date.parse(metadata.author.date) / 1000,
    raw = `tree ${f.application.prepared!.treeOid}\nparent ${f.application.plan.baseCommit}\nauthor Vuzmi Local <local@vuzmi.invalid> ${seconds} +0000\ncommitter Vuzmi Local <local@vuzmi.invalid> ${seconds} +0000\n\n${metadata.message}`,
    exactCommit = gitHash("commit", raw);
  f.application.prepared!.commitOid = exactCommit;
  f.application.receipt!.commitOid = exactCommit;
  const calls: Call[] = [],
    writes: DevelopmentDeliveryPhase[] = [];
  let head: string | undefined,
    pr: any,
    main = f.target.targetSha,
    runs: any[] = [],
    total: number | undefined;
  let override:
    ((call: Call) => Response | Promise<Response> | undefined) | undefined;
  const prValue = () => ({
    number: 7,
    title: f.plan.title,
    body: f.plan.body,
    draft: true,
    state: "open",
    merge_commit_sha: "a".repeat(40),
    html_url: "https://github.com/Ether-X-UK/Vuzmi/pull/7",
    head: {
      ref: f.plan.destinationRef.slice("refs/heads/".length),
      sha: exactCommit,
      repo: { id: 123, full_name: "Ether-X-UK/Vuzmi" },
    },
    base: {
      ref: "main",
      sha: main,
      repo: { id: 123, full_name: "Ether-X-UK/Vuzmi" },
    },
  });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(
      new Headers(init?.headers).get("x-github-api-version"),
      "2026-03-10",
    );
    const call = {
      path: url.pathname.replace("/repos/Ether-X-UK/Vuzmi", "") + url.search,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const replacement = override?.(call);
    if (replacement) return replacement;
    if (call.method === "GET") {
      assert.equal(call.authorization, null);
      if (call.path === "")
        return response({
          id: 123,
          full_name: "Ether-X-UK/Vuzmi",
          private: false,
          visibility: "public",
          default_branch: "main",
        });
      if (call.path === "/hash-algorithm")
        return response({ hash_algorithm: "sha1" });
      if (call.path === "/git/ref/heads/main")
        return response({
          ref: "refs/heads/main",
          object: { type: "commit", sha: main },
        });
      if (call.path.startsWith("/git/ref/heads/vuzmi/"))
        return head
          ? response({
              ref: f.plan.destinationRef,
              object: { type: "commit", sha: head },
            })
          : response({}, 404);
      if (call.path.startsWith("/pulls?")) return response(pr ? [pr] : []);
      if (call.path === "/pulls/7")
        return pr ? response(pr) : response({}, 404);
      if (call.path === `/git/commits/${f.plan.baseCommit}`)
        return response({
          sha: f.plan.baseCommit,
          tree: { sha: "b".repeat(40) },
        });
      if (call.path === `/git/commits/${exactCommit}`)
        return response({
          sha: exactCommit,
          tree: { sha: f.plan.treeOid },
          parents: [{ sha: f.plan.baseCommit }],
          message: metadata.message,
        });
      if (call.path === "/actions/workflows/checks.yml")
        return response({ id: 12, path: ".github/workflows/checks.yml" });
      if (call.path.startsWith("/actions/workflows/checks.yml/runs?"))
        return response({
          total_count: total ?? runs.length,
          workflow_runs: runs,
        });
    } else {
      assert.equal(
        call.authorization,
        "Bearer github_pat_disposable_fixture_only_1234567890",
      );
      if (call.path === "/git/blobs")
        return response(
          {
            sha: gitHash(
              "blob",
              Buffer.from(call.body.content, "base64").toString("utf8"),
            ),
          },
          201,
        );
      if (call.path === "/git/trees")
        return response({ sha: f.plan.treeOid }, 201);
      if (call.path === "/git/commits")
        return response({ sha: exactCommit }, 201);
      if (call.path === "/git/refs") {
        if (head) return response({}, 422);
        head = call.body.sha;
        return response(
          { ref: f.plan.destinationRef, object: { type: "commit", sha: head } },
          201,
        );
      }
      if (call.path === "/pulls") {
        pr = prValue();
        return response(pr, 201);
      }
    }
    throw new Error(`Unexpected synthetic request ${call.method} ${call.path}`);
  };
  const connector = createDevelopmentGitHubConnector({
      tokenFile,
      fetch: transport,
      timeoutMs,
      now: () => new Date(f.target.observedAt),
      localGit: {
        async inspect() {
          return "applied";
        },
      },
    }),
    ready = await connector.readiness();
  assert.equal(ready.ready, true);
  f.plan = createDevelopmentDeliveryPlan(
    f.run,
    f.application,
    f.text,
    f.target,
    ready.authorityIdentity!,
    digest,
  );
  f.input = {
    ...f.text,
    requestId: randomUUID(),
    packageSha256: f.plan.packageSha256,
    planFingerprint: f.plan.fingerprint,
  };
  let operation = createDevelopmentDelivery(f.plan, f.input, {
    id: randomUUID(),
    actor: { id: "owner" },
    now: f.target.observedAt,
    hash: digest,
  });
  operation = withDevelopmentDeliveryEvent(
    operation,
    "delivery.started",
    "Synthetic durable claim.",
    f.target.observedAt,
    {
      status: "running",
      workerId: randomUUID(),
      attemptId: randomUUID(),
      phase: "reserved",
    },
  );
  const beforeWrite = async (phase: DevelopmentDeliveryPhase) => {
    writes.push(phase);
  };
  const publish = () =>
    connector.publish(operation, f.run, f.application, beforeWrite);
  const published = async (): Promise<DevelopmentDelivery> => {
    const receipt = await publish();
    return withDevelopmentDeliveryEvent(
      operation,
      "delivery.published",
      "Synthetic remote receipt.",
      receipt.publishedAt,
      { status: "published", receipt },
    );
  };
  const workflowRun = (
    id = 20,
    status = "completed",
    conclusion: string | null = "success",
  ) => ({
    id,
    workflow_id: 12,
    path: ".github/workflows/checks.yml",
    run_attempt: 1,
    name: "Alpha checks",
    event: "pull_request",
    head_sha: exactCommit,
    status,
    conclusion,
    html_url: `https://github.com/Ether-X-UK/Vuzmi/actions/runs/${id}`,
    pull_requests: [
      { number: 7, head: { sha: exactCommit }, base: { sha: main } },
    ],
  });
  calls.length = 0;
  return {
    ...f,
    directory,
    tokenFile,
    connector,
    calls,
    writes,
    operation,
    publish,
    published,
    prValue,
    workflowRun,
    transport,
    setOverride(value: typeof override) {
      override = value;
    },
    setHead(value: typeof head) {
      head = value;
    },
    setPr(value: typeof pr) {
      pr = value;
    },
    getPr() {
      return pr;
    },
    setMain(value: string) {
      main = value;
    },
    setRuns(value: any[], count?: number) {
      runs = value;
      total = count;
    },
  };
}

test("GitHub delivery defaults disconnected, readiness does no public polling without a token", async () => {
  let calls = 0;
  const connector = createDevelopmentGitHubConnector({
    fetch: async () => {
      calls++;
      throw new Error("Must not fetch");
    },
  });
  assert.equal((await connector.readiness()).ready, false);
  assert.equal((await connector.readiness()).ready, false);
  assert.equal(calls, 0);
});
test("GitHub delivery verifies exact object payloads, checks every mutation and publishes only a draft", async (t) => {
  const f = await fixture(t),
    before = JSON.stringify({ run: f.run, application: f.application }),
    receipt = await f.publish();
  assert.equal(receipt.headSha, f.plan.commitOid);
  assert.equal(receipt.targetDrift, false);
  assert.deepEqual(f.writes, [
    "blob",
    "tree",
    "commit",
    "branch",
    "pull_request",
  ]);
  const posts = f.calls.filter((call) => call.method === "POST");
  assert.deepEqual(
    posts.map((call) => call.path),
    ["/git/blobs", "/git/trees", "/git/commits", "/git/refs", "/pulls"],
  );
  assert.deepEqual(posts[2].body, {
    ...f.plan.commit,
    tree: f.plan.treeOid,
    parents: [f.plan.baseCommit],
  });
  assert.deepEqual(posts[3].body, {
    ref: f.plan.destinationRef,
    sha: f.plan.commitOid,
  });
  assert.deepEqual(posts[4].body, {
    title: f.plan.title,
    body: f.plan.body,
    head: receipt.headRef,
    base: "main",
    draft: true,
    maintainer_can_modify: false,
  });
  assert.equal(
    JSON.stringify({ run: f.run, application: f.application }),
    before,
  );
  const count = posts.length;
  assert.equal((await f.connector.inspect(f.operation)).status, "published");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, count);
  f.calls.length = 0;
  assert.equal((await f.connector.readiness()).ready, true);
  assert.equal(
    f.calls.length,
    0,
    "configured readiness caches the public target for five minutes",
  );
});
test("GitHub delivery rejects unsafe or replaced token files and never falls back to inherited authentication", async (t) => {
  const f = await fixture(t);
  await chmod(f.tokenFile, 0o644);
  assert.equal((await f.connector.readiness()).ready, false);
  await assert.rejects(f.publish(), {
    code: "DELIVERY_CREDENTIAL_UNAVAILABLE",
  });
  await chmod(f.tokenFile, 0o600);
  const renamed = `${f.tokenFile}.old`;
  await rename(f.tokenFile, renamed);
  await symlink(renamed, f.tokenFile);
  assert.equal((await f.connector.readiness()).ready, false);
  await rm(f.tokenFile);
  await writeFile(
    f.tokenFile,
    "github_pat_replacement_fixture_only_123456789",
    { mode: 0o600 },
  );
  await assert.rejects(f.publish(), { code: "STALE_DELIVERY_AUTHORITY" });
  assert.equal(f.calls.length, 0);
});
test("GitHub delivery cannot publish an unreserved operation or an unverified local application", async (t) => {
  const f = await fixture(t);
  const queued = createDevelopmentDelivery(f.plan, f.input, {
    id: randomUUID(),
    actor: { id: "owner" },
    now: f.target.observedAt,
    hash: digest,
  });
  assert.throws(
    () =>
      f.connector.publish(queued, f.run, f.application, async () => undefined),
    { code: "DELIVERY_NOT_RESERVED" },
  );
  const connector = createDevelopmentGitHubConnector({
    tokenFile: f.tokenFile,
    fetch: f.transport,
    localGit: {
      async inspect() {
        return "conflict";
      },
    },
  });
  await assert.rejects(
    connector.publish(f.operation, f.run, f.application, async () => undefined),
    { code: "DELIVERY_LOCAL_BRANCH_CHANGED" },
  );
  assert.equal(f.calls.length, 0);
});
test("GitHub delivery rejects changed public target, private repository, object format and occupied ref before writes", async (t) => {
  for (const mode of ["main", "private", "format", "ref"] as const) {
    const f = await fixture(t);
    if (mode === "main") f.setMain("e".repeat(40));
    if (mode === "ref") f.setHead("e".repeat(40));
    if (mode === "private")
      f.setOverride((call) =>
        call.path === ""
          ? response({
              full_name: "Ether-X-UK/Vuzmi",
              private: true,
              visibility: "private",
              default_branch: "main",
              id: 123,
            })
          : undefined,
      );
    if (mode === "format")
      f.setOverride((call) =>
        call.path === "/hash-algorithm"
          ? response({ hash_algorithm: "sha256" })
          : undefined,
      );
    await assert.rejects(f.publish());
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});
test("GitHub delivery stops every OID mismatch before branch creation without fallback", async (t) => {
  for (const path of ["/git/blobs", "/git/trees", "/git/commits"]) {
    const f = await fixture(t);
    f.setOverride((call) =>
      call.method === "POST" && call.path === path
        ? response({ sha: "e".repeat(40) }, 201)
        : undefined,
    );
    await assert.rejects(
      f.publish(),
      (error) =>
        error instanceof Error && /OID_MISMATCH/.test((error as any).code),
    );
    assert.equal(
      f.calls.some(
        (call) => call.path === "/git/refs" && call.method === "POST",
      ),
      false,
    );
    assert.equal(
      f.calls.some((call) => call.path === "/pulls" && call.method === "POST"),
      false,
    );
  }
});
test("GitHub delivery rechecks authority after each durable write checkpoint", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.connector.publish(f.operation, f.run, f.application, async (phase) => {
      if (phase === "tree")
        await writeFile(
          f.tokenFile,
          "github_pat_replaced_midflight_fixture_123456789",
        );
    }),
    { code: "STALE_DELIVERY_AUTHORITY" },
  );
  assert.deepEqual(
    f.calls.filter((call) => call.method === "POST").map((call) => call.path),
    ["/git/blobs"],
  );
});
test("GitHub delivery does not write after a checkpoint failure or hard deadline even if an injected callback ignores abort", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.connector.publish(f.operation, f.run, f.application, async () => {
      throw new Error("Lease lost");
    }),
    { code: "DELIVERY_GITHUB_UNCONFIRMED" },
  );
  assert.equal(
    f.calls.some((call) => call.method === "POST"),
    false,
  );
  const timed = await fixture(t, 20);
  let release: (() => void) | undefined;
  const pending = timed.connector.publish(
    timed.operation,
    timed.run,
    timed.application,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await assert.rejects(pending, { code: "DELIVERY_GITHUB_TIMEOUT" });
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    timed.calls.some((call) => call.method === "POST"),
    false,
  );
});
test("GitHub delivery unknown PR outcome is reconciled with GETs without creating a duplicate", async (t) => {
  const f = await fixture(t, 20);
  f.setOverride((call) => {
    if (call.path === "/pulls" && call.method === "POST") {
      f.setPr(f.prValue());
      return new Promise<Response>(() => undefined);
    }
  });
  await assert.rejects(f.publish(), { code: "DELIVERY_GITHUB_TIMEOUT" });
  const before = f.calls.filter((call) => call.method === "POST").length;
  f.setOverride(undefined);
  const publicOnly = createDevelopmentGitHubConnector({ fetch: f.transport });
  const inspected = await publicOnly.inspect(f.operation);
  assert.equal(inspected.status, "published");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, before);
});
test("GitHub delivery preserves partial branch and conflicting, edited, closed or duplicate PR evidence", async (t) => {
  const f = await fixture(t);
  f.setHead(f.plan.commitOid);
  assert.equal((await f.connector.inspect(f.operation)).status, "partial");
  f.setPr({ ...f.prValue(), title: "Outside edit" });
  assert.equal((await f.connector.inspect(f.operation)).status, "conflict");
  f.setPr({ ...f.prValue(), state: "closed" });
  assert.equal(
    (await f.connector.inspect(f.operation)).status,
    "published",
    "closed exact PR is observed rather than reopened or duplicated",
  );
  f.setHead(undefined);
  assert.equal((await f.connector.inspect(f.operation)).status, "conflict");
  assert.equal(
    f.calls.some((call) => call.method === "POST"),
    false,
  );
});
test("GitHub delivery records main drift that occurs during PR creation without pretending atomic target pinning", async (t) => {
  const f = await fixture(t);
  f.setOverride((call) => {
    if (call.path === "/pulls" && call.method === "POST") {
      f.setMain("e".repeat(40));
      f.setPr(f.prValue());
      return response(f.getPr(), 201);
    }
  });
  const receipt = await f.publish();
  assert.equal(receipt.targetDrift, true);
  assert.equal(receipt.baseShaBefore, f.target.targetSha);
  assert.equal(receipt.baseShaAfter, "e".repeat(40));
});
test("GitHub delivery protocol refuses redirects, oversized JSON and rate-limit retries without exposing upstream text", async (t) => {
  for (const mode of ["redirect", "oversize", "rate", "utf8"] as const) {
    const f = await fixture(t);
    f.setOverride((call) =>
      call.path === ""
        ? mode === "redirect"
          ? new Response("private reflected data", {
              status: 302,
              headers: { location: "https://elsewhere.invalid" },
            })
          : mode === "oversize"
            ? response({}, 200, { "content-length": "9999999" })
            : mode === "rate"
              ? response({ message: "private reflected data" }, 429, {
                  "retry-after": "120",
                })
              : new Response(new Uint8Array([255]), {
                  headers: { "content-type": "application/json" },
                })
        : undefined,
    );
    await assert.rejects(
      f.connector.observeTarget(),
      (error) =>
        error instanceof Error &&
        !error.message.includes("private reflected data"),
    );
    const count = f.calls.length;
    if (mode === "rate") {
      await assert.rejects(f.connector.observeTarget(), {
        code: "DELIVERY_GITHUB_RATE_LIMITED",
      });
      assert.equal(f.calls.length, count);
    }
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
  }
});
test("GitHub CI distinguishes no runs, running, skipped, failure, latest attempts and exact named passing evidence", async (t) => {
  const f = await fixture(t),
    published = await f.published();
  assert.equal((await f.connector.observeCi(published)).state, "waiting");
  for (const [status, conclusion, expected] of [
    ["in_progress", null, "running"],
    ["completed", "skipped", "waiting"],
    ["completed", "neutral", "waiting"],
    ["completed", "cancelled", "waiting"],
    ["completed", "failure", "failed"],
    ["completed", "success", "passed"],
  ] as const) {
    f.setRuns([f.workflowRun(20, status, conclusion)]);
    const evidence = await f.connector.observeCi(published);
    assert.equal(evidence.state, expected);
    assert.equal(evidence.runs[0].workflowPath, ".github/workflows/checks.yml");
    assert.equal(evidence.runs[0].observedPrMergeSha, "a".repeat(40));
  }
  f.setRuns([f.workflowRun(20), f.workflowRun(21, "queued", null)]);
  assert.equal((await f.connector.observeCi(published)).state, "waiting");
  f.setRuns([f.workflowRun(20, "completed", "failure"), f.workflowRun(21)]);
  assert.equal((await f.connector.observeCi(published)).state, "passed");
  const original = f.calls.filter((call) => call.method === "POST").length;
  assert.equal(original, 5, "CI never dispatches or reruns a workflow");
});
test("GitHub CI cannot turn wrong commit/workflow/PR, moved head/base or truncated observations green", async (t) => {
  const f = await fixture(t),
    published = await f.published();
  for (const run of [
    { ...f.workflowRun(), head_sha: "e".repeat(40) },
    { ...f.workflowRun(), workflow_id: 99 },
    {
      ...f.workflowRun(),
      pull_requests: [
        {
          number: 999,
          head: { sha: f.plan.commitOid },
          base: { sha: f.target.targetSha },
        },
      ],
    },
  ]) {
    f.setRuns([run]);
    assert.equal((await f.connector.observeCi(published)).state, "unavailable");
  }
  f.setRuns([f.workflowRun()], 21);
  assert.equal((await f.connector.observeCi(published)).state, "unavailable");
  f.setRuns([f.workflowRun()]);
  f.setHead("e".repeat(40));
  assert.equal((await f.connector.observeCi(published)).state, "stale");
  f.setHead(f.plan.commitOid);
  f.setMain("e".repeat(40));
  const stale = await f.connector.observeCi(published);
  assert.equal(stale.state, "stale");
  assert.equal(stale.targetDrift, true);
});
