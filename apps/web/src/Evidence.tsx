import type {
  EvidenceSelection,
  EvidenceSnapshot,
  KnowledgeSnapshot,
  Memory,
} from "@vuzmi/core";
import { Icon } from "./icons";

export function activeMemory(memory: Memory): boolean {
  return !memory.expiresAt || new Date(memory.expiresAt).getTime() > Date.now();
}
export function validSelection(
  snapshot: KnowledgeSnapshot | null,
  selection: EvidenceSelection,
): boolean {
  return Boolean(
    snapshot &&
      selection.sourceIds.every((id) =>
        snapshot.sources.some(
          (source) => source.id === id && source.status === "ready",
        ),
      ) &&
      selection.memoryIds.every((id) =>
        snapshot.memories.some(
          (memory) => memory.id === id && activeMemory(memory),
        ),
      ),
  );
}
export function EvidencePicker({
  snapshot,
  selection,
  onChange,
  disabled = false,
}: {
  snapshot: KnowledgeSnapshot;
  selection: EvidenceSelection;
  onChange: (value: EvidenceSelection) => void;
  disabled?: boolean;
}) {
  const sources = snapshot.sources.filter(
    (source) => source.status === "ready",
  );
  const memories = snapshot.memories.filter(activeMemory);
  const invalid = !validSelection(snapshot, selection);
  const toggle = (kind: "sourceIds" | "memoryIds", id: string) =>
    onChange({
      ...selection,
      [kind]: selection[kind].includes(id)
        ? selection[kind].filter((item) => item !== id)
        : [...selection[kind], id],
    });
  return (
    <div className="evidence-picker">
      <fieldset disabled={disabled}>
        <legend>
          Ready sources <span>{sources.length}</span>
        </legend>
        {sources.length ? (
          sources.map((source) => (
            <label className="evidence-option" key={source.id}>
              <input
                type="checkbox"
                checked={selection.sourceIds.includes(source.id)}
                disabled={
                  !selection.sourceIds.includes(source.id) &&
                  selection.sourceIds.length >= 10
                }
                onChange={() => toggle("sourceIds", source.id)}
              />
              <span>
                <strong>{source.title}</strong>
                <small>
                  Revision {source.activeRevision ?? source.revision} ·{" "}
                  {source.chunkCount} passages
                </small>
              </span>
            </label>
          ))
        ) : (
          <p className="knowledge-hint">
            No ready sources. Add a source and wait for indexing.
          </p>
        )}
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>
          Confirmed workspace memory <span>{memories.length}</span>
        </legend>
        {memories.length ? (
          memories.map((memory) => (
            <label className="evidence-option" key={memory.id}>
              <input
                type="checkbox"
                checked={selection.memoryIds.includes(memory.id)}
                disabled={
                  !selection.memoryIds.includes(memory.id) &&
                  selection.memoryIds.length >= 10
                }
                onChange={() => toggle("memoryIds", memory.id)}
              />
              <span>
                <strong>{memory.title}</strong>
                <small>Revision {memory.revision} · Operator curated</small>
              </span>
            </label>
          ))
        ) : (
          <p className="knowledge-hint">No unexpired curated memories.</p>
        )}
      </fieldset>
      {invalid && (
        <div className="inline-error">
          <p>Some selected evidence is no longer available or ready.</p>
          <button
            type="button"
            className="button button-secondary button-small"
            disabled={disabled}
            onClick={() =>
              onChange({
                sourceIds: selection.sourceIds.filter((id) =>
                  sources.some((source) => source.id === id),
                ),
                memoryIds: selection.memoryIds.filter((id) =>
                  memories.some((memory) => memory.id === id),
                ),
              })
            }
          >
            Remove unavailable selections
          </button>
        </div>
      )}
      <p className="knowledge-hint">
        Select up to 10 sources and 10 memories. Only selected material is
        searched.
      </p>
    </div>
  );
}

export function evidenceTarget(prefix: string, citation: string): string {
  return `${prefix}-evidence-${citation}`;
}
export function focusEvidence(prefix: string, citation: string): void {
  const target = document.getElementById(evidenceTarget(prefix, citation));
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "center" });
}

export function EvidencePanel({
  evidence,
  prefix,
  requested = true,
  unresolved = [],
}: {
  evidence?: EvidenceSnapshot;
  prefix: string;
  requested?: boolean;
  unresolved?: string[];
}) {
  if (!requested && !evidence) return null;
  return (
    <section
      className="recorded-evidence"
      aria-label="Recorded knowledge evidence"
    >
      <div className="section-header">
        <div>
          <div className="section-kicker">THE CONTEXT BEHIND THE RESULT</div>
          <h2>
            {evidence?.status === "insufficient"
              ? "Insufficient evidence"
              : evidence
                ? "Evidence retrieved"
                : "Required evidence"}
            {evidence && (
              <span className="inline-count">{evidence.items.length}</span>
            )}
          </h2>
        </div>
        <Icon name="knowledge" size={21} />
      </div>
      {!evidence ? (
        <p className="knowledge-hint">
          Evidence is required for this mission. No retrieval result has been
          recorded yet.
        </p>
      ) : (
        <>
          <p className="knowledge-hint">
            {evidence.status === "insufficient"
              ? "The selected material did not provide sufficient matching evidence. Generation must not continue without the required context."
              : "These are the exact retained excerpts supplied as context. Retrieval does not independently verify the generated claims."}
          </p>
          <p className="evidence-query">
            <strong>Query</strong> {evidence.query}
          </p>
          {evidence.messages.map((message, index) => (
            <p className="knowledge-hint" key={index}>
              {message}
            </p>
          ))}
          {evidence.items.map((item) => (
            <article
              className="evidence-excerpt"
              id={evidenceTarget(prefix, item.citation)}
              tabIndex={-1}
              key={item.citation}
            >
              <div>
                <span className="citation-label">[{item.citation}]</span>
                <h3>{item.title}</h3>
                <span className="planned-badge">
                  {item.kind === "source" ? "Source" : "Memory"}
                </span>
              </div>
              <p className="evidence-provenance">
                Revision {item.revision}
                {item.lineStart !== null
                  ? ` · Lines ${item.lineStart}–${item.lineEnd ?? item.lineStart}`
                  : ""}
                {item.chunkIndex !== null
                  ? ` · Passage ${item.chunkIndex + 1}`
                  : ""}
              </p>
              <p className="evidence-text">{item.text}</p>
              <details className="route-details">
                <summary>
                  Evidence identity
                  <Icon name="chevron" size={13} />
                </summary>
                <code className="fingerprint">
                  {item.ownerId} · {item.contentHash}
                </code>
              </details>
            </article>
          ))}
          {unresolved.length > 0 && (
            <div className="inline-error">
              Document citations without matching recorded evidence:{" "}
              {unresolved.map((citation) => `[${citation}]`).join(", ")}. Treat
              these claims as unsupported.
            </div>
          )}
          <p className="knowledge-hint">
            Recorded{" "}
            {new Intl.DateTimeFormat("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(evidence.retrievedAt))}{" "}
            · Historical excerpts remain retained if the original source or
            memory is later deleted.
          </p>
        </>
      )}
    </section>
  );
}
