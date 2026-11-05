import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GithubPreviewInput, Source } from "@vuzmi/core";
import { ApiError } from "./api";
import { GithubProvenance } from "./GithubOrigin";
import { importGithubFile, previewGithubFile } from "./knowledgeApi";
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
  type GithubImportState,
  type GithubSourceListObservation,
} from "./githubImportState";
import { Icon } from "./icons";

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The operation could not complete. Try again explicitly.";
}

export function GithubImport({
  sources,
  onImported,
  onViewSource,
  onClose,
}: {
  sources: Source[];
  onImported: (source: Source, replayed: boolean) => void;
  onViewSource: (source: Source) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState(initialGithubImport);
  const current = useRef(state);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const pending = useRef<"preview" | "save" | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [saved, setSaved] = useState<{
    source: Source;
    replayed: boolean;
    sourceListGeneration: number;
  } | null>(null);
  const sourceList = useRef<GithubSourceListObservation>({
    sources,
    generation: 0,
  });
  sourceList.current = observeGithubSourceList(sourceList.current, sources);
  const [now, setNow] = useState(Date.now);
  const commitField = useRef<HTMLInputElement>(null);
  const update = (next: GithubImportState) => {
    current.current = next;
    setState(next);
  };

  useEffect(() => {
    active.current = true;
    commitField.current?.focus();
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active.current = false;
      request.current?.abort();
      window.clearInterval(interval);
    };
  }, []);

  const change = (field: keyof GithubPreviewInput, value: string) => {
    if (pending.current === "save") return;
    update(
      changeGithubInput(current.current, {
        ...current.current.input,
        [field]: value,
      }),
    );
    setError(null);
    setUncertain(false);
    setSaved(null);
  };
  const preview = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    let started: ReturnType<typeof beginGithubPreview>;
    try {
      started = beginGithubPreview(current.current);
    } catch {
      setError(
        "Enter a full 40-character lowercase commit, a valid relative .md/.txt path, and a local title of 3–120 characters.",
      );
      return;
    }
    update(started.state);
    setError(null);
    setUncertain(false);
    setSaved(null);
    pending.current = "preview";
    setBusy("preview");
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    try {
      const received = await previewGithubFile(
        started.input,
        controller.signal,
      );
      if (!active.current || current.current.generation !== started.generation)
        return;
      const accepted = acceptGithubPreview(
        current.current,
        started.generation,
        received,
        Date.now(),
      );
      update(accepted);
      if (accepted.preview !== received)
        setError(
          "The returned preview is expired or does not match the current inputs. Preview the file again.",
        );
    } catch (caught) {
      if (active.current && current.current.generation === started.generation) {
        setError(
          timedOut
            ? "The preview request timed out. Preview again explicitly when the backend is reachable."
            : message(caught),
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (active.current) {
        pending.current = null;
        setBusy(null);
      }
    }
  };
  const save = async () => {
    if (pending.current) return;
    let started: ReturnType<typeof beginGithubImport>;
    try {
      started = beginGithubImport(current.current, Date.now(), () =>
        crypto.randomUUID(),
      );
    } catch (caught) {
      setError(message(caught));
      return;
    }
    update(started.state);
    setError(null);
    setUncertain(false);
    pending.current = "save";
    setBusy("save");
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await importGithubFile(started.input, controller.signal);
      if (!active.current) return;
      const next = completeGithubImport(
        current.current,
        started.generation,
        started.input,
      );
      if (!next) return;
      update(next);
      setSaved({
        ...result,
        sourceListGeneration: sourceList.current.generation,
      });
      onImported(result.source, result.replayed);
    } catch (caught) {
      if (
        !active.current ||
        !matchesGithubImport(current.current, started.generation, started.input)
      )
        return;
      setError(message(caught));
      setUncertain(
        caught instanceof ApiError &&
          (caught.status === 0 ||
            caught.status >= 500 ||
            caught.code === "INVALID_RESPONSE"),
      );
    } finally {
      window.clearTimeout(timeout);
      if (active.current) {
        pending.current = null;
        setBusy(null);
      }
    }
  };

  const expired = githubPreviewExpired(state, now);
  const previewed = state.preview;
  const observedSource =
    saved &&
    resolveGithubSavedSource(
      saved.source,
      saved.sourceListGeneration,
      sourceList.current,
    );
  return (
    <section
      className="github-import-panel"
      aria-labelledby="github-import-title"
    >
      <div className="github-import-heading">
        <div>
          <div className="section-kicker">PUBLIC FILE / LOCAL KNOWLEDGE</div>
          <h2 id="github-import-title">Import from GitHub</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Close GitHub import"
          disabled={busy === "save"}
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <p className="github-import-intro">
        One file from <strong>Ether-X-UK/Vuzmi</strong>, pinned to one commit.
        Review the text before saving a read-only local snapshot for indexing.
      </p>
      <form
        className="knowledge-form github-import-form"
        onSubmit={(event) => {
          void preview(event);
        }}
      >
        <label htmlFor="github-commit" className="field-label">
          Full commit
        </label>
        <input
          ref={commitField}
          id="github-commit"
          value={state.input.commit}
          onChange={(event) => change("commit", event.target.value)}
          disabled={busy === "save"}
          minLength={40}
          maxLength={40}
          pattern="[a-f0-9]{40}"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          placeholder="40-character commit SHA"
          aria-describedby="github-commit-help"
        />
        <details id="github-commit-help" className="github-import-help">
          <summary>Where to find the full commit</summary>
          <p>
            Open a commit in the public repository on GitHub and copy its full
            40-character SHA. Use the complete lowercase identifier; branches,
            tags, and shortened hashes cannot pin this import.
          </p>
        </details>
        <label htmlFor="github-path" className="field-label">
          Repository-relative path
        </label>
        <input
          id="github-path"
          value={state.input.path}
          onChange={(event) => change("path", event.target.value)}
          disabled={busy === "save"}
          maxLength={400}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          placeholder="docs/ARCHITECTURE.md"
        />
        <label htmlFor="github-title" className="field-label">
          Local source title
        </label>
        <input
          id="github-title"
          value={state.input.title}
          onChange={(event) => change("title", event.target.value)}
          disabled={busy === "save"}
          minLength={3}
          maxLength={120}
          required
          placeholder="Name this source in your workspace"
        />
        <p className="knowledge-hint">
          Changing any input discards the preview and its retry identity.
          Previewing fetches the public file without saving a source.
        </p>
        <button
          className="button button-secondary"
          type="submit"
          disabled={Boolean(busy)}
        >
          <Icon
            name={busy === "preview" ? "refresh" : "knowledge"}
            className={busy === "preview" ? "spinning" : ""}
            size={17}
          />
          {busy === "preview" ? "Fetching preview…" : "Preview file"}
        </button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          {error}
          {uncertain && (
            <p>
              The save result is unconfirmed. Retry save checks the same import
              receipt. Check your sources before starting a different import.
            </p>
          )}
        </div>
      )}
      {previewed && (
        <div className="github-file-preview">
          <div className="github-preview-title">
            <h3>{previewed.title}</h3>
            <span className="github-origin-badge">Untrusted source</span>
          </div>
          <p className="knowledge-hint">
            Exact normalized{" "}
            {previewed.format === "markdown" ? "Markdown" : "plain text"} ·{" "}
            {previewed.origin.normalizedBytes.toLocaleString("en-GB")} UTF-8
            bytes. Line endings become LF and outer whitespace is trimmed. File
            contents remain untrusted context.
          </p>
          <pre
            className="source-text-preview"
            tabIndex={0}
            aria-label="Exact normalized GitHub file preview"
          >
            {previewed.text}
          </pre>
          <GithubProvenance origin={previewed.origin} />
          <details className="github-preview-identity">
            <summary>Preview identity</summary>
            <dl>
              <div>
                <dt>Fingerprint</dt>
                <dd>
                  <code>{previewed.fingerprint}</code>
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>
                  <time dateTime={previewed.expiresAt}>
                    {new Date(previewed.expiresAt).toLocaleString("en-GB")}
                  </time>
                </dd>
              </div>
            </dl>
          </details>
          <p
            className={expired ? "github-preview-expired" : "knowledge-hint"}
            role="status"
          >
            {expired
              ? state.attempt
                ? "Preview expired. Retry save can still check the existing receipt; if nothing was saved, obtain a new preview."
                : "Preview expired. Preview the file again before saving."
              : `Preview expires ${new Date(previewed.expiresAt).toLocaleTimeString("en-GB")}.`}
          </p>
          <button
            type="button"
            className="button button-primary"
            disabled={Boolean(busy) || (expired && !state.attempt)}
            onClick={() => {
              void save();
            }}
          >
            <Icon
              name={busy === "save" ? "refresh" : "plus"}
              className={busy === "save" ? "spinning" : ""}
              size={17}
            />
            {busy === "save"
              ? "Saving local import…"
              : state.attempt
                ? "Retry save"
                : "Save and index locally"}
          </button>
          <p className="knowledge-hint">
            Saving queues the existing local indexing pipeline. An imported
            source becomes searchable only after its actual status is ready.
            Preview and save never execute repository instructions.
          </p>
        </div>
      )}
      {saved && observedSource && (
        <div className="github-import-success" role="status">
          <strong>
            {saved.replayed
              ? "Existing import receipt confirmed."
              : "Local source saved."}
          </strong>
          <p>
            {observedSource.title} · Revision {observedSource.revision} ·{" "}
            <span className={`source-state source-${observedSource.status}`}>
              {observedSource.status}
            </span>
          </p>
          {observedSource.error && (
            <p>
              {observedSource.error.code}: {observedSource.error.message}
            </p>
          )}
          <button
            className="button button-secondary"
            type="button"
            onClick={() => onViewSource(observedSource)}
          >
            View imported source
          </button>
        </div>
      )}
      {saved && !observedSource && (
        <div className="github-import-success" role="status">
          <strong>
            This imported source is not in the current source list.
          </strong>
          <p>
            Refresh knowledge to check its availability. The earlier save
            response does not establish its current status.
          </p>
        </div>
      )}
    </section>
  );
}
