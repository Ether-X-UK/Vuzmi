import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/api";
import {
  authorizeDevelopmentApplication,
  getDevelopmentApplication,
  getDevelopmentApplicationPlan,
} from "../src/developmentApi";
import {
  uiApplication,
  uiAppliedApplication,
  uiApprovedRun,
} from "./development-ui-fixtures";

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
  cause instanceof ApiError &&
  cause.code === "INVALID_RESPONSE" &&
  cause.status === 0;

test("an offline connector can still expose the exact plan without claiming availability", async () => {
  const operation = uiApplication();
  const result = await response(
    {
      plan: operation.plan,
      available: false,
      reason: "Fixture connector offline.",
    },
    () => getDevelopmentApplicationPlan(operation.runId),
  );
  assert.equal(result.available, false);
  assert.deepEqual(result.plan, operation.plan);
  await assert.rejects(
    response({ plan: operation.plan, available: true, reason: null }, () =>
      getDevelopmentApplicationPlan("950d6548-959f-41a0-8d4b-4588e4be9985"),
    ),
    invalid,
  );
});
test("application absence must be explicit; malformed or foreign-run responses cannot become receipt state", async () => {
  const operation = uiApplication();
  assert.equal(
    await response({ operation: null }, () =>
      getDevelopmentApplication(operation.runId),
    ),
    null,
  );
  await assert.rejects(
    response({}, () => getDevelopmentApplication(operation.runId)),
    invalid,
  );
  await assert.rejects(
    response({ operation }, () =>
      getDevelopmentApplication("950d6548-959f-41a0-8d4b-4588e4be9985"),
    ),
    invalid,
  );
});
test("authorization result must retain the exact request UUID, plan fingerprint and package SHA", async () => {
  const operation = uiApplication(),
    input = {
      requestId: operation.requestId,
      packageSha256: operation.plan.packageSha256,
      planFingerprint: operation.plan.fingerprint,
    };
  const confirmed = await response({ operation, replayed: true }, () =>
    authorizeDevelopmentApplication(operation.runId, input),
  );
  assert.deepEqual(confirmed.operation, operation);
  assert.equal(confirmed.replayed, true);
  for (const mismatch of [
    { ...operation, requestId: "950d6548-959f-41a0-8d4b-4588e4be9985" },
    { ...operation, plan: { ...operation.plan, fingerprint: "0".repeat(64) } },
    {
      ...operation,
      plan: { ...operation.plan, packageSha256: "0".repeat(64) },
    },
  ])
    await assert.rejects(
      response({ operation: mismatch, replayed: true }, () =>
        authorizeDevelopmentApplication(operation.runId, input),
      ),
      invalid,
    );
});
test("a receipt lacking its actual file entries is unverified and cannot be rendered as an applied record", async () => {
  const run = uiApprovedRun(),
    operation = uiAppliedApplication(run);
  assert.equal(
    (await response({ operation }, () => getDevelopmentApplication(run.id)))
      ?.status,
    "applied",
  );
  const { files: _files, ...incompleteReceipt } = operation.receipt!;
  await assert.rejects(
    response({ operation: { ...operation, receipt: incompleteReceipt } }, () =>
      getDevelopmentApplication(run.id),
    ),
    invalid,
  );
});
