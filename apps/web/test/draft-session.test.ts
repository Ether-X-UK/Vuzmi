import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createSimulationRun, type ReviseDraftInput } from "@vuzmi/core";
import {
  clearDraftSession,
  confirmDraftSignOut,
  hasHeldDraft,
  openDraftSession,
  reconcileDraftOwner,
  registerDraftDiscardGuard,
  retainedDraft,
  settleDraftAttempt,
  updateDraftSession,
} from "../src/draftSession";

function run(id: string) {
  return createSimulationRun(
    {
      title: "Transient correction fixture",
      brief: "Owned data for session-boundary tests only.",
      domain: "build",
    },
    {
      id,
      now: "2026-11-05T12:00:00.000Z",
      fingerprint: (value) => createHash("sha256").update(value).digest("hex"),
    },
  );
}
function browserWindow(context: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser = Object.assign(new EventTarget(), {
    location: { origin: "http://127.0.0.1:5173" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: browser,
  });
  context.after(() => {
    reconcileDraftOwner("test-cleanup-owner");
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return browser;
}

test("transient draft recovery preserves exact input and fences owner, origin, and run", (context) => {
  const browser = browserWindow(context);
  const first = openDraftSession("owner-a", run("run-a"), "Original body")!;
  const body = "Corrected body\n\nExact Unicode: 漢字 🟢\n";
  updateDraftSession(first.id, {
    body,
    reason: "Correct the supported claim.",
  });
  assert.equal(retainedDraft("owner-a")?.body, body);
  assert.equal(retainedDraft("owner-b"), null);
  assert.equal(openDraftSession("owner-a", run("run-b"), "Replacement"), null);
  assert.equal(retainedDraft("owner-a")?.initialRun.id, "run-a");
  browser.location.origin = "http://127.0.0.1:5174";
  assert.equal(retainedDraft("owner-a"), null);
  browser.location.origin = "http://127.0.0.1:5173";
  const reload = new Event("beforeunload", { cancelable: true });
  browser.dispatchEvent(reload);
  assert.equal(reload.defaultPrevented, true);
  reconcileDraftOwner("owner-b");
  assert.equal(retainedDraft("owner-a"), null);
  assert.equal(hasHeldDraft(), false);
  const cleanReload = new Event("beforeunload", { cancelable: true });
  browser.dispatchEvent(cleanReload);
  assert.equal(cleanReload.defaultPrevented, false);
});

test("late save settlement cannot clear changed input or a replacement session", (context) => {
  browserWindow(context);
  const first = openDraftSession("owner-a", run("run-a"), "Original body")!;
  const attempt: ReviseDraftInput = {
    editId: "12345678-1234-4234-8234-123456789012",
    revision: 1,
    fingerprint: "a".repeat(64),
    body: "Correction",
    reason: "Correct claim",
  };
  updateDraftSession(first.id, {
    body: attempt.body,
    reason: attempt.reason,
    attempt,
  });
  updateDraftSession(first.id, {
    body: "A newer local correction",
    attempt: null,
  });
  settleDraftAttempt(first.id, attempt.editId, { saved: true });
  assert.equal(retainedDraft("owner-a")?.body, "A newer local correction");
  clearDraftSession(first.id);
  const second = openDraftSession("owner-a", run("run-b"), "Second body")!;
  updateDraftSession(second.id, {
    body: "Second correction",
    reason: "Second reason",
    attempt,
  });
  settleDraftAttempt(first.id, attempt.editId, { saved: true });
  assert.equal(retainedDraft("owner-a")?.initialRun.id, "run-b");
  settleDraftAttempt(second.id, attempt.editId, {
    saved: false,
    error: "Save unconfirmed",
    conflicted: false,
    uncertain: true,
  });
  assert.equal(retainedDraft("owner-a")?.uncertain, true);
  assert.deepEqual(retainedDraft("owner-a")?.attempt, attempt);
  settleDraftAttempt(second.id, attempt.editId, { saved: true });
  assert.equal(hasHeldDraft(), false);
});

test("sign-out awaits the active discard guard and cannot silently drop an inactive correction", async (context) => {
  browserWindow(context);
  const first = openDraftSession("owner-a", run("run-a"), "Original body")!;
  updateDraftSession(first.id, {
    body: "Unsaved correction",
    reason: "Correct claim",
  });
  assert.equal(await confirmDraftSignOut(), false);
  let answer: ((value: boolean) => void) | undefined;
  const remove = registerDraftDiscardGuard(
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  let settled = false;
  const confirmation = confirmDraftSignOut().then((value) => {
    settled = true;
    return value;
  });
  assert.equal(settled, false);
  answer!(false);
  assert.equal(await confirmation, false);
  assert.equal(hasHeldDraft(), true);
  const removeReplacement = registerDraftDiscardGuard(async () => {
    clearDraftSession(first.id);
    return true;
  });
  remove();
  assert.equal(await confirmDraftSignOut(), true);
  assert.equal(hasHeldDraft(), false);
  removeReplacement();
});
