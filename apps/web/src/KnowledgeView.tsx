import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  memoryInputSchema,
  memoryUpdateSchema,
  searchKnowledgeSchema,
  sourceInputSchema,
  sourceUpdateSchema,
  type EvidenceSelection,
  type EvidenceSnapshot,
  type KnowledgeSnapshot,
  type Memory,
  type Source,
  type SourceDetail,
} from "@vuzmi/core";
import {
  deleteMemory,
  deleteSource,
  getSource,
  saveMemory,
  saveSource,
  searchKnowledge,
} from "./knowledgeApi";
import {
  activeMemory,
  EvidencePanel,
  EvidencePicker,
  validSelection,
} from "./Evidence";
import { Icon } from "./icons";
import { GithubImport } from "./GithubImport";
import { GithubProvenance } from "./GithubOrigin";

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The operation could not be completed. Please try again.";
}
function date(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function corpusKey(snapshot: KnowledgeSnapshot | null): string {
  return JSON.stringify([
    snapshot?.sources.map((source) => [
      source.id,
      source.revision,
      source.activeRevision,
      source.status,
    ]),
    snapshot?.memories.map((memory) => [
      memory.id,
      memory.revision,
      memory.expiresAt,
    ]),
  ]);
}

export function KnowledgeView({
  snapshot,
  error,
  loading,
  onRefresh,
}: {
  snapshot: KnowledgeSnapshot | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"sources" | "retrieval" | "memory">("sources");
  const [githubOpen, setGithubOpen] = useState(false);
  const mounted = useRef(true);
  const sourceRequest = useRef(0);
  const sourceView = useRef(tab);
  sourceView.current = tab;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sourceRequest.current += 1;
    };
  }, []);
  const [preview, setPreview] = useState<SourceDetail | null>(null);
  const [sourceEditor, setSourceEditor] = useState<{
    detail?: SourceDetail;
  } | null>(null);
  const [memoryEditor, setMemoryEditor] = useState<{ memory?: Memory } | null>(
    null,
  );
  const [deletion, setDeletion] = useState<
    { kind: "source"; item: Source } | { kind: "memory"; item: Memory } | null
  >(null);
  const [operationBusy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const busy = operationBusy || sourceBusy;
  const [operationError, setOperationError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<EvidenceSelection>({
    sourceIds: [],
    memoryIds: [],
  });
  const [result, setResult] = useState<EvidenceSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = corpusKey(snapshot);
  const currentKey = useRef(key);
  useEffect(() => {
    if (currentKey.current !== key) {
      currentKey.current = key;
      setResult(null);
      setNotice(
        "Knowledge changed. Run the retrieval test again to see current evidence.",
      );
    }
  }, [key]);
  const changed = () => {
    setResult(null);
    setNotice(
      "Saved knowledge changed. Previous test results have been cleared.",
    );
    void onRefresh();
  };
  const openSource = async (source: Source, edit = false) => {
    const request = ++sourceRequest.current;
    const startedView = sourceView.current;
    setSourceBusy(true);
    setOperationError(null);
    try {
      const detail = await getSource(source.id);
      if (
        !mounted.current ||
        request !== sourceRequest.current ||
        startedView !== sourceView.current
      )
        return;
      if (edit && !detail.source.origin) setSourceEditor({ detail });
      else setPreview(detail);
    } catch (caught) {
      if (
        mounted.current &&
        request === sourceRequest.current &&
        startedView === sourceView.current
      )
        setOperationError(message(caught));
    } finally {
      if (mounted.current && request === sourceRequest.current)
        setSourceBusy(false);
    }
  };
  const remove = async () => {
    if (!deletion) return;
    setBusy(true);
    setOperationError(null);
    try {
      if (deletion.kind === "source") await deleteSource(deletion.item.id);
      else await deleteMemory(deletion.item.id);
      setDeletion(null);
      setPreview(null);
      changed();
    } catch (caught) {
      setOperationError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setOperationError(null);
    setResult(null);
    setNotice(null);
    const parsed = searchKnowledgeSchema.safeParse({ query, selection });
    if (!parsed.success) {
      setOperationError(
        parsed.error.issues.map((issue) => issue.message).join(" "),
      );
      return;
    }
    if (!validSelection(snapshot, selection)) {
      setOperationError(
        "Selected evidence is no longer ready. Update the selection and search again.",
      );
      return;
    }
    const startedKey = currentKey.current;
    setBusy(true);
    try {
      const evidence = await searchKnowledge(parsed.data);
      if (startedKey === currentKey.current) setResult(evidence);
      else
        setNotice(
          "Knowledge changed during this search. Search again for current evidence.",
        );
    } catch (caught) {
      setOperationError(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="standard-page-header">
        <div>
          <div className="page-eyebrow">
            <span className="eyebrow-line" />
            CONTEXT / KNOWLEDGE & MEMORY
          </div>
          <h1>
            Useful context.
            <br />
            <span>Traceable evidence.</span>
          </h1>
          <p>
            Keep source material and curated facts explicit. Test what a mission
            can retrieve before you ask it to act.
          </p>
        </div>
        <button
          className="button button-secondary"
          disabled={loading || busy}
          onClick={() => {
            void onRefresh();
          }}
        >
          <Icon
            name="refresh"
            size={17}
            className={loading ? "spinning" : ""}
          />
          Refresh knowledge
        </button>
      </div>
      {error && (
        <div className="connection-notice" role="status">
          <Icon name="alert" size={18} />
          <div>
            <strong>Knowledge could not be refreshed</strong>
            <p>
              {error}{" "}
              {snapshot
                ? "Showing the last observed workspace state."
                : "Saved runs and model controls remain separate."}
            </p>
          </div>
        </div>
      )}
      <div
        className="approval-tabs knowledge-tabs"
        role="group"
        aria-label="Knowledge sections"
      >
        {(
          [
            ["sources", "Sources", snapshot?.sources.length],
            ["retrieval", "Retrieval test", undefined],
            ["memory", "Memory", snapshot?.memories.length],
          ] as const
        ).map(([value, label, count]) => (
          <button
            key={value}
            aria-pressed={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() => {
              sourceRequest.current += 1;
              setSourceBusy(false);
              setTab(value);
              setGithubOpen(false);
              setOperationError(null);
            }}
          >
            {label}
            {count !== undefined && <span>{count}</span>}
          </button>
        ))}
      </div>
      {operationError && !deletion && (
        <div className="inline-error" role="alert">
          {operationError}
        </div>
      )}
      {busy && (
        <p className="knowledge-hint" role="status">
          Completing the knowledge operation…
        </p>
      )}
      {!snapshot ? (
        <div className="empty-state">
          <span className="empty-state-icon">
            <Icon name="knowledge" size={28} />
          </span>
          <h2>
            {loading
              ? "Opening workspace knowledge."
              : "Knowledge is not available yet."}
          </h2>
          <p>
            Knowledge requires the configured local backend. Refresh to read its
            actual source and memory state.
          </p>
        </div>
      ) : tab === "sources" ? (
        <>
          <div className="section-header">
            <div>
              <div className="section-kicker">
                OWNED MATERIAL / WORKSPACE SCOPE
              </div>
              <h2>Knowledge sources</h2>
            </div>
            <div className="knowledge-item-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                aria-expanded={githubOpen}
                onClick={() => setGithubOpen((open) => !open)}
              >
                Import from GitHub
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => setSourceEditor({})}
              >
                <Icon name="plus" size={17} />
                Add source
              </button>
            </div>
          </div>
          {githubOpen && (
            <GithubImport
              sources={snapshot.sources}
              onClose={() => setGithubOpen(false)}
              onImported={() => changed()}
              onViewSource={(source) => {
                void openSource(source);
              }}
            />
          )}
          <div className="knowledge-runtime-strip">
            <Icon
              name={snapshot.embedding.available ? "check" : "alert"}
              size={17}
            />
            <p>
              <strong>
                {snapshot.embedding.available
                  ? "Local embedding model available"
                  : "Embedding runtime unavailable"}
              </strong>
              <span>
                {snapshot.embedding.model}
                {snapshot.embedding.error
                  ? ` · ${snapshot.embedding.error}`
                  : " · Sources become searchable after indexing completes."}
              </span>
            </p>
          </div>
          {snapshot.sources.length ? (
            <ul className="knowledge-item-list">
              {snapshot.sources.map((source) => (
                <li key={source.id}>
                  <div className="knowledge-item-heading">
                    <span className="run-domain-icon">
                      <Icon name="knowledge" size={20} />
                    </span>
                    <div>
                      <button
                        className="item-title-button"
                        disabled={busy}
                        onClick={() => {
                          void openSource(source);
                        }}
                      >
                        {source.title}
                      </button>
                      <p>
                        {source.format === "markdown"
                          ? "Markdown"
                          : "Plain text"}{" "}
                        · Revision {source.revision} · {source.chunkCount}{" "}
                        passages
                        {source.origin && (
                          <>
                            {" "}
                            ·{" "}
                            <span className="github-origin-badge">
                              GitHub snapshot
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                    <span className={`source-state source-${source.status}`}>
                      {source.status}
                    </span>
                  </div>
                  <div className="knowledge-item-bottom">
                    <p>
                      {source.activeRevision === null
                        ? "No searchable revision yet"
                        : `Searchable revision ${source.activeRevision}`}
                      {source.activeRevision !== null &&
                      source.activeRevision !== source.revision
                        ? " · Latest revision is not active yet"
                        : ""}
                      <br />
                      Updated {date(source.updatedAt)}
                    </p>
                    <div>
                      {!source.origin && (
                        <button
                          className="button button-small button-secondary"
                          disabled={busy}
                          onClick={() => {
                            void openSource(source, true);
                          }}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        className="button button-small button-quiet"
                        disabled={busy}
                        onClick={() => {
                          setOperationError(null);
                          setDeletion({ kind: "source", item: source });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {source.error && (
                    <div className="inline-error">
                      <strong>{source.error.code}</strong>{" "}
                      {source.error.message}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <KnowledgeEmpty
              title="Start with a source you trust."
              text="Paste or upload a small Markdown or text document. Its actual revision and indexing state will appear here."
            />
          )}
        </>
      ) : tab === "memory" ? (
        <>
          <div className="section-header">
            <div>
              <div className="section-kicker">
                EXPLICIT / CONFIRMED / WORKSPACE
              </div>
              <h2>Curated memory</h2>
            </div>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => setMemoryEditor({})}
            >
              <Icon name="plus" size={17} />
              Save memory
            </button>
          </div>
          <p className="knowledge-hint">
            These facts are explicitly curated by the operator. Conversations
            and generated drafts do not become memory automatically.
          </p>
          {snapshot.memories.length ? (
            <ul className="knowledge-item-list memory-item-list">
              {snapshot.memories.map((memory) => (
                <li key={memory.id}>
                  <div className="knowledge-item-heading">
                    <div>
                      <h3>{memory.title}</h3>
                      <p>Workspace · Confirmed · Revision {memory.revision}</p>
                    </div>
                    <span className="planned-badge">
                      {activeMemory(memory) ? "Confirmed" : "Expired"}
                    </span>
                  </div>
                  <p className="memory-content">{memory.content}</p>
                  <p className="knowledge-hint">
                    {memory.provenance.kind === "operator"
                      ? "Provenance: manually entered by the operator"
                      : `Source: ${snapshot.sources.find((source) => source.id === (memory.provenance.kind === "source" ? memory.provenance.sourceId : ""))?.title ?? memory.provenance.sourceId} · Revision ${memory.provenance.sourceRevision}`}
                    <br />
                    {memory.expiresAt
                      ? `Expires ${date(memory.expiresAt)}`
                      : "No expiry set"}
                  </p>
                  <div className="knowledge-item-actions">
                    <button
                      className="button button-small button-secondary"
                      disabled={busy}
                      onClick={() => setMemoryEditor({ memory })}
                    >
                      Edit memory
                    </button>
                    <button
                      className="button button-small button-quiet"
                      disabled={busy}
                      onClick={() => {
                        setOperationError(null);
                        setDeletion({ kind: "memory", item: memory });
                      }}
                    >
                      Delete memory
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <KnowledgeEmpty
              title="Keep what is useful. Explicitly."
              text="Save a confirmed workspace fact with provenance and optional expiry. Nothing is retained as memory without this action."
            />
          )}
        </>
      ) : (
        <div className="retrieval-workspace">
          <form
            onSubmit={(event) => {
              void search(event);
            }}
          >
            <h2>Test the context.</h2>
            <p className="knowledge-hint">
              Search selected material using the actual local retrieval
              pipeline. This test does not generate an answer or verify a claim.
            </p>
            <label className="field-label" htmlFor="retrieval-query">
              Retrieval query
            </label>
            <textarea
              id="retrieval-query"
              minLength={3}
              maxLength={1000}
              required
              rows={3}
              value={query}
              disabled={busy}
              onChange={(event) => {
                setQuery(event.target.value);
                setResult(null);
              }}
            />
            <EvidencePicker
              snapshot={snapshot}
              selection={selection}
              disabled={busy}
              onChange={(value) => {
                setSelection(value);
                setResult(null);
              }}
            />
            <button
              className="button button-primary"
              type="submit"
              disabled={
                busy ||
                selection.sourceIds.length + selection.memoryIds.length === 0
              }
            >
              <Icon name="knowledge" size={17} />
              {busy ? "Searching selected evidence…" : "Test retrieval"}
            </button>
          </form>
          <div>
            {notice && (
              <p className="knowledge-hint" role="status">
                {notice}
              </p>
            )}
            {result ? (
              <EvidencePanel evidence={result} prefix="retrieval-test" />
            ) : (
              <KnowledgeEmpty
                title="Evidence before an answer."
                text="Choose specific sources or memories and run a query. Actual retained passages and citation identities will appear here."
              />
            )}
          </div>
        </div>
      )}
      {sourceEditor && (
        <SourceEditor
          detail={sourceEditor.detail}
          onClose={() => setSourceEditor(null)}
          onSaved={() => {
            setSourceEditor(null);
            changed();
          }}
        />
      )}
      {preview && (
        <KnowledgeDialog
          title={preview.source.title}
          onClose={() => setPreview(null)}
        >
          <p className="knowledge-hint">
            Revision {preview.source.revision} · {preview.source.status} ·
            Searchable revision {preview.source.activeRevision ?? "none"}
          </p>
          {preview.source.origin && (
            <>
              <GithubProvenance origin={preview.source.origin} />
              <p className="knowledge-hint">
                This imported snapshot is read-only. Import another commit
                explicitly to create a separate source.
              </p>
            </>
          )}
          <pre className="source-text-preview">{preview.text}</pre>
          <div className="dialog-footer">
            {!preview.source.origin && (
              <button
                className="button button-secondary"
                onClick={() => {
                  setSourceEditor({ detail: preview });
                  setPreview(null);
                }}
              >
                Edit source
              </button>
            )}
            <button
              className="button button-quiet"
              onClick={() => {
                setOperationError(null);
                setDeletion({ kind: "source", item: preview.source });
                setPreview(null);
              }}
            >
              Delete source
            </button>
          </div>
        </KnowledgeDialog>
      )}
      {memoryEditor && snapshot && (
        <MemoryEditor
          memory={memoryEditor.memory}
          sources={snapshot.sources}
          onClose={() => setMemoryEditor(null)}
          onSaved={() => {
            setMemoryEditor(null);
            changed();
          }}
        />
      )}
      {deletion && (
        <KnowledgeDialog
          title={`Delete ${deletion.kind === "source" ? "source" : "memory"}?`}
          busy={busy}
          onClose={() => setDeletion(null)}
        >
          <p className="delete-subject">{deletion.item.title}</p>
          <p className="knowledge-hint">
            {deletion.kind === "source"
              ? "This removes the source from active retrieval and deletes memories linked to it."
              : "This removes the current memory from future retrieval."}{" "}
            Historical run evidence and saved artifacts remain retained.
          </p>
          {deletion.kind === "source" && (
            <p className="knowledge-hint">
              Linked memories:{" "}
              {snapshot?.memories.filter(
                (memory) =>
                  memory.provenance.kind === "source" &&
                  memory.provenance.sourceId === deletion.item.id,
              ).length ?? 0}
            </p>
          )}
          {operationError && (
            <div className="inline-error" role="alert">
              {operationError}
            </div>
          )}
          <div className="dialog-footer">
            <button
              className="button button-secondary"
              disabled={busy}
              onClick={() => setDeletion(null)}
            >
              Keep {deletion.kind}
            </button>
            <button
              className="button button-danger"
              disabled={busy}
              onClick={() => {
                void remove();
              }}
            >
              {busy ? "Deleting…" : `Delete ${deletion.kind}`}
            </button>
          </div>
        </KnowledgeDialog>
      )}
    </>
  );
}

function KnowledgeEmpty({ title, text }: { title: string; text: string }) {
  return (
    <section className="empty-state">
      <span className="empty-state-icon">
        <Icon name="knowledge" size={26} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}

function KnowledgeDialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="mission-dialog knowledge-dialog"
      aria-labelledby="knowledge-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <span className="dialog-heading-icon">
            <Icon name="knowledge" size={23} />
          </span>
          <button
            className="icon-button"
            disabled={busy}
            aria-label="Close knowledge dialog"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <h2 id="knowledge-dialog-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

function SourceEditor({
  detail,
  onClose,
  onSaved,
}: {
  detail?: SourceDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(detail?.source.title ?? "");
  const [text, setText] = useState(detail?.text ?? "");
  const [format, setFormat] = useState<"text" | "markdown">(
    detail?.source.format ?? "markdown",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filePicked = async (file?: File) => {
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 65_536) {
      setError(
        "Choose a .md or .txt file no larger than 64 KiB. Your current draft has been kept.",
      );
      return;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      setText(content);
      if (!title.trim()) setTitle(file.name.replace(/\.(md|txt)$/i, ""));
      setFormat(/\.md$/i.test(file.name) ? "markdown" : "text");
      setError(null);
    } catch {
      setError(
        "This file could not be read as UTF-8 text. Your current draft has been kept.",
      );
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const input = {
      title,
      text,
      format,
      ...(detail ? { revision: detail.source.revision } : {}),
    };
    const parsed = detail
      ? sourceUpdateSchema.safeParse(input)
      : sourceInputSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    setBusy(true);
    try {
      await saveSource(parsed.data, detail?.source.id);
      onSaved();
    } catch (caught) {
      setError(`${message(caught)} Your unsaved text is retained.`);
      setBusy(false);
    }
  };
  return (
    <KnowledgeDialog
      title={detail ? "Update source revision." : "Add a source you own."}
      onClose={onClose}
      busy={busy}
    >
      <p className="knowledge-hint">
        Paste text or pick a .md/.txt file, up to 64 KiB.{" "}
        {detail
          ? `Editing revision ${detail.source.revision}; saving queues a new revision.`
          : "Saving queues indexing on the local worker."}
      </p>
      <form
        className="knowledge-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="field-label" htmlFor="source-file">
          Pick a text file (optional)
        </label>
        <input
          id="source-file"
          type="file"
          accept=".md,.txt,text/plain,text/markdown"
          disabled={busy}
          onChange={(event) => {
            void filePicked(event.target.files?.[0]);
          }}
        />
        <label className="field-label" htmlFor="source-title">
          Source title
        </label>
        <input
          id="source-title"
          autoFocus
          minLength={3}
          maxLength={120}
          required
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="field-label" htmlFor="source-format">
          Format
        </label>
        <select
          id="source-format"
          value={format}
          disabled={busy}
          onChange={(event) =>
            setFormat(event.target.value === "text" ? "text" : "markdown")
          }
        >
          <option value="markdown">Markdown</option>
          <option value="text">Plain text</option>
        </select>
        <label className="field-label" htmlFor="source-text">
          Source content
        </label>
        <textarea
          id="source-text"
          rows={9}
          minLength={10}
          maxLength={64000}
          required
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="knowledge-hint">
          {new TextEncoder().encode(text).byteLength.toLocaleString("en-GB")} /
          65,536 bytes
        </p>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={busy}
            type="submit"
          >
            {busy
              ? "Saving source…"
              : detail
                ? "Save new revision"
                : "Save and index source"}
          </button>
        </div>
      </form>
    </KnowledgeDialog>
  );
}

function localDateTime(value?: string | null): string {
  if (!value) return "";
  const dateValue = new Date(value);
  return new Date(dateValue.getTime() - dateValue.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function MemoryEditor({
  memory,
  sources,
  onClose,
  onSaved,
}: {
  memory?: Memory;
  sources: Source[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(memory?.title ?? "");
  const [content, setContent] = useState(memory?.content ?? "");
  const [kind, setKind] = useState<"operator" | "source">(
    memory?.provenance.kind ?? "operator",
  );
  const [sourceId, setSourceId] = useState(
    memory?.provenance.kind === "source" ? memory.provenance.sourceId : "",
  );
  const [sourceRevision, setSourceRevision] = useState(
    memory?.provenance.kind === "source" ? memory.provenance.sourceRevision : 1,
  );
  const [expiry, setExpiry] = useState(localDateTime(memory?.expiresAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const input = {
        title,
        content,
        provenance:
          kind === "operator"
            ? { kind: "operator" as const }
            : { kind: "source" as const, sourceId, sourceRevision },
        expiresAt: expiry ? new Date(expiry).toISOString() : null,
        ...(memory ? { revision: memory.revision } : {}),
      };
      const parsed = memory
        ? memoryUpdateSchema.safeParse(input)
        : memoryInputSchema.safeParse(input);
      if (!parsed.success) {
        setError(parsed.error.issues.map((issue) => issue.message).join(" "));
        return;
      }
      setBusy(true);
      await saveMemory(parsed.data, memory?.id);
      onSaved();
    } catch (caught) {
      setError(`${message(caught)} Your unsaved memory is retained.`);
      setBusy(false);
    }
  };
  return (
    <KnowledgeDialog
      title={memory ? "Edit a retained fact." : "Save a curated memory."}
      onClose={onClose}
      busy={busy}
    >
      <p className="knowledge-hint">
        Workspace scope · Confirmed by your explicit save. This is retained
        context, not independently verified truth.
      </p>
      <form
        className="knowledge-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="field-label" htmlFor="memory-title">
          Memory title
        </label>
        <input
          id="memory-title"
          autoFocus
          minLength={3}
          maxLength={120}
          required
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="field-label" htmlFor="memory-content">
          Retained fact or preference
        </label>
        <textarea
          id="memory-content"
          rows={5}
          minLength={3}
          maxLength={2000}
          required
          value={content}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
        <label className="field-label" htmlFor="memory-provenance">
          Provenance
        </label>
        <select
          id="memory-provenance"
          value={kind}
          disabled={busy}
          onChange={(event) =>
            setKind(event.target.value === "source" ? "source" : "operator")
          }
        >
          <option value="operator">Manually entered by operator</option>
          <option value="source">Linked to a source revision</option>
        </select>
        {kind === "source" && (
          <>
            <label className="field-label" htmlFor="memory-source">
              Source revision
            </label>
            <select
              id="memory-source"
              value={sourceId}
              disabled={busy}
              required
              onChange={(event) => {
                setSourceId(event.target.value);
                setSourceRevision(
                  sources.find((source) => source.id === event.target.value)
                    ?.revision ?? 1,
                );
              }}
            >
              <option value="">Choose a source</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title} · Revision {source.revision}
                </option>
              ))}
            </select>
            <p className="knowledge-hint">
              Retained provenance revision: {sourceRevision}. Deleting this
              source also deletes its linked memory.
            </p>
          </>
        )}
        <label className="field-label" htmlFor="memory-expiry">
          Expiry (optional, your local time)
        </label>
        <input
          id="memory-expiry"
          type="datetime-local"
          value={expiry}
          disabled={busy}
          onChange={(event) => setExpiry(event.target.value)}
        />
        <p className="knowledge-hint">
          Expired memory is excluded from new evidence selections. Historical
          run excerpts remain retained.
        </p>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-footer">
          <button
            className="button button-quiet"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            type="submit"
            disabled={busy}
          >
            {busy ? "Saving memory…" : "Save confirmed memory"}
          </button>
        </div>
      </form>
    </KnowledgeDialog>
  );
}
