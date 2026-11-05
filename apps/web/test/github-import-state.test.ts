import assert from "node:assert/strict";
import test from "node:test";
import type { GithubPreview, Source } from "@vuzmi/core";
import {
  acceptGithubPreview,
  beginGithubImport,
  beginGithubPreview,
  changeGithubInput,
  completeGithubImport,
  githubPreviewExpired,
  initialGithubImport,
  matchesGithubImport,
  observeGithubSourceList,
  resolveGithubSavedSource,
} from "../src/githubImportState";

const now = Date.parse("2026-11-05T12:00:00.000Z");
const input = {
  commit: "a".repeat(40),
  path: "docs/owned.md",
  title: "Owned source fixture",
};
function preview(): GithubPreview {
  return {
    previewId: "c20d86a6-467b-40db-8a8f-9361f2748881",
    expiresAt: new Date(now + 300_000).toISOString(),
    fingerprint: "b".repeat(64),
    title: input.title,
    format: "markdown",
    text: "# Owned source fixture\n\nUntrusted fixture context.",
    origin: {
      kind: "github-public",
      repositoryId: 42,
      owner: "Ether-X-UK",
      repository: "Vuzmi",
      path: input.path,
      gitHashAlgorithm: "sha1",
      commitOid: input.commit,
      blobOid: "c".repeat(40),
      rawSha256: "d".repeat(64),
      rawBytes: 60,
      normalizedSha256: "e".repeat(64),
      normalizedBytes: 50,
      normalizationVersion: "plain-text-v1",
      fetchedAt: new Date(now).toISOString(),
    },
  };
}
function start() {
  return beginGithubPreview(changeGithubInput(initialGithubImport(), input));
}
function ready() {
  const begun = start();
  return acceptGithubPreview(begun.state, begun.generation, preview(), now);
}

test("A→B→A inputs cannot accept the first A response", () => {
  const a = start();
  const b = changeGithubInput(a.state, { ...input, path: "docs/other.md" });
  const aAgain = changeGithubInput(b, input);
  assert.equal(
    acceptGithubPreview(aAgain, a.generation, preview(), now).preview,
    null,
  );
  const fresh = beginGithubPreview(aAgain);
  assert.equal(
    acceptGithubPreview(fresh.state, fresh.generation, preview(), now).preview
      ?.origin.path,
    input.path,
  );
});

test("a response must match the requested commit, path, local title and expiry", () => {
  const begun = start();
  const expected = preview();
  for (const received of [
    { ...expected, title: "Different local title" },
    { ...expected, origin: { ...expected.origin, commitOid: "f".repeat(40) } },
    { ...expected, origin: { ...expected.origin, path: "docs/other.md" } },
    { ...expected, expiresAt: new Date(now).toISOString() },
  ])
    assert.equal(
      acceptGithubPreview(begun.state, begun.generation, received, now).preview,
      null,
    );
});

test("new preview requests invalidate older responses even when inputs are unchanged", () => {
  const first = start();
  const second = beginGithubPreview(first.state);
  assert.equal(
    acceptGithubPreview(second.state, first.generation, preview(), now).preview,
    null,
  );
  assert.ok(
    acceptGithubPreview(second.state, second.generation, preview(), now)
      .preview,
  );
});

test("first save requires an unexpired preview; uncertain exact receipt retries survive expiry", () => {
  const state = ready();
  const expiry = Date.parse(state.preview!.expiresAt);
  assert.equal(githubPreviewExpired(state, expiry - 1), false);
  assert.equal(githubPreviewExpired(state, expiry), true);
  assert.throws(
    () => beginGithubImport(state, expiry, () => "not-created"),
    /expired/,
  );
  const first = beginGithubImport(
    state,
    expiry - 1,
    () => "8c32f7e9-5bab-4ad7-bfbe-d82bd85a606b",
  );
  const retried = beginGithubImport(first.state, expiry + 10_000, () => {
    throw new Error("A retry must not allocate another identity");
  });
  assert.deepEqual(retried.input, first.input);
  assert.equal(retried.input.previewId, state.preview!.previewId);
  assert.equal(retried.input.fingerprint, state.preview!.fingerprint);
});

