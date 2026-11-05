import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  renderDraftDocument,
  reviseDraftSchema,
  validateDraftCitations,
  type ReviseDraftInput,
  type Run,
} from "@vuzmi/core";
import { ApiError, getRun, reviseDraft } from "./api";
import { ArtifactDocument } from "./ArtifactDocument";
import { Icon } from "./icons";
import {
  clearDraftSession,
  registerDraftDiscardGuard,
  settleDraftAttempt,
  updateDraftSession,
  type DraftSession,
} from "./draftSession";

type Departure =
  | { kind: "close" }
  | { kind: "navigate"; url: string }
  | { kind: "signout" };
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The revised draft could not be saved. Your local text is still here.";
}

export function DraftEditor({
  session,
  currentRun,
  connected,
  onSaved,
  onObserved,
  onClose,
}: {
  session: DraftSession;
  currentRun: Run;
  connected: boolean;
  onSaved: (run: Run) => void;
  onObserved: (run: Run) => void;
  onClose: () => void;
}) {
  const { initialRun, initialBody } = session;
  const [body, setBody] = useState(session.body);
  const [reason, setReason] = useState(session.reason);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(session.error);
  const [conflicted, setConflicted] = useState(session.conflicted);
  const [uncertain, setUncertain] = useState(session.uncertain);
  const [attempt, setAttempt] = useState<ReviseDraftInput | null>(
    session.attempt,
  );
  const [departure, setDeparture] = useState<Departure | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const active = useRef(true);
  const allowDeparture = useRef(false);
  const editorUrl = useRef(window.location.href);
  const signOutAnswer = useRef<((confirmed: boolean) => void) | null>(null);
  const dirty = body !== initialBody || reason !== "";
  const byteCount = new TextEncoder().encode(body).byteLength;
  const stale =
    currentRun.revision !== initialRun.revision ||
    currentRun.proposal?.fingerprint !== initialRun.proposal?.fingerprint ||
    currentRun.status !== "waiting_approval";
  const blocked = conflicted || (stale && !(uncertain && attempt));
  let validation: string | null = null;
  if (byteCount > 65_536)
    validation = "The body exceeds the 64 KiB UTF-8 limit.";
  else {
    try {
      validateDraftCitations(body, initialRun.evidence);
    } catch (caught) {
      validation = message(caught);
    }
  }

  useEffect(() => {
    active.current = true;
    bodyField.current?.focus();
    return () => {
      active.current = false;
      signOutAnswer.current?.(false);
      signOutAnswer.current = null;
    };
  }, []);

  useEffect(
    () =>
      registerDraftDiscardGuard(() => {
        if (!dirty) {
          clearDraftSession(session.id);
          allowDeparture.current = true;
          onClose();
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          signOutAnswer.current?.(false);
          signOutAnswer.current = resolve;
          setDeparture({ kind: "signout" });
        });
      }),
    [dirty, session.id, onClose],
  );

  useEffect(() => {
    if (!dirty) return;
    const hashChange = (event: HashChangeEvent) => {
      if (allowDeparture.current || window.location.href === editorUrl.current)
        return;
      const url = window.location.href;
      event.stopImmediatePropagation();
      window.history.replaceState(window.history.state, "", editorUrl.current);
      setDeparture({ kind: "navigate", url });
    };
    const click = (event: MouseEvent) => {
      if (
        allowDeparture.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target === "_blank" ||
        link.hasAttribute("download")
      )
        return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== window.location.pathname ||
        url.search !== window.location.search ||
        url.hash === window.location.hash
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setDeparture({ kind: "navigate", url: url.href });
    };
    window.addEventListener("hashchange", hashChange, true);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("hashchange", hashChange, true);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);

  useEffect(() => {
    const element = dialog.current;
    if (!departure || !element) return;
    element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, [departure]);

  const change = () => {
    setAttempt(null);
    setUncertain(false);
    setError(null);
    updateDraftSession(session.id, {
      attempt: null,
      uncertain: false,
      error: null,
    });
  };
  const keepEditing = () => {
    signOutAnswer.current?.(false);
    signOutAnswer.current = null;
    setDeparture(null);
  };
  const close = () => {
    if (saving) return;
    if (dirty) setDeparture({ kind: "close" });
    else {
      allowDeparture.current = true;
      clearDraftSession(session.id);
      onClose();
    }
  };
  const discard = () => {
    if (!departure || saving) return;
    allowDeparture.current = true;
    clearDraftSession(session.id);
    signOutAnswer.current?.(true);
    signOutAnswer.current = null;
    onClose();
    if (departure.kind === "navigate") window.location.assign(departure.url);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (
      saving ||
      blocked ||
      !connected ||
      validation ||
      body === initialBody ||
      !initialRun.proposal
    )
      return;
    const parsed = reviseDraftSchema.safeParse(
      attempt ?? {
        editId: crypto.randomUUID(),
        revision: initialRun.revision,
        fingerprint: initialRun.proposal.fingerprint,
        body,
        reason,
      },
    );
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ??
          "Check the draft body and change reason.",
      );
      return;
    }
    const payload = parsed.data;
    setAttempt(payload);
    setSaving(true);
    setError(null);
    updateDraftSession(session.id, {
      attempt: payload,
      uncertain: true,
      error: null,
    });
    try {
      const saved = await reviseDraft(initialRun.id, payload);
      settleDraftAttempt(
        session.id,
        payload.editId,
        active.current
          ? { saved: true }
          : {
              saved: false,
              error:
                "An earlier save returned while the editor was hidden. Retry the unchanged request after signing in to confirm that exact saved revision.",
              conflicted: false,
              uncertain: true,
            },
      );
      if (!active.current) return;
      allowDeparture.current = true;
      onSaved(saved);
    } catch (caught) {
      const conflict = caught instanceof ApiError && caught.status === 409;
      const unresolved =
        caught instanceof ApiError &&
        (caught.status === 0 || caught.code === "INVALID_RESPONSE");
      const notice =
        caught instanceof ApiError && caught.code === "EDIT_ID_CONFLICT"
          ? "This edit identifier is already bound to a different save. Your local text is retained. Discard this session and review the saved document before editing again."
          : message(caught);
      settleDraftAttempt(session.id, payload.editId, {
        saved: false,
        error: notice,
        conflicted: conflict,
        uncertain: unresolved,
      });
      if (!active.current) return;
      setConflicted(conflict);
      setUncertain(unresolved);
      setError(notice);
      if (conflict) {
        try {
          const latest = await getRun(initialRun.id);
          if (active.current) onObserved(latest);
        } catch {
          /* Retain both local input and the original save error. */
        }
      }
    } finally {
      if (active.current) setSaving(false);
    }
  };

  let rendered: string | null = null;
  let previewError: string | null = null;
  if (preview) {
    try {
      rendered = renderDraftDocument(body, initialRun.evidence, "human");
    } catch (caught) {
      previewError = message(caught);
    }
  }

  return (
    <>
      <section className="draft-editor" aria-labelledby="draft-editor-title">
        <div className="draft-editor-heading">
          <div>
            <span className="section-kicker">OWNER REVISION / LOCAL DRAFT</span>
            <h2 id="draft-editor-title">Correct the draft.</h2>
          </div>
          <span className="revision-label">FROM REV {initialRun.revision}</span>
        </div>
        <p className="draft-editor-intro">
          Edit the body exactly. Vuzmi adds human-revision provenance and
          preserves the retained references. Saving creates a new draft for
          review; it does not approve, regenerate, or publish it.
        </p>
        <div
          className="draft-editor-tabs"
          role="group"
          aria-label="Draft editor view"
        >
          <button
            type="button"
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Edit body
          </button>
          <button
            type="button"
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Preview full draft
          </button>
        </div>
        {(stale || conflicted) && (
          <div className="draft-conflict" role="alert">
            <strong>The saved review boundary changed.</strong>
            <p>
              Your local body is retained. The backend currently shows revision{" "}
              {currentRun.revision}, {currentRun.status.replaceAll("_", " ")}.
              No content has been merged.
            </p>
            {uncertain && attempt && !conflicted ? (
              <p>
                The earlier save is unconfirmed. Retry unchanged to resolve that
                exact edit identifier.
              </p>
            ) : (
              <p>
                Discard this session and inspect the saved document before
                starting a new revision.
              </p>
            )}
            <details>
              <summary>Inspect current saved document</summary>
              <pre tabIndex={0}>
                {currentRun.artifact?.content ??
                  currentRun.proposal?.content ??
                  "No saved document is available."}
              </pre>
            </details>
            <button
              type="button"
              className="button button-secondary"
              disabled={saving}
              onClick={() => setDeparture({ kind: "close" })}
            >
              Discard edits and review saved draft
            </button>
          </div>
        )}
        <form
          onSubmit={(event) => {
            void save(event);
          }}
        >
          {preview ? (
            <div className="draft-editor-preview">
              {rendered !== null ? (
                <ArtifactDocument
                  content={rendered}
                  evidence={initialRun.evidence}
                  prefix={initialRun.id}
                />
              ) : (
                <p role="alert">{previewError}</p>
              )}
              <p className="draft-preview-label">
                Unsaved preview · The backend validates and fingerprints the
                saved full document.
              </p>
            </div>
          ) : (
            <>
              <details className="draft-fixed-boundary">
                <summary>Read-only provenance and reference boundaries</summary>
                <p>
                  The fixed human-revised provenance identifies owner-authored
                  changes and keeps the original provider usage attribution.
                  Reference identities and excerpts come from the retained run
                  evidence; they cannot be edited here.
                </p>
                <pre tabIndex={0}>
                  {renderDraftDocument(
                    "[Editable body appears here]",
                    initialRun.evidence,
                    "human",
                  )}
                </pre>
              </details>
              <label className="draft-editor-label" htmlFor="draft-body">
                Draft body{" "}
                <span>
                  {byteCount.toLocaleString("en-GB")} / 65,536 UTF-8 bytes
                </span>
              </label>
              <textarea
                ref={bodyField}
                id="draft-body"
                className="draft-body-input"
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  updateDraftSession(session.id, { body: event.target.value });
                  change();
                }}
                disabled={saving}
                aria-describedby="draft-body-help draft-body-validation"
                spellCheck={false}
              />
              <p id="draft-body-help" className="draft-field-help">
                Body limit: 64 KiB. Known citation IDs must remain valid;
                evidence-backed drafts need at least one retained citation.
                Prior drafts and reasons remain in private history and backups.
              </p>
            </>
          )}
          <p
            id="draft-body-validation"
            className={validation ? "draft-validation" : "draft-field-help"}
            aria-live="polite"
          >
            {validation ??
              "Vuzmi adds human-revision provenance and preserves the retained evidence."}
          </p>
          <label className="draft-editor-label" htmlFor="draft-reason">
            Reason for this correction
          </label>
          <textarea
            id="draft-reason"
            className="draft-reason-input"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              updateDraftSession(session.id, { reason: event.target.value });
              change();
            }}
            disabled={saving}
            minLength={3}
            maxLength={600}
            required
            rows={3}
            placeholder="Describe what you corrected and why."
          />
          <p className="draft-field-help">
            3–600 characters. The owner identity and time are recorded by the
            backend.
          </p>
          {error && (
            <div className="inline-error" role="alert">
              {error}
              {uncertain && (
                <p>
                  The result is not confirmed. Retrying unchanged reuses the
                  same edit identifier and exact request.
                </p>
              )}
            </div>
          )}
          <div className="draft-editor-actions">
            <button
              type="submit"
              className="button button-primary"
              disabled={
                saving ||
                !connected ||
                blocked ||
                Boolean(validation) ||
                body === initialBody ||
                reason.trim().length < 3
              }
            >
              <Icon
                name={saving ? "refresh" : "check"}
                className={saving ? "spinning" : ""}
                size={17}
              />
              {saving
                ? "Saving revised draft…"
                : uncertain && attempt
                  ? "Retry exact save"
                  : "Save revised draft"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={saving}
              onClick={close}
            >
              {dirty ? "Discard editing session" : "Close editor"}
            </button>
          </div>
          {!connected && (
            <p className="draft-validation">
              Reconnect before saving. Your local body remains here.
            </p>
          )}
          <p className="draft-field-help" role="status">
            {saving
              ? "Waiting for the backend to confirm the saved revision."
              : "Approval and rejection are unavailable while this editor is open."}
          </p>
        </form>
      </section>
      {departure && (
        <dialog
          ref={dialog}
          className="mission-dialog draft-discard-dialog"
          aria-labelledby="draft-discard-title"
          aria-describedby="draft-discard-description"
          onCancel={(event) => {
            event.preventDefault();
            keepEditing();
          }}
        >
          <div className="dialog-inner">
            <h2 id="draft-discard-title">Discard this editing session?</h2>
            <p id="draft-discard-description" className="dialog-description">
              Your unsaved body and reason will be removed from this browser
              view. Saved backend revisions remain retained.
            </p>
            <div className="draft-editor-actions">
              <button
                type="button"
                className="button button-secondary"
                autoFocus
                onClick={keepEditing}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={saving}
                onClick={discard}
              >
                {departure.kind === "navigate"
                  ? "Discard and leave"
                  : departure.kind === "signout"
                    ? "Discard and sign out"
                    : "Discard and review saved draft"}
              </button>
            </div>
            {saving && (
              <p role="status">
                Wait for the current save to finish before leaving.
              </p>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
