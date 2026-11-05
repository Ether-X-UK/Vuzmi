import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSimulationRun } from "@vuzmi/core";
import { NativeApi, NativeApiError } from "../src/api";
import { NativeLifecycle, mergeNativeRuns } from "../src/lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function run() {
  return createSimulationRun(
    {
      title: "Native lifecycle fixture",
      brief: "Review the exact local artifact without any external action.",
      domain: "build",
    },
    {
      id: "run-1",
      now: "2026-11-05T12:00:00.000Z",
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
    },
  );
}

test("five-second polling joins one twenty-second deadline; ignored abort cannot hold the refresh lock forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    return new Promise<Response>(() => {});
  });
  const lifecycle = new NativeLifecycle(() =>
      assert.fail("A timeout is not a session expiry"),
    ),
    epoch = lifecycle.begin(),
    api = new NativeApi("http://localhost:4310");
  let failure: unknown;
  const poll = () =>
    lifecycle.refresh(epoch, async () => {
      try {
        await lifecycle.request(epoch, () => api.workspace());
      } catch (error) {
        failure = error;
      }
    });
  const first = poll();
  await flush();
  const interval = setInterval(() => {
    void poll();
  }, 5000);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(lifecycle.isRefreshing(epoch), true);
    assert.equal(requests, 1);
    assert.equal(poll(), first);
  }
  t.mock.timers.tick(5000);
  await first;
  clearInterval(interval);
  assert.ok(failure instanceof NativeApiError && failure.code === "TIMEOUT");
  assert.equal(requests, 1);
  assert.equal(lifecycle.isRefreshing(epoch), false);
  let retried = false;
  await lifecycle.refresh(epoch, async () => {
    retried = true;
  });
  assert.equal(retried, true);
});

test("deadline also bounds a hung secure-header reader or response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const header = new NativeApi(
    "http://localhost:4310",
    () => new Promise(() => {}),
  );
  const rejectedHeader = assert.rejects(
    header.workspace(),
    (error) => error instanceof NativeApiError && error.code === "TIMEOUT",
  );
  t.mock.timers.tick(20000);
  await rejectedHeader;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      ({
        status: 200,
        ok: true,
        json: () => new Promise(() => {}),
      }) as Response,
  );
  const rejectedBody = assert.rejects(
    new NativeApi("http://localhost:4310").workspace(),
    (error) => error instanceof NativeApiError && error.code === "TIMEOUT",
  );
  await flush();
  t.mock.timers.tick(20000);
  await rejectedBody;
});

test("workspace, detail and decision status401 expire the shared session even with a non-JSON body", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("not JSON", { status: 401 }),
  );
  const api = new NativeApi("http://localhost:4310");
  for (const operation of [
    () => api.workspace(),
    () => api.run("run-1"),
    () => api.decide(run(), "approve"),
  ]) {
    let expired = 0,
      applied = 0;
    const lifecycle = new NativeLifecycle(() => {
        expired++;
      }),
      epoch = lifecycle.begin();
    assert.equal(
      await lifecycle.request(epoch, operation, () => {
        applied++;
      }),
      undefined,
    );
    assert.equal(expired, 1);
    assert.equal(applied, 0);
    assert.equal(lifecycle.isCurrent(epoch), false);
    assert.equal(
      lifecycle.commit(epoch, () => {
        applied++;
      }),
      false,
    );
    assert.equal(applied, 0);
  }
});

test("a401 during conflict recovery expires instead of preserving a usable review session", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++requests === 1
      ? Response.json(
          { error: { code: "STALE_APPROVAL", message: "Changed." } },
          { status: 409 },
        )
      : new Response("expired", { status: 401 }),
  );
  const api = new NativeApi("http://localhost:4310");
  let expired = 0;
  const lifecycle = new NativeLifecycle(() => {
      expired++;
    }),
    epoch = lifecycle.begin();
  await assert.rejects(
    lifecycle.request(epoch, () => api.decide(run(), "approve")),
    (error) => error instanceof NativeApiError && error.status === 409,
  );
  await lifecycle.request(epoch, () => api.run("run-1"));
  assert.equal(expired, 1);
  assert.equal(lifecycle.isCurrent(epoch), false);
  assert.equal(requests, 2);
});

