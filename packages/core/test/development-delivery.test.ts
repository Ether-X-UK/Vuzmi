import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createDevelopmentDeliveryPlan,
  createDevelopmentDelivery,
  developmentDeliveryPlanFingerprintInput,
  developmentDeliveryTextSchema,
  developmentDeliveryInputSchema,
  parseDevelopmentDeliveryIntegrity,
  withDevelopmentDeliveryEvent,
} from "../src/index.js";
import { approvedDeliveryFixture } from "../../runtime/test/delivery-fixtures.js";
import { digest } from "../../runtime/test/development-fixtures.js";

test("GitHub plan binds exact public payload, application metadata and authority while allowing a fresh unchanged observation", () => {
  const f = approvedDeliveryFixture();
  assert.equal(f.plan.body, `${f.text.body}\n\n${f.plan.marker}`);
  assert.match(
    f.plan.commit.message,
    new RegExp(`Application: ${f.application.id}`),
  );
  assert.match(f.plan.commit.message, /Actor: [a-f0-9]+\n/);
  assert.equal(f.plan.commit.author.email, "local@vuzmi.invalid");
  assert.equal(f.plan.commit.author.date, "2026-11-06T12:00:00.000Z");
  assert.equal(f.plan.files[0].mode, "100644");
  const fresh = createDevelopmentDeliveryPlan(
    f.run,
    f.application,
    f.text,
    { ...f.target, observedAt: "2026-11-06T12:01:00.000Z" },
    f.authorityIdentity,
    digest,
  );
  assert.equal(fresh.fingerprint, f.plan.fingerprint);
  for (const changed of [
    createDevelopmentDeliveryPlan(
      f.run,
      f.application,
      { ...f.text, title: "Changed exact title" },
      f.target,
      f.authorityIdentity,
      digest,
    ),
    createDevelopmentDeliveryPlan(
      f.run,
      f.application,
      { ...f.text, body: "Changed exact body" },
      f.target,
      f.authorityIdentity,
      digest,
    ),
    createDevelopmentDeliveryPlan(
      f.run,
      f.application,
      f.text,
      { ...f.target, targetSha: "9".repeat(40) },
      f.authorityIdentity,
      digest,
    ),
    createDevelopmentDeliveryPlan(
      f.run,
      f.application,
      f.text,
      f.target,
      "9".repeat(64),
      digest,
    ),
  ])
    assert.notEqual(changed.fingerprint, f.plan.fingerprint);
  const disconnected = createDevelopmentDeliveryPlan(
    f.run,
    f.application,
    f.text,
    f.target,
    null,
    digest,
  );
  assert.equal(disconnected.authorityIdentity, null);
  assert.throws(
    () =>
      createDevelopmentDelivery(disconnected, f.input, {
        id: randomUUID(),
        actor: { id: "owner" },
        now: f.target.observedAt,
        hash: digest,
      }),
    { code: "STALE_DELIVERY_PLAN" },
  );
  assert.equal(
    digest(developmentDeliveryPlanFingerprintInput(f.plan)),
    f.plan.fingerprint,
  );
});
test("GitHub public text rejects malformed Unicode, byte overflow, controls, markers and unreviewed transport fields", () => {
  for (const text of [
    { title: "Valid title", body: "bad\ud800" },
    { title: "Valid title", body: "😀".repeat(4001) },
    { title: "Valid title", body: "bad\r\nline" },
    { title: "bad\ntitle", body: "Body" },
    { title: "Valid title", body: "<!-- vuzmi-delivery:forged -->" },
  ])
    assert.equal(developmentDeliveryTextSchema.safeParse(text).success, false);
  const f = approvedDeliveryFixture();
  assert.equal(
    developmentDeliveryInputSchema.safeParse({
      ...f.input,
      repository: "other/repo",
    }).success,
    false,
  );
  assert.equal(
    developmentDeliveryTextSchema.safeParse({
      title: "Valid title",
      body: "Unicode ✅\nExact LF body",
    }).success,
    true,
  );
});
test("GitHub delivery rejects changed reviews, incompatible receipts and tampered history without mutating source packages", () => {
  const f = approvedDeliveryFixture(),
    before = structuredClone(f.run);
  assert.throws(
    () =>
      createDevelopmentDelivery(
        f.plan,
        { ...f.input, body: "Different body" },
        {
          id: randomUUID(),
          actor: { id: "owner" },
          now: f.target.observedAt,
          hash: digest,
        },
      ),
    { code: "STALE_DELIVERY_PLAN" },
  );
  assert.throws(() =>
    createDevelopmentDeliveryPlan(
      f.run,
      { ...f.application, runId: randomUUID() },
      f.text,
      f.target,
      f.authorityIdentity,
      digest,
    ),
  );
  assert.throws(
    () =>
      parseDevelopmentDeliveryIntegrity(
        { ...f.operation, plan: { ...f.plan, title: "Mutated title" } },
        digest,
      ),
    { code: "DELIVERY_INTEGRITY" },
  );
  assert.throws(
    () =>
      parseDevelopmentDeliveryIntegrity(
        { ...f.operation, events: [{ ...f.operation.events[0], sequence: 2 }] },
        digest,
      ),
    { code: "DELIVERY_INTEGRITY" },
  );
  const running = withDevelopmentDeliveryEvent(
    f.operation,
    "delivery.reserved",
    "Synthetic durable reservation",
    f.target.observedAt,
    {
      status: "running",
      workerId: randomUUID(),
      attemptId: randomUUID(),
      phase: "reserved",
    },
  );
  assert.equal(
    parseDevelopmentDeliveryIntegrity(running, digest).status,
    "running",
  );
  const published = withDevelopmentDeliveryEvent(
    running,
    "delivery.published",
    "Synthetic read-only verification",
    f.receipt.publishedAt,
    { status: "published", receipt: f.receipt },
  );
  assert.equal(
    parseDevelopmentDeliveryIntegrity(published, digest).receipt!.headSha,
    f.plan.commitOid,
  );
  assert.throws(
    () =>
      parseDevelopmentDeliveryIntegrity(
        { ...published, receipt: { ...f.receipt, prNumber: 8 } },
        digest,
      ),
    { code: "DELIVERY_INTEGRITY" },
  );
  assert.deepEqual(f.run, before);
});

