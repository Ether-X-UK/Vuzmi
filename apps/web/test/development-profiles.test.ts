import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDevelopmentAdmission,
  developmentProfileAvailable,
  developmentProfiles,
  observeDevelopmentProfile,
} from "../src/developmentProfiles";
import { developmentVersion } from "../src/developmentReview";
import { uiProfile, uiRuntime, uiWaitingRun } from "./development-ui-fixtures";

const fields = {
  title: "Owner task fixture",
  brief: "Preserve this exact task and pinned source context.",
  issueNumber: "",
};
test("polling cannot replace a selected snapshot even when the default and catalog change", () => {
  const a = uiProfile(true),
    b = uiProfile(true, "b".repeat(40));
  const selected = observeDevelopmentProfile(null, uiRuntime(a, [a]));
  assert.equal(selected, a);
  assert.equal(observeDevelopmentProfile(selected, uiRuntime(b, [b])), a);
  assert.equal(developmentProfileAvailable(a, uiRuntime(b, [b])), false);
  assert.equal(developmentProfileAvailable(a, uiRuntime(b, [a, b])), true);
});
test("legacy runtime fallback remains compatible while an explicit empty catalog stays unavailable", () => {
  const a = uiProfile();
  assert.deepEqual(developmentProfiles(uiRuntime(a)), [a]);
  assert.deepEqual(developmentProfiles(uiRuntime(a, [])), []);
  assert.equal(observeDevelopmentProfile(null, uiRuntime(a, [])), null);
});
test("exact admission retry freezes profile, model, UUID and payload despite readiness/default changes", () => {
  const profile = uiProfile(true);
  const first = captureDevelopmentAdmission(
    null,
    fields,
    profile,
    "original-model",
    () => "7dd80ddc-e9a2-485a-973b-09439904eb43",
  );
  const retry = captureDevelopmentAdmission(
    first,
    fields,
    profile,
    "new-default-model",
    () => {
      throw new Error("Exact retry must retain its request identity");
    },
  );
  assert.equal(retry, first);
  assert.equal(retry.input.profileHash, profile.profileHash);
  assert.equal(retry.input.model, "original-model");
});
test("an explicit task/profile change creates a distinct payload identity; missing profiles cannot start", () => {
  const a = uiProfile(),
    b = uiProfile(true);
  const first = captureDevelopmentAdmission(
    null,
    fields,
    a,
    "fixture-model",
    () => "7dd80ddc-e9a2-485a-973b-09439904eb43",
  );
  const changed = captureDevelopmentAdmission(
    first,
    fields,
    b,
    "fixture-model",
    () => "61a4e13c-fbf3-4454-9996-7a62b0822e9c",
  );
  assert.notEqual(changed.input.requestId, first.input.requestId);
  assert.equal(changed.input.profileHash, b.profileHash);
  assert.throws(
    () =>
      captureDevelopmentAdmission(
        null,
        fields,
        null,
        "fixture-model",
        () => "unused",
      ),
    /Select an available/,
  );
});
test("reusable review requires its passing19-check baseline and candidate; legacy reproduction remains eligible", () => {
  const reusable = uiWaitingRun(true),
    legacy = uiWaitingRun();
  assert.ok(developmentVersion(reusable));
  assert.ok(developmentVersion(legacy));
  assert.equal(
    developmentVersion({
      ...reusable,
      baseline: { ...reusable.baseline!, status: "failed" },
    }),
    null,
  );
  assert.equal(
    developmentVersion({
      ...reusable,
      checks: { ...reusable.checks!, tests: reusable.checks!.tests.slice(1) },
    }),
    null,
  );
});