test("obsolete connection successes,401s and auth-result commits cannot affect a replacement connection", async () => {
  let expired = 0,
    applied = 0;
  const lifecycle = new NativeLifecycle(() => {
      expired++;
    }),
    old = lifecycle.begin();
  const success = deferred<number>(),
    unauthorized = deferred<number>();
  const first = lifecycle.request(
    old,
    () => success.promise,
    () => {
      applied++;
    },
  );
  const second = lifecycle.request(
    old,
    () => unauthorized.promise,
    () => {
      applied++;
    },
  );
  const current = lifecycle.begin();
  success.resolve(1);
  unauthorized.reject(
    new NativeApiError("Expired old session", "SESSION_REQUIRED", 401),
  );
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
  assert.equal(expired, 0);
  assert.equal(applied, 0);
  assert.equal(
    lifecycle.commit(old, () => {
      applied++;
    }),
    false,
    "Late sign-in/sign-out results use this same epoch commit guard.",
  );
  assert.equal(lifecycle.isCurrent(current), true);
  await lifecycle.request(
    current,
    async () => 2,
    () => {
      applied++;
    },
  );
  assert.equal(applied, 1);
});

test("current session expiry suppresses parallel late successes and old refresh release cannot unlock a newer flight", async () => {
  let expired = 0,
    applied = 0;
  const lifecycle = new NativeLifecycle(() => {
      expired++;
    }),
    old = lifecycle.begin();
  const late = deferred<number>(),
    oldRefresh = deferred<void>();
  const pending = lifecycle.request(
    old,
    () => late.promise,
    () => {
      applied++;
    },
  );
  const firstFlight = lifecycle.refresh(old, () => oldRefresh.promise);
  await flush();
  await lifecycle.request(old, async () => {
    throw new NativeApiError("Expired", "SESSION_REQUIRED", 401);
  });
  late.resolve(1);
  assert.equal(await pending, undefined);
  assert.equal(applied, 0);
  assert.equal(expired, 1);
  const fresh = lifecycle.begin(),
    freshRefresh = deferred<void>();
  const secondFlight = lifecycle.refresh(fresh, () => freshRefresh.promise);
  await flush();
  oldRefresh.resolve();
  await firstFlight;
  assert.equal(lifecycle.isRefreshing(fresh), true);
  assert.equal(
    lifecycle.refresh(fresh, async () =>
      assert.fail("Duplicate newer refresh"),
    ),
    secondFlight,
  );
  freshRefresh.resolve();
  await secondFlight;
  assert.equal(lifecycle.isRefreshing(fresh), false);
});

test("a slow workspace cannot replace a newer detailed or decided run revision", () => {
  const initial = run(),
    newer = { ...initial, revision: initial.revision + 1 };
  assert.equal(mergeNativeRuns([newer], [initial])[0], newer);
  assert.equal(mergeNativeRuns([initial], [newer])[0], newer);
});

test("callbacks bound before reconnect cannot acquire the replacement epoch before React cleanup", async (t) => {
  let oldRequests = 0;
  let newRequests = 0;
  let expired = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("http://localhost:4310")) {
      oldRequests += 1;
      return new Response("old session", { status: 401 });
    }
    newRequests += 1;
    return Response.json({ mode: "owner", setupNeeded: false, user: null });
  });
  const lifecycle = new NativeLifecycle(() => {
    expired += 1;
  });
  const old = lifecycle.bind(lifecycle.begin());
  const oldApi = new NativeApi("http://localhost:4310");
  const oldPoll = () =>
    old.refresh(async () => {
      await old.request(() => oldApi.workspace());
    });
  const oldDetail = () => old.request(() => oldApi.run("run-1"));
  // The replacement starts, but old callbacks/effect cleanup still exist.
  const fresh = lifecycle.bind(lifecycle.begin());
  await oldPoll();
  await oldDetail();
  assert.equal(
    old.begin(),
    undefined,
    "Old sign-in/sign-out closures cannot start a session using their previous client.",
  );
  assert.equal(
    old.invalidate(),
    false,
    "Old poll cleanup cannot invalidate the replacement.",
  );
  assert.equal(
    old.close(),
    false,
    "Old disconnect cannot close the replacement.",
  );
  assert.equal(oldRequests, 0);
  assert.equal(expired, 0);
  assert.equal(fresh.isCurrent(), true);
  await fresh.request(() => new NativeApi("http://localhost:4311").authState());
  assert.equal(newRequests, 1);
});

test("a newly rendered inactive epoch can begin reauthentication while expired callbacks stay obsolete", async () => {
  const lifecycle = new NativeLifecycle(() => {});
  const expired = lifecycle.bind(lifecycle.begin());
  await expired.request(async () => {
    throw new NativeApiError("Expired", "SESSION_REQUIRED", 401);
  });
  assert.equal(expired.begin(), undefined);
  const ownerGate = lifecycle.bind(lifecycle.current());
  assert.equal(ownerGate.isCurrent(), false);
  const signedIn = ownerGate.begin();
  assert.equal(typeof signedIn, "number");
  assert.equal(lifecycle.isCurrent(signedIn!), true);
  assert.equal(
    ownerGate.begin(),
    undefined,
    "A stale auth form cannot begin twice after its scope changes.",
  );
});