test("a retained CI pass requires complete successful evidence for the exact current head", () => {
  const f = approvedDeliveryFixture(),
    published = withDevelopmentDeliveryEvent(
      f.operation,
      "delivery.published",
      "Synthetic publication observation",
      f.receipt.publishedAt,
      { status: "published", receipt: f.receipt },
    );
  const ci = {
    observedAt: f.target.observedAt,
    headSha: f.plan.commitOid,
    currentHeadSha: f.plan.commitOid,
    currentBaseSha: f.plan.targetSha,
    targetDrift: false,
    state: "passed" as const,
    truncated: false,
    reason: null,
    runs: [
      {
        id: 1,
        workflowName: "Vuzmi checks",
        workflowId: 2,
        workflowPath: ".github/workflows/checks.yml",
        runAttempt: 1,
        baseSha: f.plan.targetSha,
        observedPrMergeSha: null,
        event: "pull_request",
        headSha: f.plan.commitOid,
        status: "completed",
        conclusion: "success",
        url: "https://github.com/Ether-X-UK/Vuzmi/actions/runs/1",
      },
    ],
  };
  const observed = withDevelopmentDeliveryEvent(
    published,
    "delivery.ci_observed",
    "Synthetic CI evidence",
    f.target.observedAt,
    { ci },
  );
  assert.equal(
    parseDevelopmentDeliveryIntegrity(observed, digest).ci!.state,
    "passed",
  );
  for (const changed of [
    { ...ci, runs: [] },
    { ...ci, truncated: true },
    { ...ci, currentHeadSha: "9".repeat(40) },
    { ...ci, targetDrift: true },
    { ...ci, runs: [{ ...ci.runs[0], headSha: "9".repeat(40) }] },
    { ...ci, runs: [{ ...ci.runs[0], conclusion: "skipped" }] },
  ])
    assert.throws(
      () =>
        parseDevelopmentDeliveryIntegrity({ ...observed, ci: changed }, digest),
      { code: "DELIVERY_INTEGRITY" },
    );
});
