import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeApplicationPlan,
  applicationDecisionReady,
  applicationOperationMatchesRun,
  applicationPlanMatchesRun,
  applicationVersion,
  captureApplicationRequest,
  confirmApplicationRefresh,
  initialApplicationReview,
  newerApplication,
  openApplicationPlan,
  receiveApplicationPlan,
  requireApplicationRefresh,
} from "../src/developmentApplicationReview";
import {
  uiApplication,
  uiAppliedApplication,
  uiApprovedRun,
} from "./development-ui-fixtures";

const requestId = "1cbf5372-27ef-4960-88c3-780895bd38c1";
test("package approval alone never enables local branch application; exact plan must be opened and acknowledged", () => {
  const plan = uiApplication().plan,
    state = initialApplicationReview(plan),
    shown = applicationVersion(plan)!;
  assert.equal(applicationDecisionReady(state, shown), false);
  assert.equal(
    captureApplicationRequest(
      acknowledgeApplicationPlan(state, shown),
      shown,
      () => requestId,
    ),
    null,
  );
  const opened = openApplicationPlan(state),
    acknowledged = acknowledgeApplicationPlan(opened, shown);
  assert.equal(applicationDecisionReady(acknowledged, shown), true);
  assert.deepEqual(
    captureApplicationRequest(acknowledged, shown, () => requestId)!.input,
    {
      requestId,
      packageSha256: plan.packageSha256,
      planFingerprint: plan.fingerprint,
    },
  );
});
test("a replacement plan stays separate from displayedA and B acknowledgment cannot authorize C", () => {
  const a = uiApplication().plan,
    b = { ...a, fingerprint: "b".repeat(64) },
    c = { ...a, fingerprint: "c".repeat(64) };
  const openedA = openApplicationPlan(initialApplicationReview(a));
  const acknowledgedA = acknowledgeApplicationPlan(
    openedA,
    applicationVersion(a)!,
  );
  const receivedB = receiveApplicationPlan(acknowledgedA, b);
  assert.equal(receivedB.displayed, a);
  assert.equal(
    applicationDecisionReady(receivedB, applicationVersion(a)),
    false,
  );
  const openedB = openApplicationPlan(receivedB),
    receivedC = receiveApplicationPlan(openedB, c);
  assert.equal(receivedC.displayed, b);
  assert.equal(
    acknowledgeApplicationPlan(receivedC, applicationVersion(b)!).acknowledged,
    null,
  );
});
test("uncertain authorization keeps request identity and requires explicit status refresh plus renewed exact review", () => {
  const plan = uiApplication().plan,
    shown = applicationVersion(plan)!;
  const ready = acknowledgeApplicationPlan(
    openApplicationPlan(initialApplicationReview(plan)),
    shown,
  );
  const captured = captureApplicationRequest(ready, shown, () => requestId)!;
  const unknown = requireApplicationRefresh(captured.state),
    polled = receiveApplicationPlan(unknown, { ...plan });
  assert.equal(polled.refreshRequired, true);
  assert.equal(openApplicationPlan(polled), polled);
  const refreshed = confirmApplicationRefresh(polled);
  assert.equal(applicationDecisionReady(refreshed, shown), false);
  const rereviewed = acknowledgeApplicationPlan(
    openApplicationPlan(refreshed),
    shown,
  );
  assert.deepEqual(
    captureApplicationRequest(rereviewed, shown, () => {
      throw new Error("Retry must not allocate another identity");
    })!.input,
    captured.input,
  );
});
test("new run or explicit replacement review cannot inherit another plan's acknowledgment or captured payload", () => {
  const a = uiApplication().plan,
    other = uiApplication().plan,
    shown = applicationVersion(a)!;
  const captured = captureApplicationRequest(
    acknowledgeApplicationPlan(
      openApplicationPlan(initialApplicationReview(a)),
      shown,
    ),
    shown,
    () => requestId,
  )!;
  const switched = receiveApplicationPlan(captured.state, other);
  assert.equal(switched.attempt, null);
  assert.equal(switched.acknowledged, null);
  const b = { ...a, fingerprint: "b".repeat(64) };
  const replacement = openApplicationPlan(
    receiveApplicationPlan(
      confirmApplicationRefresh(requireApplicationRefresh(captured.state)),
      b,
    ),
  );
  assert.equal(replacement.attempt, null);
});
test("application plan must match exact approved package/base/fixed branch and every changed file hash", () => {
  const run = uiApprovedRun(true),
    plan = uiApplication(run).plan;
  assert.equal(applicationPlanMatchesRun(plan, run), true);
  for (const bad of [
    { ...plan, packageSha256: "0".repeat(64) },
    { ...plan, destinationRef: "refs/heads/main" },
    { ...plan, baseCommit: "0".repeat(40) },
    { ...plan, profileHash: "0".repeat(64) },
    { ...plan, files: [{ ...plan.files[0], afterSha256: "0".repeat(64) }] },
  ])
    assert.equal(applicationPlanMatchesRun(bad, run), false);
  assert.equal(
    applicationPlanMatchesRun(plan, { ...run, status: "waiting_approval" }),
    false,
  );
});
test("late status cannot replace an applied receipt or change the authorization identity", () => {
  const run = uiApprovedRun(),
    applied = uiAppliedApplication(run);
  assert.equal(
    newerApplication(applied, {
      ...applied,
      revision: applied.revision - 1,
      status: "running",
      receipt: undefined,
    }),
    applied,
  );
  assert.equal(
    newerApplication(applied, {
      ...applied,
      revision: applied.revision + 1,
      status: "unconfirmed",
      receipt: undefined,
    }),
    applied,
  );
  assert.throws(
    () => newerApplication(applied, uiApplication(run)),
    /different authorization/,
  );
});
test("an applied label needs a receipt correlated to the package, branch, actor and prepared objects", () => {
  const run = uiApprovedRun(),
    operation = uiAppliedApplication(run);
  assert.equal(applicationOperationMatchesRun(operation, run), true);
  assert.equal(
    applicationOperationMatchesRun({ ...operation, receipt: undefined }, run),
    false,
  );
  assert.equal(
    applicationOperationMatchesRun(
      {
        ...operation,
        receipt: { ...operation.receipt!, commitOid: "0".repeat(40) },
      },
      run,
    ),
    false,
  );
  assert.equal(
    applicationOperationMatchesRun(
      {
        ...operation,
        receipt: { ...operation.receipt!, packageSha256: "0".repeat(64) },
      },
      run,
    ),
    false,
  );
  assert.equal(
    applicationOperationMatchesRun(
      {
        ...operation,
        receipt: {
          ...operation.receipt!,
          files: operation.receipt!.files.map((file) => ({
            ...file,
            mode: "100755",
          })),
        },
      },
      run,
    ),
    false,
  );
  assert.equal(
    applicationOperationMatchesRun({ ...operation, status: "running" }, run),
    false,
  );
});
