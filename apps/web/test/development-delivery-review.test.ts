import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeDeliveryPlan,
  captureDeliveryRequest,
  confirmDeliveryRefresh,
  deliveryCiState,
  deliveryDecisionReady,
  deliveryOperationMatchesRun,
  deliveryPlanMatchesRun,
  deliveryVersion,
  editDeliveryDraft,
  initialDeliveryReview,
  newerDelivery,
  openDeliveryPlan,
  receiveDeliveryPlan,
  requireDeliveryRefresh,
} from "../src/developmentDeliveryReview";
import {
  uiDelivery,
  uiDeliveryCi,
  uiDeliveryPlan,
  uiPublishedDelivery,
} from "./development-delivery-fixtures";
import { uiApprovedRun } from "./development-ui-fixtures";

const requestId = "2caea3f2-d2aa-473f-871d-a347e41c05d9";
function prepared(plan = uiDeliveryPlan()) {
  const draft = { title: plan.title, body: plan.inputBody };
  return receiveDeliveryPlan(initialDeliveryReview(draft), plan, draft);
}
function ready(plan = uiDeliveryPlan()) {
  return acknowledgeDeliveryPlan(
    openDeliveryPlan(prepared(plan)),
    deliveryVersion(plan)!,
  );
}
test("package and application approvals never enable publication without opening and acknowledging the exact delivery plan", () => {
  const plan = uiDeliveryPlan(),
    state = prepared(plan),
    shown = deliveryVersion(plan)!;
  assert.equal(deliveryDecisionReady(state, shown), false);
  assert.equal(
    captureDeliveryRequest(
      acknowledgeDeliveryPlan(state, shown),
      shown,
      () => requestId,
    ),
    null,
  );
  assert.equal(deliveryDecisionReady(ready(plan), shown), true);
});
test("editing either public text field invalidates review without replacing the displayed plan", () => {
  const plan = uiDeliveryPlan(),
    state = ready(plan),
    shown = deliveryVersion(plan)!;
  for (const draft of [
    { ...state.draft, title: "A changed public title" },
    { ...state.draft, body: "A changed public body" },
  ]) {
    const edited = editDeliveryDraft(state, draft);
    assert.equal(edited.displayed, state.displayed);
    assert.deepEqual(edited.draft, draft);
    assert.equal(deliveryDecisionReady(edited, shown), false);
    assert.equal(openDeliveryPlan(edited), edited);
    assert.equal(receiveDeliveryPlan(edited, plan, state.draft), edited);
  }
});
test("target or authority replacement stays separate from the displayed snapshot and old acknowledgment cannot select it", () => {
  const a = uiDeliveryPlan(),
    b = { ...a, targetSha: "e".repeat(40), fingerprint: "b".repeat(64) },
    state = ready(a);
  const received = receiveDeliveryPlan(state, b, state.draft);
  assert.equal(received.displayed!.plan, a);
  assert.equal(deliveryDecisionReady(received, deliveryVersion(a)), false);
  const openedB = openDeliveryPlan(received),
    c = {
      ...b,
      authorityIdentity: "c".repeat(64),
      fingerprint: "c".repeat(64),
    };
  const receivedC = receiveDeliveryPlan(openedB, c, state.draft);
  assert.equal(receivedC.displayed!.plan, b);
  assert.equal(
    acknowledgeDeliveryPlan(receivedC, deliveryVersion(b)!).acknowledged,
    null,
  );
});
test("an uncertain authorization retains one exact UUID and body, requires explicit status refresh and renewed review", () => {
  const plan = uiDeliveryPlan(),
    shown = deliveryVersion(plan)!;
  const captured = captureDeliveryRequest(ready(plan), shown, () => requestId)!;
  assert.equal(captured.input.body, plan.inputBody);
  assert.notEqual(captured.input.body, plan.body);
  const unknown = requireDeliveryRefresh(captured.state),
    polled = receiveDeliveryPlan(unknown, { ...plan }, captured.state.draft);
  assert.equal(polled.refreshRequired, true);
  assert.equal(openDeliveryPlan(polled), polled);
  const refreshed = confirmDeliveryRefresh(polled);
  assert.equal(deliveryDecisionReady(refreshed, shown), false);
  const rereviewed = acknowledgeDeliveryPlan(
    openDeliveryPlan(refreshed),
    shown,
  );
  assert.deepEqual(
    captureDeliveryRequest(rereviewed, shown, () => {
      throw new Error("Must retain exact UUID");
    })!.input,
    captured.input,
  );
});
test("deliberate replacement review cannot inherit an earlier request payload", () => {
  const a = uiDeliveryPlan(),
    shown = deliveryVersion(a)!;
  const captured = captureDeliveryRequest(ready(a), shown, () => requestId)!;
  const b = { ...a, fingerprint: "b".repeat(64) };
  const replaced = openDeliveryPlan(
    receiveDeliveryPlan(captured.state, b, captured.state.draft),
  );
  assert.equal(replaced.attempt, null);
  assert.equal(replaced.acknowledged, null);
});
test("delivery plans must match the exact approved package, base, branch and changed file hashes", () => {
  const run = uiApprovedRun(true),
    plan = uiDeliveryPlan(run);
  assert.equal(deliveryPlanMatchesRun(plan, run), true);
  for (const bad of [
    { ...plan, packageSha256: "0".repeat(64) },
    { ...plan, baseCommit: "0".repeat(40) },
    { ...plan, destinationRef: "refs/heads/main" },
    { ...plan, files: [{ ...plan.files[0], afterSha256: "0".repeat(64) }] },
  ])
    assert.equal(deliveryPlanMatchesRun(bad, run), false);
});
test("published UI needs a correlated receipt; another head or changed public text cannot become success", () => {
  const run = uiApprovedRun(true),
    operation = uiPublishedDelivery(run);
  assert.equal(deliveryOperationMatchesRun(operation, run), true);
  assert.equal(
    deliveryOperationMatchesRun({ ...operation, receipt: undefined }, run),
    false,
  );
  for (const receipt of [
    { ...operation.receipt!, headSha: "0".repeat(40) },
    { ...operation.receipt!, body: "Unreviewed body" },
    { ...operation.receipt!, headRef: "main" },
  ])
    assert.equal(
      deliveryOperationMatchesRun({ ...operation, receipt }, run),
      false,
    );
});
test("late polling cannot replace a newer revision or a completed publication receipt", () => {
  const operation = uiPublishedDelivery();
  assert.equal(
    newerDelivery(operation, {
      ...operation,
      revision: operation.revision - 1,
    }),
    operation,
  );
  assert.equal(
    newerDelivery(operation, {
      ...operation,
      revision: operation.revision + 1,
      status: "unconfirmed",
      receipt: undefined,
    }),
    operation,
  );
  assert.throws(
    () => newerDelivery(operation, uiDelivery()),
    /another authorization/,
  );
  assert.throws(
    () =>
      newerDelivery(operation, {
        ...operation,
        revision: operation.revision + 1,
        receipt: { ...operation.receipt!, prNumber: 13 },
      }),
    /changed an already recorded/,
  );
});
test("no workflow runs and truncated success cannot be rendered as passing CI", () => {
  const ci = uiDeliveryCi();
  assert.equal(deliveryCiState(ci, ci.headSha), "passed");
  assert.equal(
    deliveryCiState({ ...ci, targetDrift: true }, ci.headSha),
    "stale",
  );
  assert.equal(deliveryCiState({ ...ci, runs: [] }, ci.headSha), "waiting");
  assert.equal(
    deliveryCiState({ ...ci, truncated: true }, ci.headSha),
    "unavailable",
  );
});
test("moved head, another run's head and unavailable observations never inherit a prior green result", () => {
  const ci = uiDeliveryCi();
  assert.equal(
    deliveryCiState({ ...ci, currentHeadSha: "0".repeat(40) }, ci.headSha),
    "stale",
  );
  assert.equal(
    deliveryCiState(
      { ...ci, runs: [{ ...ci.runs[0], headSha: "0".repeat(40) }] },
      ci.headSha,
    ),
    "stale",
  );
  assert.equal(
    deliveryCiState({ ...ci, state: "unavailable", runs: [] }, ci.headSha),
    "unavailable",
  );
  assert.equal(
    deliveryCiState({ ...ci, state: "running" }, ci.headSha),
    "running",
  );
  assert.equal(
    deliveryCiState({ ...ci, state: "failed" }, ci.headSha),
    "failed",
  );
});
