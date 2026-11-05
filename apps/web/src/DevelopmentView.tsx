import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  developmentBaselineAccepted,
  developmentBaselineReproduced,
  developmentReview,
  type DevelopmentCheck,
  type DevelopmentProfile,
  type DevelopmentRun,
  type DevelopmentRuntime,
} from "@vuzmi/core";
import { ApiError } from "./api";
import { DevelopmentProfileDetails as ProfileDetails } from "./DevelopmentProfileDetails";
import { DevelopmentApplicationPanel } from "./DevelopmentApplication";
import { Icon } from "./icons";
import {
  createDevelopment,
  decideDevelopment,
  getDevelopmentPackage,
  getDevelopmentRun,
  getDevelopmentRuntime,
  listDevelopmentRuns,
} from "./developmentApi";
import {
  acknowledgeDevelopmentReview,
  captureDevelopmentDecision,
  confirmDevelopmentRefresh,
  createDevelopmentReview,
  developmentVersion,
  mergeDevelopmentRuns,
  openDevelopmentReview,
  receiveDevelopmentRun,
  requireDevelopmentRefresh,
  sameDevelopmentVersion,
  type DevelopmentReviewState,
} from "./developmentReview";
import {
  captureDevelopmentAdmission,
  developmentAdmissionKey,
  developmentProfileAvailable,
  developmentProfileLabel,
  developmentProfiles,
  observeDevelopmentProfile,
  type DevelopmentAdmission,
} from "./developmentProfiles";

const labels: Record<DevelopmentRun["status"], string> = {
  queued: "Queued",
  running: "In progress",
  waiting_approval: "Needs review",
  completed: "Package saved",
  failed: "Failed",
  cancelled: "Rejected",
};
const checkLabels: Record<DevelopmentCheck["status"], string> = {
  passed: "Passed",
  failed: "Failed",
  timed_out: "Timed out",
  oom_killed: "OOM killed",
  cancelled: "Cancelled",
  unavailable: "Unavailable",
};
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The operation could not complete. Refresh saved state and try again explicitly.";
const when = (value: string) =>
  new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const runLink = (id: string) => `#/development/${encodeURIComponent(id)}`;
const bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength.toLocaleString("en-GB");

export function DevelopmentView({ runId }: { runId?: string }) {
  const [runs, setRuns] = useState<DevelopmentRun[]>([]);
  const [runtime, setRuntime] = useState<DevelopmentRuntime | null>(null);
  const [loading, setLoading] = useState(true);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true,
      listBusy = false,
      runtimeBusy = false;
    const controllers = new Set<AbortController>();
    async function loadList() {
      if (listBusy) return;
      listBusy = true;
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const incoming = await listDevelopmentRuns(controller.signal);
        if (active) {
          setRuns((current) => mergeDevelopmentRuns(current, incoming));
          setError(null);
        }
      } catch (cause) {
        if (active) setError(message(cause));
      } finally {
        controllers.delete(controller);
        listBusy = false;
        if (active) setLoading(false);
      }
    }
    async function loadRuntime() {
      if (runtimeBusy) return;
      runtimeBusy = true;
      if (active) setRuntimeLoading(true);
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const incoming = await getDevelopmentRuntime(controller.signal);
        if (active) {
          setRuntime(incoming);
          setRuntimeError(null);
        }
      } catch (cause) {
        if (active) setRuntimeError(message(cause));
      } finally {
        controllers.delete(controller);
        runtimeBusy = false;
        if (active) setRuntimeLoading(false);
      }
    }
    refresh.current = () => {
      void loadList();
      void loadRuntime();
    };
    refresh.current();
    const listInterval = window.setInterval(() => {
      void loadList();
    }, 6000);
    const runtimeInterval = window.setInterval(() => {
      void loadRuntime();
    }, 15000);
    return () => {
      active = false;
      refresh.current = () => {};
      window.clearInterval(listInterval);
      window.clearInterval(runtimeInterval);
      for (const controller of controllers) controller.abort();
    };
  }, []);
  const update = (run: DevelopmentRun) =>
    setRuns((current) => mergeDevelopmentRuns(current, [run]));

  if (runId)
    return (
      <DevelopmentDetail
        key={runId}
        id={runId}
        observed={runs.find((run) => run.id === runId)}
        onUpdate={update}
      />
    );
  return (
    <section className="development-view">
      <div className="standard-page-header">
        <div>
          <Eyebrow>BUILD / DEVELOPMENT</Eyebrow>
          <h1>
            A task. A patch.
            <br />
            <span>Evidence to review.</span>
          </h1>
          <p>
            Generate a bounded code change, inspect isolated checks and save the
            exact package you approve.
          </p>
        </div>
        <button
          className="button button-primary"
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={17} />
          New development run
        </button>
      </div>
      <div className="development-boundary">
        <Icon name="shield" size={20} />
        <p>
          <strong>Local review package. Your checkout stays unchanged.</strong>
          <br />
          Choose an operator-provisioned source snapshot and trusted checks.
          Package approval saves the reviewed output; local work-branch
          application requires a separate explicit action.
        </p>
      </div>
      <div className="development-readiness" role="status">
        <span
          className={`source-state ${runtime?.ready && !runtimeError ? "source-ready" : "source-failed"}`}
        >
          {runtime?.ready && !runtimeError
            ? "Runner ready"
            : runtimeLoading && !runtime
              ? "Checking readiness"
              : "Development unavailable"}
        </span>
        <p>
          {runtimeError ??
            runtime?.reason ??
            (runtime?.ready
              ? "The server reports this fixed local profile is ready for admission."
              : "No isolated runner readiness has been confirmed.")}
          {runtime && (
            <small>
              Checked {when(runtime.checkedAt)} · Model {runtime.defaultModel}
            </small>
          )}
        </p>
        <button
          className="button button-small button-secondary"
          disabled={runtimeLoading}
          onClick={() => refresh.current()}
        >
          <Icon
            name="refresh"
            size={16}
            className={runtimeLoading ? "spinning" : ""}
          />
          Refresh readiness
        </button>
      </div>
      {creating && (
        <DevelopmentForm
          runtime={runtime}
          runtimeError={runtimeError}
          onClose={() => setCreating(false)}
          onRefresh={() => refresh.current()}
          onCreated={(run) => {
            update(run);
            setCreating(false);
            window.location.hash = runLink(run.id).slice(1);
          }}
        />
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error} Saved jobs below are the last observed state.
          <button
            type="button"
            className="button button-small button-secondary"
            onClick={() => refresh.current()}
          >
            Refresh jobs
          </button>
        </div>
      )}
      <div className="section-header">
        <div>
          <div className="section-kicker">
            VERSIONED DEVELOPMENT / LOCAL HISTORY
          </div>
          <h2>Development runs</h2>
        </div>
        <span className="development-count">{runs.length} recorded</span>
      </div>
      {loading && !runs.length ? (
        <p className="knowledge-hint" role="status">
          Loading development history…
        </p>
      ) : runs.length ? (
        <ul className="development-run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <a href={runLink(run.id)}>
                <span className="run-domain-icon">
                  <Icon name="build" size={21} />
                </span>
                <span className="development-run-copy">
                  <strong>{run.title}</strong>
                  <small>
                    {nextAction(run)} · {when(run.updatedAt)}
                  </small>
                </span>
                <DevelopmentStatus run={run} />
                <Icon name="chevron" size={17} />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        !error && (
          <div className="empty-state">
            <span className="empty-state-icon">
              <Icon name="build" size={28} />
            </span>
            <h2>Give the first change a boundary.</h2>
            <p>
              Start from your brief or an optional public Vuzmi issue. Actual
              patches, check receipts and local decisions will appear here.
            </p>
            <button
              className="button button-secondary"
              onClick={() => setCreating(true)}
            >
              New development run
            </button>
          </div>
        )
      )}
    </section>
  );
}

