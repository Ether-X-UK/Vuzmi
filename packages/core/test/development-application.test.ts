import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createDevelopmentApplicationPlan,
  createDevelopmentApplication,
  parseDevelopmentApplicationIntegrity,
  withDevelopmentApplicationEvent,
} from "../src/index.js";
import {
  approvedApplicationFixture,
  applicationActor,
} from "../../runtime/test/application-fixtures.js";
import { digest } from "../../runtime/test/development-fixtures.js";
const now = "2026-11-05T21:00:00.000Z";
test("application separately binds approved package, exact fixed plan and authenticated actor", () => {
  const run = approvedApplicationFixture(),
    before = JSON.stringify(run),
    plan = createDevelopmentApplicationPlan(run, "1".repeat(64), digest);
  const input = {
    requestId: randomUUID(),
    packageSha256: plan.packageSha256,
    planFingerprint: plan.fingerprint,
  };
  const operation = createDevelopmentApplication(plan, input, {
    id: randomUUID(),
    actor: applicationActor,
    now,
    hash: digest,
  });
  assert.equal(operation.status, "queued");
  assert.equal(operation.receipt, undefined);
  assert.equal(plan.destinationRef, `refs/heads/vuzmi/development/${run.id}`);
  assert.equal(JSON.stringify(run), before);
  for (const bad of [
    { ...input, packageSha256: "0".repeat(64) },
    { ...input, planFingerprint: "0".repeat(64) },
  ])
    assert.throws(() =>
      createDevelopmentApplication(plan, bad, {
        id: randomUUID(),
        actor: applicationActor,
        now,
        hash: digest,
      }),
    );
  for (const bad of [
    { ...operation, actor: "another-owner" },
    { ...operation, plan: { ...plan, baseCommit: "f".repeat(40) } },
    { ...operation, plan: { ...plan, destinationRef: "refs/heads/main" } },
    { ...operation, events: [] },
  ])
    assert.throws(() => parseDevelopmentApplicationIntegrity(bad, digest));
  assert.throws(() =>
    createDevelopmentApplicationPlan(
      { ...run, status: "waiting_approval", artifact: undefined },
      "1".repeat(64),
      digest,
    ),
  );
});
test("an application receipt must match the retained exact commit, authorization and file hashes", () => {
  const plan = createDevelopmentApplicationPlan(
    approvedApplicationFixture(),
    "1".repeat(64),
    digest,
  );
  let operation = createDevelopmentApplication(
    plan,
    {
      requestId: randomUUID(),
      packageSha256: plan.packageSha256,
      planFingerprint: plan.fingerprint,
    },
    { id: randomUUID(), actor: applicationActor, now, hash: digest },
  );
  const prepared = {
    treeOid: "a".repeat(40),
    commitOid: "b".repeat(40),
    files: plan.files.map((file) => ({ ...file, mode: "100644" as const })),
  };
  operation = withDevelopmentApplicationEvent(
    operation,
    "application.prepared",
    "Synthetic prepared commit.",
    now,
    { prepared },
  );
  const receipt = {
    applicationId: operation.id,
    runId: operation.runId,
    repositoryIdentity: plan.repositoryIdentity,
    packageSha256: plan.packageSha256,
    baseCommit: plan.baseCommit,
    destinationRef: plan.destinationRef,
    ...prepared,
    actor: operation.actor,
    authorizedAt: operation.authorizedAt,
    appliedAt: now,
  };
  operation = withDevelopmentApplicationEvent(
    operation,
    "application.applied",
    "Synthetic observed branch.",
    now,
    { status: "applied", receipt },
  );
  assert.deepEqual(
    parseDevelopmentApplicationIntegrity(operation, digest),
    operation,
  );
  for (const bad of [
    { ...operation, receipt: { ...receipt, commitOid: "c".repeat(40) } },
    { ...operation, receipt: { ...receipt, actor: "another-owner" } },
    { ...operation, receipt: { ...receipt, files: [] } },
    { ...operation, status: "queued" },
  ])
    assert.throws(() => parseDevelopmentApplicationIntegrity(bad, digest));
});