test("changing a reviewed input clears the preview and retry identity; old save cannot complete another view", () => {
  const saving = beginGithubImport(
    ready(),
    now,
    () => "8c32f7e9-5bab-4ad7-bfbe-d82bd85a606b",
  );
  const changed = changeGithubInput(saving.state, {
    ...input,
    title: "Another local title",
  });
  assert.equal(changed.preview, null);
  assert.equal(changed.attempt, null);
  assert.equal(
    matchesGithubImport(changed, saving.generation, saving.input),
    false,
  );
  assert.equal(
    completeGithubImport(changed, saving.generation, saving.input),
    null,
  );
  assert.throws(
    () => beginGithubImport(changed, now, () => "not-created"),
    /Preview/,
  );
});

test("only a matching save completion clears the form and consumes its generation", () => {
  const saving = beginGithubImport(
    ready(),
    now,
    () => "8c32f7e9-5bab-4ad7-bfbe-d82bd85a606b",
  );
  assert.equal(
    completeGithubImport(saving.state, saving.generation, {
      ...saving.input,
      fingerprint: "f".repeat(64),
    }),
    null,
  );
  const completed = completeGithubImport(
    saving.state,
    saving.generation,
    saving.input,
  )!;
  assert.deepEqual(completed.input, initialGithubImport().input);
  assert.equal(completed.preview, null);
  assert.equal(completed.attempt, null);
  assert.equal(
    completeGithubImport(completed, saving.generation, saving.input),
    null,
  );
});

test("a new explicit preview creates a new receipt identity and rejects an old completion", () => {
  const first = beginGithubImport(
    ready(),
    now,
    () => "8c32f7e9-5bab-4ad7-bfbe-d82bd85a606b",
  );
  const nextPreview = beginGithubPreview(first.state);
  const nextReady = acceptGithubPreview(
    nextPreview.state,
    nextPreview.generation,
    { ...preview(), previewId: "10e82799-de21-4d69-bdaa-975bb56317c5" },
    now,
  );
  const second = beginGithubImport(
    nextReady,
    now,
    () => "12b9b93e-20d3-40cc-a531-a68341d07da7",
  );
  assert.notEqual(second.input.importId, first.input.importId);
  assert.equal(
    completeGithubImport(second.state, first.generation, first.input),
    null,
  );
});

function savedSource(): Source {
  return {
    id: "d8a15b98-9ae9-4b15-82ba-03343ca39cf2",
    workspaceId: "local-workspace",
    title: input.title,
    format: "markdown",
    revision: 1,
    activeRevision: null,
    status: "queued",
    contentHash: "a".repeat(64),
    chunkCount: 0,
    profile: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    error: null,
    origin: preview().origin,
  };
}

test("a saved response bridges only to the first later source list and never revives after list ABA", () => {
  const source = savedSource();
  const beforeResponse: Source[] = [];
  let observed = {
    sources: beforeResponse as readonly Source[],
    generation: 0,
  };
  // A refresh during the save is not the post-response refresh being awaited.
  observed = observeGithubSourceList(observed, []);
  const responseGeneration = observed.generation;
  assert.equal(
    resolveGithubSavedSource(source, responseGeneration, observed),
    source,
  );
  assert.equal(observeGithubSourceList(observed, observed.sources), observed);
  observed = observeGithubSourceList(observed, []);
  assert.equal(
    resolveGithubSavedSource(source, responseGeneration, observed),
    null,
  );
  observed = observeGithubSourceList(observed, beforeResponse);
  assert.equal(
    resolveGithubSavedSource(source, responseGeneration, observed),
    null,
  );
});

test("current source status supersedes a queued save response and its later absence stays unavailable", () => {
  const source = savedSource();
  const readySource: Source = {
    ...source,
    status: "ready",
    activeRevision: 1,
    chunkCount: 3,
  };
  const observed = { sources: [readySource], generation: 7 };
  assert.equal(resolveGithubSavedSource(source, 7, observed), readySource);
  const refreshed = observeGithubSourceList(observed, []);
  assert.equal(resolveGithubSavedSource(source, 7, refreshed), null);
});