function DevelopmentForm({
  runtime,
  runtimeError,
  onClose,
  onRefresh,
  onCreated,
}: {
  runtime: DevelopmentRuntime | null;
  runtimeError: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onCreated: (run: DevelopmentRun) => void;
}) {
  const [title, setTitle] = useState(""),
    [brief, setBrief] = useState(""),
    [issueNumber, setIssueNumber] = useState("");
  const [selectedProfile, setSelectedProfile] =
    useState<DevelopmentProfile | null>(() =>
      observeDevelopmentProfile(null, runtime),
    );
  const pinnedProfile = observeDevelopmentProfile(selectedProfile, runtime);
  const profiles = developmentProfiles(runtime);
  const profileAvailable =
    developmentProfileAvailable(pinnedProfile, runtime) && !runtimeError;
  useEffect(() => {
    if (!selectedProfile && pinnedProfile) setSelectedProfile(pinnedProfile);
  }, [selectedProfile, pinnedProfile]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [uncertain, setUncertain] = useState(false);
  const attempt = useRef<DevelopmentAdmission | null>(null);
  const taskFields = { title, brief, issueNumber };
  const retryUnchanged =
    attempt.current?.key === developmentAdmissionKey(taskFields, pinnedProfile);
  const active = useRef(true),
    pending = useRef(false),
    controller = useRef<AbortController | null>(null);
  const titleField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    titleField.current?.focus();
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const changed = () => {
    setError(null);
    setUncertain(false);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (!retryUnchanged && !profileAvailable) {
      setError(
        runtimeError ??
          runtime?.reason ??
          "A verified isolated runner and profile are required. Refresh readiness.",
      );
      return;
    }
    let captured: DevelopmentAdmission;
    try {
      captured = captureDevelopmentAdmission(
        attempt.current,
        taskFields,
        pinnedProfile,
        runtime?.defaultModel ?? "",
        () => crypto.randomUUID(),
      );
    } catch (cause) {
      setError(message(cause));
      return;
    }
    attempt.current = captured;
    pending.current = true;
    setBusy(true);
    setError(null);
    setUncertain(false);
    controller.current = new AbortController();
    try {
      const result = await createDevelopment(
        captured.input,
        controller.current.signal,
      );
      if (active.current) onCreated(result.run);
    } catch (cause) {
      if (active.current) {
        setError(message(cause));
        setUncertain(
          cause instanceof ApiError &&
            (cause.status === 0 || cause.status >= 500),
        );
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section
      className="development-create"
      aria-labelledby="development-create-title"
    >
      <div className="development-section-heading">
        <div>
          <div className="section-kicker">
            PINNED SOURCE / TRUSTED REGRESSIONS
          </div>
          <h2 id="development-create-title">New development run</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close new development run"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <form
        className="knowledge-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="field-label" htmlFor="development-profile">
          Provisioned development profile
        </label>
        <select
          id="development-profile"
          value={pinnedProfile?.profileHash ?? ""}
          disabled={busy}
          onChange={(event) => {
            const selected = profiles.find(
              (profile) => profile.profileHash === event.target.value,
            );
            if (selected) {
              setSelectedProfile(selected);
              changed();
            }
          }}
        >
          {!pinnedProfile && (
            <option value="">No provisioned profile available</option>
          )}
          {pinnedProfile &&
            !profiles.some(
              (profile) => profile.profileHash === pinnedProfile.profileHash,
            ) && (
              <option value={pinnedProfile.profileHash}>
                {developmentProfileLabel(pinnedProfile)} ·{" "}
                {pinnedProfile.baseCommit.slice(0, 12)} · Unavailable selection
              </option>
            )}
          {profiles.map((profile) => (
            <option key={profile.profileHash} value={profile.profileHash}>
              {developmentProfileLabel(profile)} ·{" "}
              {profile.baseCommit.slice(0, 12)} · {profile.files.length}{" "}
              permitted {profile.files.length === 1 ? "file" : "files"}
            </option>
          ))}
        </select>
        <p className="knowledge-hint">
          This selects an immutable snapshot provisioned by the operator.
          Background refreshes cannot replace your selected commit or file
          scope.
        </p>
        <label className="field-label" htmlFor="development-title">
          Task title
        </label>
        <input
          ref={titleField}
          id="development-title"
          minLength={3}
          maxLength={120}
          required
          value={title}
          disabled={busy}
          onChange={(event) => {
            setTitle(event.target.value);
            changed();
          }}
        />
        <label className="field-label" htmlFor="development-brief">
          Task brief and acceptance criteria
        </label>
        <textarea
          id="development-brief"
          minLength={10}
          maxLength={3000}
          rows={5}
          required
          value={brief}
          disabled={busy}
          onChange={(event) => {
            setBrief(event.target.value);
            changed();
          }}
        />
        <label className="field-label" htmlFor="development-issue">
          Public Vuzmi issue number (optional)
        </label>
        <input
          id="development-issue"
          type="number"
          min={1}
          max={10000000}
          step={1}
          value={issueNumber}
          disabled={busy}
          onChange={(event) => {
            setIssueNumber(event.target.value);
            changed();
          }}
        />
        <p className="knowledge-hint">
          If supplied, the server fetches and retains that public issue’s
          current title and body at admission. Issue content is untrusted
          context; no comments or GitHub writes.
        </p>
        <div className="development-fixed-model">
          <span className="field-label">Local model</span>
          <strong>{runtime?.defaultModel || "Not available"}</strong>
          <small>Server-configured for this profile · No cloud fallback</small>
        </div>
        {pinnedProfile ? (
          <ProfileDetails
            profile={pinnedProfile}
            title="Pinned context and permitted changes"
          />
        ) : (
          <p className="knowledge-hint">
            The fixed source context will appear when the server profile is
            available. This form cannot start without it.
          </p>
        )}
        {!profileAvailable && (
          <div className="inline-error" role="status">
            <strong>Selected profile is unavailable</strong>
            <p>
              {runtimeError ??
                runtime?.reason ??
                "The selected snapshot is not in the ready catalog. Choose an available profile explicitly or refresh readiness."}
            </p>
            <button
              type="button"
              className="button button-small button-secondary"
              onClick={onRefresh}
            >
              Refresh readiness
            </button>
            <p>No host-execution or patch-only fallback is available.</p>
            {retryUnchanged && (
              <p>
                An unchanged retry can still check its original admission
                receipt. It cannot silently use a replacement profile.
              </p>
            )}
          </div>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
            {uncertain && (
              <p>
                Admission is unconfirmed. Retry unchanged to use the same
                request ID and original model ({attempt.current?.input.model}).
                Changing fields or closing this form starts a separate request;
                inspect existing jobs first.
              </p>
            )}
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
            disabled={busy || (!retryUnchanged && !profileAvailable)}
          >
            <Icon
              name={busy ? "refresh" : "arrow"}
              className={busy ? "spinning" : ""}
              size={17}
            />
            {busy
              ? "Recording development run…"
              : uncertain
                ? "Retry admission unchanged"
                : "Start development run"}
          </button>
        </div>
      </form>
    </section>
  );
}

function DevelopmentDetail({
  id,
  observed,
  onUpdate,
}: {
  id: string;
  observed?: DevelopmentRun;
  onUpdate: (run: DevelopmentRun) => void;
}) {
  const [loaded, setLoaded] = useState<DevelopmentRun | null>(null);
  const [reviewState, setReviewState] = useState<DevelopmentReviewState | null>(
    null,
  );
  const [loading, setLoading] = useState(true),
    [connected, setConnected] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [deciding, setDeciding] = useState<"approve" | "reject" | null>(null),
    [downloading, setDownloading] = useState(false);
  const [showExact, setShowExact] = useState(false);
  const latest =
    observed && (!loaded || observed.revision >= loaded.revision)
      ? observed
      : loaded;
  const review = latest
    ? reviewState
      ? receiveDevelopmentRun(reviewState, latest)
      : createDevelopmentReview(latest)
    : null;
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const active = useRef(true),
    decisionPending = useRef(false),
    controllers = useRef(new Set<AbortController>());
  const refresh = useRef<(explicit?: boolean) => void>(() => {});
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  function store(next: DevelopmentReviewState) {
    reviewRef.current = next;
    setReviewState(next);
  }
  useEffect(() => {
    let current = true,
      pending = false;
    active.current = true;
    async function load(explicit = false) {
      if (pending) return;
      pending = true;
      if (current) setRefreshing(true);
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const incoming = await getDevelopmentRun(id, controller.signal);
        if (!current) return;
        setLoaded(
          (previous) =>
            mergeDevelopmentRuns(previous ? [previous] : [], [incoming])[0],
        );
        updateRef.current(incoming);
        setConnected(true);
        if (explicit && reviewRef.current) {
          store(confirmDevelopmentRefresh(reviewRef.current, incoming));
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(message(cause));
          setConnected(false);
        }
      } finally {
        controllers.current.delete(controller);
        pending = false;
        if (current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    refresh.current = (explicit = false) => {
      void load(explicit);
    };
    refresh.current();
    const interval = window.setInterval(() => {
      void load();
    }, 5000);
    return () => {
      current = false;
      active.current = false;
      refresh.current = () => {};
      window.clearInterval(interval);
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [id]);
  const displayed = review?.displayed;
  const shown = displayed ? developmentVersion(displayed) : null;
  const changed = Boolean(
    review &&
    developmentVersion(review.latest) &&
    !sameDevelopmentVersion(shown, developmentVersion(review.latest)),
  );
  const opened = Boolean(
    review && sameDevelopmentVersion(review.opened, shown),
  );
  const acknowledged = Boolean(
    review && sameDevelopmentVersion(review.acknowledged, shown),
  );
  const decisionReady = Boolean(
    review && captureDevelopmentDecision(review, shown, "approve"),
  );
  let exact: string | null = null;
  if (displayed) {
    try {
      exact = JSON.stringify(developmentReview(displayed), null, 2);
    } catch {
      /* Incomplete jobs have no reviewable package. */
    }
  }
  function openExact() {
    const state = reviewRef.current;
    if (!state || state.refreshRequired) return;
    if (developmentVersion(state.latest))
      store(openDevelopmentReview(state, id));
    setShowExact(true);
    window.requestAnimationFrame(() => {
      if (active.current) {
        const node = document.getElementById("development-exact-package");
        node?.focus({ preventScroll: true });
        node?.scrollIntoView({ block: "start" });
      }
    });
  }
  async function decide(decision: "approve" | "reject") {
    if (decisionPending.current || !connected) return;
    const state = reviewRef.current;
    const captured =
      state && captureDevelopmentDecision(state, shown, decision);
    if (!captured) {
      setError(
        "Open and acknowledge the exact current development package before deciding.",
      );
      return;
    }
    decisionPending.current = true;
    setDeciding(decision);
    setError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const incoming = await decideDevelopment(
        captured.id,
        captured.input,
        controller.signal,
      );
      if (!active.current) return;
      setLoaded(incoming);
      store(createDevelopmentReview(incoming));
      updateRef.current(incoming);
    } catch (cause) {
      if (!active.current) return;
      if (reviewRef.current)
        store(requireDevelopmentRefresh(reviewRef.current));
      setError(
        `${message(cause)} Refresh saved state, then open and acknowledge the current package before another decision.`,
      );
      if (cause instanceof ApiError && cause.status === 0) setConnected(false);
    } finally {
      controllers.current.delete(controller);
      decisionPending.current = false;
      if (active.current) setDeciding(null);
    }
  }
  async function download() {
    const run = reviewRef.current?.latest;
    if (!run?.artifact || downloading) return;
    setDownloading(true);
    setError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const pkg = await getDevelopmentPackage(run.id, controller.signal);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(pkg.content),
      );
      const hash = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (!active.current) return;
      if (
        hash !== run.artifact.sha256 ||
        pkg.value.approval.fingerprint !== run.reviewFingerprint ||
        pkg.value.approval.revision !== run.decision?.revision
      )
        throw new Error(
          "The downloaded package does not match this saved review record. Refresh the run before downloading again.",
        );
      const url = URL.createObjectURL(
        new Blob([pkg.content], { type: "application/json;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `vuzmi-development-${run.id}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (active.current) setError(message(cause));
    } finally {
      controllers.current.delete(controller);
      if (active.current) setDownloading(false);
    }
  }

  if (!displayed || !review)
    return (
      <section className="development-view">
        <a className="text-link" href="#/development">
          ← Development
        </a>
        <div className="empty-state">
          <h1>
            {loading
              ? "Opening development run…"
              : "This run could not be opened."}
          </h1>
          {error && <p role="alert">{error}</p>}
          <button
            className="button button-secondary"
            disabled={refreshing}
            onClick={() => refresh.current(true)}
          >
            Refresh saved state
          </button>
        </div>
      </section>
    );
  const latestRun = review.latest;
  return (
    <section className="development-view development-detail">
      <div className="breadcrumbs">
        <a href="#/development">Development</a>
        <Icon name="chevron" size={13} />
        <span>{displayed.id.slice(0, 8)}</span>
      </div>
      <div className="run-detail-header">
        <div className="detail-status-line">
          <DevelopmentStatus run={latestRun} />
          <span className="simulation-badge">
            <span />
            LOCAL OLLAMA
          </span>
          <span className="revision-label">v{displayed.revision}</span>
        </div>
        <h1>{displayed.title}</h1>
        <p>
          <span>Development patch · v1</span>
          <span>Created {when(displayed.createdAt)}</span>
          <span>{displayed.model}</span>
        </p>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {latestRun.title}: {labels[latestRun.status]}.{" "}
        {changed ? "The package changed. Fresh review is required." : ""}
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {(!connected || review.refreshRequired) && (
        <div className="development-warning" role="status">
          <Icon name="alert" size={18} />
          <div>
            <strong>
              {review.refreshRequired
                ? "Decision needs saved-state recovery"
                : "Development connection needs attention"}
            </strong>
            <p>
              {review.refreshRequired
                ? "The previous decision result was not confirmed. Refresh saved state explicitly; background polling cannot renew your acknowledgment."
                : "Showing the last observed job. Decisions stay disabled until the backend responds."}
            </p>
            <button
              className="button button-small button-secondary"
              disabled={refreshing || Boolean(deciding)}
              onClick={() => refresh.current(true)}
            >
              {refreshing ? "Refreshing…" : "Refresh saved state"}
            </button>
          </div>
        </div>
      )}
      {changed && (
        <div className="development-warning" role="status">
          <Icon name="alert" size={18} />
          <div>
            <strong>Development package changed</strong>
            <p>
              You are viewing revision {displayed.revision}; the latest is{" "}
              {latestRun.revision}. Open and acknowledge the exact replacement
              before approving or rejecting.
            </p>
            <button
              className="button button-secondary"
              disabled={
                !connected || review.refreshRequired || Boolean(deciding)
              }
              onClick={openExact}
            >
              Review updated package
            </button>
          </div>
        </div>
      )}
      {latestRun.error && (
        <div className="inline-error" role="alert">
          <strong>{latestRun.error.code}</strong>
          <p>{latestRun.error.message}</p>
          <p>
            No approved development package was saved. Start a separate run
            after resolving the recorded failure.
          </p>
        </div>
      )}
      <DevelopmentSteps run={latestRun} />
      <div className="development-layout">
        <div className="development-main">
          <Panel title="Task and retained context">
            <p className="development-task-brief">{displayed.brief}</p>
            {displayed.issue ? (
              <details className="development-issue">
                <summary>
                  Retained public issue #{displayed.issue.number}:{" "}
                  {displayed.issue.title}
                </summary>
                <p className="knowledge-hint">
                  Untrusted context · Fetched {when(displayed.issue.fetchedAt)}{" "}
                  · Updated {when(displayed.issue.updatedAt)}
                </p>
                <a
                  href={displayed.issue.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  Open public issue ↗
                </a>
                <pre className="development-code" tabIndex={0}>
                  {displayed.issue.body || "(The issue has no body.)"}
                </pre>
              </details>
            ) : (
              <p className="knowledge-hint">
                Manual brief · No issue content was fetched for this run.
              </p>
            )}
            <ProfileDetails profile={displayed.profile} />
          </Panel>
          <Panel
            title="Proposed file change"
            accessory={
              displayed.candidate && (
                <span className="revision-label">
                  {displayed.candidate.files.length} changed /{" "}
                  {displayed.profile.files.length} permitted
                </span>
              )
            }
          >
            {displayed.candidate ? (
              <>
                <p>{displayed.candidate.summary}</p>
                <p className="knowledge-hint">
                  Model-proposed replacements · Full-file unified diff ·{" "}
                  {bytes(displayed.candidate.diff)} UTF-8 bytes
                </p>
                <div
                  className="development-diff"
                  tabIndex={0}
                  role="region"
                  aria-label="Exact whole-file unified diff"
                >
                  <pre>
                    {displayed.candidate.diff
                      .split("\n")
                      .map((line, index, lines) => (
                        <span
                          key={index}
                          className={
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "diff-add"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "diff-remove"
                                : "diff-context"
                          }
                        >
                          {line}
                          {index < lines.length - 1 ? "\n" : ""}
                        </span>
                      ))}
                  </pre>
                </div>
                <details className="development-disclosure">
                  <summary>Exact candidate text and hashes</summary>
                  {displayed.candidate.files.map((file) => (
                    <div key={file.path}>
                      <code>{file.path}</code>
                      <TechnicalValues
                        entries={[
                          ["Before SHA-256", file.beforeSha256],
                          ["After SHA-256", file.afterSha256],
                          [
                            "Candidate fingerprint",
                            displayed.candidate!.fingerprint,
                          ],
                        ]}
                      />
                      <pre className="development-code" tabIndex={0}>
                        {file.content}
                      </pre>
                    </div>
                  ))}
                </details>
              </>
            ) : (
              <p className="knowledge-hint">
                {latestRun.status === "failed"
                  ? "No validated candidate was retained."
                  : "A diff appears only after actual model output passes the fixed file/path/hash validation."}
              </p>
            )}
          </Panel>
          <div className="development-check-grid">
            <CheckResult
              title="Baseline checks"
              receipt={displayed.baseline}
              profile={displayed.profile}
              running={
                latestRun.status === "running" &&
                latestRun.execution?.phase === "baseline"
              }
            />
            <CheckResult
              title="Candidate checks"
              receipt={displayed.checks}
              profile={displayed.profile}
              running={
                latestRun.status === "running" &&
                latestRun.execution?.phase === "candidate"
              }
            />
          </div>
          {showExact && exact && (
            <Panel
              title="Exact development review payload"
              accessory={
                <span className="revision-label">
                  revision {displayed.revision}
                </span>
              }
            >
              <p className="knowledge-hint">
                This exact JSON payload includes the task, scope, pinned source,
                candidate, model usage and check receipts. Approval metadata is
                recorded only after a decision.
              </p>
              <TechnicalValues
                entries={[
                  [
                    "Review fingerprint",
                    displayed.reviewFingerprint ?? "Not available",
                  ],
                ]}
              />
              <pre
                id="development-exact-package"
                className="development-code development-exact"
                tabIndex={-1}
                aria-label="Exact development review payload"
              >
                {exact}
              </pre>
              {shown && (
                <div className="development-acknowledgment">
                  <p>
                    {acknowledged
                      ? `Revision ${shown.revision} acknowledged. Approval or rejection remains a separate decision.`
                      : "Read this exact package, then acknowledge the displayed version."}
                  </p>
                  <button
                    className="button button-secondary"
                    disabled={
                      !connected ||
                      !opened ||
                      changed ||
                      acknowledged ||
                      review.refreshRequired ||
                      Boolean(deciding)
                    }
                    onClick={() => {
                      const current = reviewRef.current;
                      if (current)
                        store(acknowledgeDevelopmentReview(current, shown));
                    }}
                  >
                    {acknowledged
                      ? "Displayed version acknowledged"
                      : `I reviewed revision ${shown.revision}`}
                  </button>
                </div>
              )}
            </Panel>
          )}
          {latestRun.status === "completed" &&
            latestRun.artifact &&
            latestRun.decision?.decision === "approve" && (
              <DevelopmentApplicationPanel
                key={`${latestRun.id}:${latestRun.artifact.sha256}`}
                run={latestRun}
              />
            )}
          <Panel title="Execution trail">
            <ol className="development-events">
              {latestRun.events.map((event) => (
                <li key={event.sequence}>
                  <span className="development-event-number">
                    {event.sequence}
                  </span>
                  <div>
                    <strong>{event.type}</strong>
                    <p>{event.message}</p>
                    <time dateTime={event.occurredAt}>
                      {when(event.occurredAt)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
        <aside
          className="development-inspector"
          aria-label="Development package review"
        >
          <section className="review-panel">
            <div className="review-panel-symbol">
              <Icon name={latestRun.artifact ? "check" : "shield"} size={25} />
            </div>
            <h2>
              {latestRun.artifact
                ? "Development package saved"
                : latestRun.status === "cancelled"
                  ? "Package rejected"
                  : latestRun.status === "failed"
                    ? "Development stopped"
                    : latestRun.status === "waiting_approval"
                      ? "Review the code and its checks"
                      : "Work is in progress"}
            </h2>
            <p>
              {latestRun.artifact
                ? "The exact approved patch and observed evidence are saved locally."
                : latestRun.status === "cancelled"
                  ? "No approved development package was saved."
                  : latestRun.status === "waiting_approval"
                    ? "Inspect the diff, profile baseline, candidate regressions and exact package before deciding. Check task fulfillment separately."
                    : "Only persisted model output and check receipts establish what happened."}
            </p>
            <div className="review-action-scope">
              <span className="tiny-label">APPROVAL SCOPE</span>
              <p>
                Save this reviewed local package. The actual checkout is
                unchanged.
              </p>
            </div>
            {exact && (
              <button
                className="button button-secondary"
                disabled={review.refreshRequired || Boolean(deciding)}
                onClick={openExact}
              >
                <Icon name="knowledge" size={17} />
                {changed
                  ? "Review updated package"
                  : "Read exact development package"}
              </button>
            )}
            {latestRun.status === "waiting_approval" && (
              <div className="review-buttons">
                <button
                  className="button button-primary"
                  disabled={!connected || !decisionReady || Boolean(deciding)}
                  onClick={() => {
                    void decide("approve");
                  }}
                >
                  <Icon
                    name={deciding === "approve" ? "refresh" : "check"}
                    className={deciding === "approve" ? "spinning" : ""}
                    size={17}
                  />
                  {deciding === "approve"
                    ? "Saving local package…"
                    : "Approve local development package"}
                </button>
                <button
                  className="button button-quiet"
                  disabled={!connected || !decisionReady || Boolean(deciding)}
                  onClick={() => {
                    void decide("reject");
                  }}
                >
                  {deciding === "reject"
                    ? "Recording rejection…"
                    : "Reject package"}
                </button>
                {!decisionReady && (
                  <p className="decision-offline">
                    {review.refreshRequired
                      ? "Refresh saved state before reviewing again."
                      : "Open and acknowledge the exact current package to enable a decision."}
                  </p>
                )}
              </div>
            )}
            {latestRun.artifact && (
              <>
                <button
                  className="button button-primary"
                  disabled={downloading || !connected}
                  onClick={() => {
                    void download();
                  }}
                >
                  <Icon name={downloading ? "refresh" : "download"} size={17} />
                  {downloading ? "Verifying package…" : "Download package"}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    const node = document.getElementById(
                      "development-application-title",
                    );
                    node?.focus({ preventScroll: true });
                    node?.scrollIntoView({ block: "start" });
                  }}
                >
                  Review local work branch
                </button>
                <TechnicalValues
                  entries={[
                    ["Saved artifact SHA-256", latestRun.artifact.sha256],
                    ["Saved", when(latestRun.artifact.savedAt)],
                  ]}
                />
              </>
            )}
            {latestRun.decision && (
              <p className="development-decision-record">
                {latestRun.decision.decision === "approve"
                  ? "Approved"
                  : "Rejected"}{" "}
                by {latestRun.decision.actorName ?? "workspace owner"}
                <br />
                {when(latestRun.decision.decidedAt)}
                <br />
                Reviewed revision {latestRun.decision.revision}
              </p>
            )}
            <p className="knowledge-hint">
              Package approval does not apply code, push, open a pull request,
              merge, deploy or publish. Local branch application is a separate
              action.
            </p>
            <button
              className="button button-small button-secondary"
              disabled={refreshing || Boolean(deciding)}
              onClick={() => refresh.current(true)}
            >
              <Icon
                name="refresh"
                size={16}
                className={refreshing ? "spinning" : ""}
              />
              Refresh saved state
            </button>
          </section>
          <Panel title="Local model and usage">
            <TechnicalValues
              entries={[
                ["Model", displayed.model],
                ["Model digest", displayed.modelDigest ?? "Not recorded"],
                [
                  "Model call",
                  displayed.routeExecuted ? "Executed locally" : "Not recorded",
                ],
                [
                  "Input tokens",
                  displayed.usage?.inputTokens?.toLocaleString("en-GB") ??
                    "Not recorded",
                ],
                [
                  "Output tokens",
                  displayed.usage?.outputTokens?.toLocaleString("en-GB") ??
                    "Not recorded",
                ],
                [
                  "Generation duration",
                  displayed.usage?.durationMs != null
                    ? `${(displayed.usage.durationMs / 1000).toFixed(2)} s`
                    : "Not recorded",
                ],
              ]}
            />
          </Panel>
        </aside>
      </div>
    </section>
  );
}

function CheckResult({
  title,
  receipt,
  running,
  profile,
}: {
  title: string;
  receipt: DevelopmentCheck | null;
  running: boolean;
  profile: DevelopmentProfile;
}) {
  const reproduced = Boolean(
    profile.id === "web-api-status-authority" &&
    receipt &&
    developmentBaselineReproduced(receipt),
  );
  return (
    <Panel
      title={title}
      accessory={
        <span
          className={`source-state ${reproduced || receipt?.status === "passed" ? "source-ready" : receipt ? "source-failed" : "source-queued"}`}
        >
          {reproduced
            ? "Reproduced"
            : receipt
              ? checkLabels[receipt.status]
              : running
                ? "Running"
                : "No receipt"}
        </span>
      }
    >
      {!receipt ? (
        <p className="knowledge-hint">
          {running
            ? "An isolated execution is active. No completed receipt has been recorded."
            : "No execution receipt is recorded."}
        </p>
      ) : (
        <>
          {receipt.phase === "baseline" && (
            <p className="knowledge-hint">
              {profile.baselineExpectation === "green"
                ? developmentBaselineAccepted(receipt, profile)
                  ? "The named regressions passed on the pinned baseline. This establishes the starting check state, not completion of the task."
                  : "A passing baseline is required for this profile and was not established. Inspect the recorded outcome."
                : developmentBaselineReproduced(receipt)
                  ? "Expected baseline failure reproduced: the two session-expiry assertions fail and the four remaining checks pass."
                  : "This baseline receipt does not establish the required reproduction. Inspect its actual assertions and outcome."}
            </p>
          )}
          <TechnicalValues
            entries={[
              ["Duration", `${(receipt.durationMs / 1000).toFixed(2)} s`],
              [
                "Exit code",
                receipt.exitCode == null
                  ? "Not recorded"
                  : String(receipt.exitCode),
              ],
              ["Started", receipt.started ? "Yes" : "No"],
              [
                "Isolation policy",
                receipt.policyVerified ? "Verified by runner" : "Not verified",
              ],
            ]}
          />
          {receipt.tests.length > 0 && (
            <ul className="development-test-list">
              {receipt.tests.map((test, index) => (
                <li key={`${index}-${test.name}`}>
                  <span className={test.passed ? "test-passed" : "test-failed"}>
                    {test.passed ? "PASS" : "FAIL"}
                  </span>
                  <span>{test.name}</span>
                </li>
              ))}
            </ul>
          )}
          {receipt.truncated && (
            <p className="inline-error" role="status">
              Logs were truncated. Truncated evidence cannot establish a passing
              profile.
            </p>
          )}
          <p className="knowledge-hint">
            This receipt covers only its named trusted checks. Passing
            regressions does not prove task fulfillment or code safety.
          </p>
          <details className="development-disclosure">
            <summary>Exact command, execution and logs</summary>
            <TechnicalValues
              entries={[
                ["Execution", receipt.executionId],
                ["Image", receipt.imageId],
                ["Base image", receipt.baseImageId],
                ["Profile hash", receipt.profileHash],
                [
                  "Candidate fingerprint",
                  receipt.candidateFingerprint ?? "Baseline — none",
                ],
                ["Log SHA-256", receipt.logsSha256],
                ["Started at", when(receipt.startedAt)],
                ["Finished at", when(receipt.finishedAt)],
              ]}
            />
            <pre className="development-code" tabIndex={0}>
              {JSON.stringify(receipt.command, null, 2)}
            </pre>
            <h4>Standard output</h4>
            <pre className="development-code" tabIndex={0}>
              {receipt.stdout || "(No standard output.)"}
            </pre>
            <h4>Standard error</h4>
            <pre className="development-code" tabIndex={0}>
              {receipt.stderr || "(No standard error.)"}
            </pre>
          </details>
        </>
      )}
    </Panel>
  );
}
function DevelopmentSteps({ run }: { run: DevelopmentRun }) {
  const steps = [
    ["Record context", "Recorded"],
    [
      "Baseline checks",
      run.baseline
        ? run.profile.id === "web-api-status-authority" &&
          developmentBaselineReproduced(run.baseline)
          ? "Reproduced"
          : checkLabels[run.baseline.status]
        : run.execution?.phase === "baseline"
          ? "Running"
          : "Not recorded",
    ],
    [
      "Generate patch",
      run.routeExecuted
        ? "Recorded"
        : run.status === "running" && run.stage === "generating"
          ? "Running"
          : "Not recorded",
    ],
    ["Validate patch", run.candidate ? "Validated" : "Not recorded"],
    [
      "Candidate checks",
      run.checks
        ? checkLabels[run.checks.status]
        : run.execution?.phase === "candidate"
          ? "Running"
          : "Not recorded",
    ],
    [
      "Human review",
      run.decision
        ? run.decision.decision === "approve"
          ? "Approved"
          : "Rejected"
        : run.status === "waiting_approval"
          ? "Waiting"
          : "Pending",
    ],
    [
      "Save package",
      run.artifact
        ? "Saved locally"
        : run.status === "cancelled"
          ? "Not saved"
          : "Not recorded",
    ],
  ];
  return (
    <ol className="development-steps" aria-label="Recorded development stages">
      {steps.map(([label, state], index) => (
        <li key={label}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <strong>{label}</strong>
          <small>{state}</small>
        </li>
      ))}
    </ol>
  );
}
function Panel({
  title,
  accessory,
  children,
}: {
  title: string;
  accessory?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="development-panel">
      <div className="development-section-heading">
        <h2>{title}</h2>
        {accessory}
      </div>
      {children}
    </section>
  );
}
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="page-eyebrow">
      <span className="eyebrow-line" />
      {children}
    </div>
  );
}
function TechnicalValues({ entries }: { entries: [string, string][] }) {
  return (
    <dl className="development-values">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
function DevelopmentStatus({ run }: { run: DevelopmentRun }) {
  return (
    <span className={`status-badge status-${run.status}`}>
      <span />
      {labels[run.status]}
    </span>
  );
}
function nextAction(run: DevelopmentRun): string {
  return run.status === "waiting_approval"
    ? "Review exact patch and checks"
    : run.status === "completed"
      ? "Download approved local package"
      : run.status === "failed"
        ? "Inspect recorded failure"
        : run.status === "cancelled"
          ? "No approved package saved"
          : run.stage === "baseline"
            ? "Awaiting baseline check result"
            : run.stage === "generating"
              ? "Awaiting local model output"
              : "Awaiting isolated candidate checks";
}
