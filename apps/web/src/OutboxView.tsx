import { useCallback, useEffect, useRef, useState } from "react";
import {
  approvedPackageFilename,
  approvedPackageSchema,
  outboxSnapshotSchema,
  type OutboxSnapshot,
} from "@vuzmi/core";
import { request } from "./api";
import { Icon } from "./icons";
export function OutboxView() {
  const [snapshot, setSnapshot] = useState<OutboxSnapshot | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const value = outboxSnapshotSchema.parse(await request("/outbox"));
      if (current === generation.current) {
        setSnapshot(value);
        setError(null);
      }
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "The approved packages could not be loaded.",
        );
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh]);
  async function download(id: string) {
    setBusy(id);
    setError(null);
    try {
      const value = approvedPackageSchema.parse(
        await request(`/outbox/${encodeURIComponent(id)}`),
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2) + "\n"], {
          type: "application/json;charset=utf-8",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = approvedPackageFilename(value);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The package could not be downloaded.",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="outbox-view">
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOCAL OUTBOX / APPROVED WORK</div>
          <h1>
            Ready for your <span>next move.</span>
          </h1>
          <p>
            Exact approved documents, with the evidence and decision that put
            them here.
          </p>
        </div>
        <button
          className="button button-secondary"
          onClick={() => void refresh()}
        >
          <Icon name="refresh" size={16} />
          Refresh
        </button>
      </div>
      <div className="outbox-boundary">
        <Icon name="shield" size={19} />
        <p>
          <strong>Saved locally. Delivery stays in your hands.</strong>
          <br />
          Each package contains the reviewed Markdown, its SHA-256, approval
          record, retained evidence, and execution history. Downloading does not
          deploy, publish, or send anything.
        </p>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {!snapshot && !error ? (
        <p role="status">Loading approved packages…</p>
      ) : snapshot?.items.length ? (
        <div className="outbox-grid">
          {snapshot.items.map((item) => (
            <article className="outbox-card" key={item.runId}>
              <div className="outbox-meta">
                <span>
                  {item.mode === "ollama" ? "LOCAL OLLAMA" : "SIMULATION"}
                </span>
                <span>
                  {new Date(item.approvedAt).toLocaleString("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </div>
              <h2>
                <a href={`#/runs/${encodeURIComponent(item.runId)}`}>
                  {item.title}
                </a>
              </h2>
              <p>
                Approved by{" "}
                {item.actorName ??
                  (item.actor === "local-operator"
                    ? "local operator"
                    : "workspace owner")}{" "}
                · {item.documentBytes.toLocaleString()} bytes
              </p>
              <details>
                <summary>Document integrity</summary>
                <code>{item.documentSha256}</code>
                <p>
                  This hashes the exact Markdown bytes. The package also records
                  the original action fingerprint.
                </p>
              </details>
              <div className="outbox-actions">
                <a
                  className="button button-secondary button-small"
                  href={`#/runs/${encodeURIComponent(item.runId)}`}
                >
                  Review record
                </a>
                <button
                  className="button button-primary button-small"
                  disabled={busy !== null}
                  onClick={() => void download(item.runId)}
                >
                  <Icon name="download" size={15} />
                  {busy === item.runId ? "Preparing…" : "Download package"}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        !error && (
          <div className="outbox-empty">
            <Icon name="download" size={30} />
            <h2>Your approved work belongs here.</h2>
            <p>
              Review a mission and approve its exact document to create the
              first local package.
            </p>
            <a className="button button-secondary" href="#/runs">
              Open missions
            </a>
          </div>
        )
      )}
      <p className="outbox-retention">
        Packages and historical evidence stay in run history when sources or
        memories change or are deleted. Downloaded copies and backups have their
        own retention.
      </p>
    </section>
  );
}
