import {
  githubPreviewInputSchema,
  type GithubImportInput,
  type GithubPreview,
  type GithubPreviewInput,
  type Source,
} from "@vuzmi/core";

export type GithubImportState = {
  generation: number;
  input: GithubPreviewInput;
  preview: GithubPreview | null;
  attempt: GithubImportInput | null;
};

export function initialGithubImport(): GithubImportState {
  return {
    generation: 0,
    input: { commit: "", path: "", title: "" },
    preview: null,
    attempt: null,
  };
}

/** Generations also fence A→B→A changes; comparing input text alone is unsafe. */
export function changeGithubInput(
  state: GithubImportState,
  input: GithubPreviewInput,
): GithubImportState {
  return {
    generation: state.generation + 1,
    input,
    preview: null,
    attempt: null,
  };
}

export function beginGithubPreview(state: GithubImportState): {
  state: GithubImportState;
  input: GithubPreviewInput;
  generation: number;
} {
  const input = githubPreviewInputSchema.parse(state.input);
  const next = {
    ...state,
    generation: state.generation + 1,
    preview: null,
    attempt: null,
  };
  return { state: next, input, generation: next.generation };
}

export function acceptGithubPreview(
  state: GithubImportState,
  generation: number,
  preview: GithubPreview,
  now: number,
): GithubImportState {
  if (generation !== state.generation) return state;
  const input = githubPreviewInputSchema.safeParse(state.input);
  if (
    !input.success ||
    preview.origin.commitOid !== input.data.commit ||
    preview.origin.path !== input.data.path ||
    preview.title !== input.data.title ||
    Date.parse(preview.expiresAt) <= now
  )
    return state;
  return { ...state, preview, attempt: null };
}

export function githubPreviewExpired(
  state: GithubImportState,
  now: number,
): boolean {
  return Boolean(state.preview && Date.parse(state.preview.expiresAt) <= now);
}

/** Receipt replay is useful after expiry; a first save always needs a live preview. */
export function beginGithubImport(
  state: GithubImportState,
  now: number,
  createId: () => string,
): {
  state: GithubImportState;
  input: GithubImportInput;
  generation: number;
} {
  if (!state.preview)
    throw new Error("Preview the current file before saving it.");
  if (state.attempt) {
    if (
      state.attempt.previewId !== state.preview.previewId ||
      state.attempt.fingerprint !== state.preview.fingerprint
    ) {
      throw new Error(
        "The save request no longer matches the displayed preview. Preview the file again.",
      );
    }
    return { state, input: state.attempt, generation: state.generation };
  }
  if (githubPreviewExpired(state, now))
    throw new Error(
      "This preview has expired. Preview the file again before starting a save.",
    );
  const input = {
    importId: createId(),
    previewId: state.preview.previewId,
    fingerprint: state.preview.fingerprint,
  };
  return {
    state: { ...state, attempt: input },
    input,
    generation: state.generation,
  };
}

export function matchesGithubImport(
  state: GithubImportState,
  generation: number,
  input: GithubImportInput,
): boolean {
  return (
    state.generation === generation &&
    state.attempt?.importId === input.importId &&
    state.attempt.previewId === input.previewId &&
    state.attempt.fingerprint === input.fingerprint
  );
}

export function completeGithubImport(
  state: GithubImportState,
  generation: number,
  input: GithubImportInput,
): GithubImportState | null {
  return matchesGithubImport(state, generation, input)
    ? { ...initialGithubImport(), generation: state.generation + 1 }
    : null;
}

export type GithubSourceListObservation = {
  sources: readonly Source[];
  generation: number;
};

/** Count list replacements so even a return to an older array cannot revive a response fallback. */
export function observeGithubSourceList(
  previous: GithubSourceListObservation,
  sources: readonly Source[],
): GithubSourceListObservation {
  return previous.sources === sources
    ? previous
    : { sources, generation: previous.generation + 1 };
}

/** A save response bridges only the wait for the first subsequent source-list refresh. */
export function resolveGithubSavedSource(
  source: Source,
  responseGeneration: number,
  observed: GithubSourceListObservation,
): Source | null {
  return (
    observed.sources.find((current) => current.id === source.id) ??
    (observed.generation === responseGeneration ? source : null)
  );
}
