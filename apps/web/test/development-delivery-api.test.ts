import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/api";
import {
  authorizeDevelopmentDelivery,
  getDevelopmentDelivery,
  prepareDevelopmentDelivery,
  refreshDevelopmentDelivery,
} from "../src/developmentDeliveryApi";
import { uiDelivery, uiDeliveryPlan } from "./development-delivery-fixtures";
import { fixtureTime } from "./development-ui-fixtures";

async function response<T>(body: unknown, check: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json(body);
  try {
    return await check();
  } finally {
    globalThis.fetch = previous;
  }
}
const invalid = (cause: unknown) =>
  cause instanceof ApiError && cause.code === "INVALID_RESPONSE";
const disconnected = {
  operation: null,
  available: false,
  authorityIdentity: null,
  reason: "Fixture connector disconnected",
  checkedAt: fixtureTime,
};
test("delivery absence and disconnected readiness must both be explicit", async () => {
  const id = uiDelivery().runId;
  assert.deepEqual(
    await response(disconnected, () => getDevelopmentDelivery(id)),
    disconnected,
  );
  for (const value of [
    {},
    { ...disconnected, operation: undefined },
    { ...disconnected, available: true },
    { ...disconnected, authorityIdentity: "unsafe" },
    { ...disconnected, checkedAt: "unknown" },
  ])
    await assert.rejects(
      response(value, () => getDevelopmentDelivery(id)),
      invalid,
    );
});
test("a foreign-run operation cannot become this package's delivery state", async () => {
  const a = uiDelivery(),
    b = uiDelivery();
  await assert.rejects(
    response({ ...disconnected, operation: b }, () =>
      getDevelopmentDelivery(a.runId),
    ),
    invalid,
  );
});
test("plan preparation preserves exact input text and accepts a readable disconnected plan", async () => {
  const plan = { ...uiDeliveryPlan(), authorityIdentity: null },
    input = { title: plan.title, body: plan.inputBody };
  const result = await response(
    { plan, available: false, reason: "Fixture disconnected" },
    () => prepareDevelopmentDelivery(plan.runId, input),
  );
  assert.equal(result.available, false);
  assert.equal(result.plan.body, `${input.body}\n\n${plan.marker}`);
  await assert.rejects(
    response(
      {
        plan: { ...plan, inputBody: "Different text" },
        available: false,
        reason: null,
      },
      () => prepareDevelopmentDelivery(plan.runId, input),
    ),
    invalid,
  );
});
test("publication response must retain UUID, package, fingerprint and both exact public inputs", async () => {
  const operation = uiDelivery(),
    input = {
      requestId: operation.requestId,
      planFingerprint: operation.plan.fingerprint,
      packageSha256: operation.plan.packageSha256,
      title: operation.plan.title,
      body: operation.plan.inputBody,
    };
  assert.equal(
    (
      await response({ operation, replayed: true }, () =>
        authorizeDevelopmentDelivery(operation.runId, input),
      )
    ).replayed,
    true,
  );
  for (const mismatch of [
    { ...operation, requestId: "72d6eebd-2021-40da-982a-39d066e81e3f" },
    { ...operation, plan: { ...operation.plan, fingerprint: "0".repeat(64) } },
    { ...operation, plan: { ...operation.plan, inputBody: "Other body" } },
    { ...operation, plan: { ...operation.plan, title: "Other title" } },
  ])
    await assert.rejects(
      response({ operation: mismatch, replayed: true }, () =>
        authorizeDevelopmentDelivery(operation.runId, input),
      ),
      invalid,
    );
});
test("CI/reconciliation refresh uses only the fixed explicit refresh endpoint", async () => {
  const operation = uiDelivery(),
    previous = globalThis.fetch;
  let path = "",
    method = "",
    body = "";
  globalThis.fetch = async (url, init) => {
    path = String(url);
    method = init?.method ?? "GET";
    body = String(init?.body);
    return Response.json({ operation });
  };
  try {
    assert.equal(
      (await refreshDevelopmentDelivery(operation.runId))!.id,
      operation.id,
    );
    assert.equal(path, `/v1/development/${operation.runId}/delivery/refresh`);
    assert.equal(method, "POST");
    assert.equal(body, "{}");
  } finally {
    globalThis.fetch = previous;
  }
});
