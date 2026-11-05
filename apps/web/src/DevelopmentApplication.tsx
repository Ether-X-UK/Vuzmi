import { useEffect, useRef, useState } from "react";
import type { DevelopmentApplication, DevelopmentRun } from "@vuzmi/core";
import {
  authorizeDevelopmentApplication,
  getDevelopmentApplication,
  getDevelopmentApplicationPlan,
} from "./developmentApi";
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
  sameApplicationVersion,
  type ApplicationReviewState,
} from "./developmentApplicationReview";
import { Icon } from "./icons";

const statusLabels: Record<DevelopmentApplication["status"], string> = {
  queued: "Authorized · Queued",
  running: "Creating local work branch",
  applied: "Local work branch created",
  conflict: "Branch conflict",
  unavailable: "Connector unavailable",
  unconfirmed: "Application outcome unconfirmed",
};
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The application state could not be verified. Refresh recorded status before continuing.";
const when = (value: string) =>
  new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function DevelopmentApplicationPanel({ run }: { run: DevelopmentRun }) {
  const [review, setReview] = useState(initialApplicationReview);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const [operation, setOperation] = useState<DevelopmentApplication | null>(
    null,
  );
  const operationRef = useRef<DevelopmentApplication | null>(null);
  const [statusKnown, setStatusKnown] = useState(false),
    [statusLoading, setStatusLoading] = useState(false),
    [connected, setConnected] = useState(false);
  const [planLoading, setPlanLoading] = useState(false),
    [available, setAvailable] = useState(false),
    [reason, setReason] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null),
    [planError, setPlanError] = useState<string | null>(null),
    [actionError, setActionError] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false),
    [authorizing, setAuthorizing] = useState(false);
  const active = useRef(true),
    mutationPending = useRef(false),
    controllers = useRef(new Set<AbortController>());
  const loadStatusRef = useRef<(explicit?: boolean) => void>(() => {}),
    loadPlanRef = useRef<(open?: boolean) => void>(() => {});
  function store(next: ApplicationReviewState) {
    reviewRef.current = next;
    setReview(next);
  }
  function accept(incoming: DevelopmentApplication) {
    if (!applicationOperationMatchesRun(incoming, run))
      throw new Error(
        "The application record does not match this exact approved package and file scope. Its controls remain disabled.",
      );
    const next = newerApplication(operationRef.current, incoming);
    operationRef.current = next;
    setOperation(next);
  }
  useEffect(() => {
    let current = true,
      statusPending = false,
      planPending = false,
      planObserved = false;
    active.current = true;
    async function status(explicit = false) {
      if (statusPending) return;
      statusPending = true;
      if (current) setStatusLoading(true);
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const incoming = await getDevelopmentApplication(
          run.id,
          controller.signal,
        );
        if (!current) return;
        if (incoming) accept(incoming);
        else if (operationRef.current)
          throw new Error(
            "A previously recorded authorization is missing from this response. Retaining the last observed record; refresh before continuing.",
          );
        setStatusKnown(true);
        setStatusError(null);
        setConnected(true);
        if (explicit) {
          store(confirmApplicationRefresh(reviewRef.current));
          setActionError(null);
        }
      } catch (cause) {
        if (current) {
          setStatusError(message(cause));
          setConnected(false);
        }
      } finally {
        controllers.current.delete(controller);
        statusPending = false;
        if (current) setStatusLoading(false);
      }
    }
    async function plan(open = false) {
      if (planPending) return;
      planPending = true;
      if (current) setPlanLoading(true);
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const incoming = await getDevelopmentApplicationPlan(
          run.id,
          controller.signal,
        );
        if (!current) return;
        if (!applicationPlanMatchesRun(incoming.plan, run))
          throw new Error(
            "The application plan differs from this approved package, base or file scope. Refresh the saved package before continuing.",
          );
        let next = receiveApplicationPlan(reviewRef.current, incoming.plan);
        if (open) next = openApplicationPlan(next);
        store(next);
        setAvailable(incoming.available);
        setReason(incoming.reason);
        setPlanError(null);
        planObserved = true;
        if (open) {
          setShowPlan(true);
          window.requestAnimationFrame(() => {
            if (active.current) {
              const node = document.getElementById(
                "development-application-plan",
              );
              node?.focus({ preventScroll: true });
              node?.scrollIntoView({ block: "start" });
            }
          });
        }
      } catch (cause) {
        if (current) {
          setPlanError(message(cause));
          setAvailable(false);
        }
      } finally {
        controllers.current.delete(controller);
        planPending = false;
        if (current) setPlanLoading(false);
      }
    }
    loadStatusRef.current = (explicit = false) => {
      void status(explicit);
    };
    loadPlanRef.current = (open = false) => {
      void plan(open);
    };
    void status();
    const interval = window.setInterval(() => {
      void status();
      if (planObserved && !operationRef.current) void plan();
    }, 6000);
    return () => {
      current = false;
      active.current = false;
      window.clearInterval(interval);
      loadStatusRef.current = () => {};
      loadPlanRef.current = () => {};
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [run.id, run.artifact?.sha256]);

  const displayed = review.displayed,
    shown = applicationVersion(displayed);
  const changed = Boolean(
    review.latest &&
    !sameApplicationVersion(shown, applicationVersion(review.latest)),
  );
  const acknowledged = sameApplicationVersion(shown, review.acknowledged);
  const ready =
    applicationDecisionReady(review, shown) &&
    available &&
    connected &&
    statusKnown &&
    !operation &&
    !planError;
  async function authorize() {
    if (mutationPending.current || !ready) return;
    const captured = captureApplicationRequest(reviewRef.current, shown, () =>
      crypto.randomUUID(),
    );
    if (!captured) {
      setActionError(
        "Open and acknowledge the exact current application plan before authorizing it.",
      );
      return;
    }
    store(captured.state);
    mutationPending.current = true;
    setAuthorizing(true);
    setActionError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const incoming = await authorizeDevelopmentApplication(
        run.id,
        captured.input,
        controller.signal,
      );
      if (!active.current) return;
      accept(incoming.operation);
      setStatusKnown(true);
      setConnected(true);
      store(confirmApplicationRefresh(reviewRef.current));
    } catch (cause) {
      if (!active.current) return;
      store(requireApplicationRefresh(reviewRef.current));
      setActionError(
        `${message(cause)} Check recorded application status before reviewing or retrying. The original request identity is retained.`,
      );
    } finally {
      controllers.current.delete(controller);
      mutationPending.current = false;
      if (active.current) setAuthorizing(false);
    }
  }
  function downloadReceipt() {
    if (!operation?.receipt || operation.status !== "applied") return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(operation.receipt, null, 2) + "\n"], {
        type: "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vuzmi-application-receipt-${operation.id}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section
      className="development-panel development-application"
      aria-labelledby="development-application-title"
    >
      <div className="development-section-heading">
        <div>
          <div className="section-kicker">
            SEPARATE LOCAL EFFECT / OWNER AUTHORIZATION
          </div>
          <h2 id="development-application-title" tabIndex={-1}>
            Local work branch
          </h2>
        </div>
        <span
          className={`source-state ${operation?.status === "applied" ? "source-ready" : operation && ["conflict", "unavailable", "unconfirmed"].includes(operation.status) ? "source-failed" : "source-queued"}`}
          role="status"
        >
          {operation
            ? statusLabels[operation.status]
            : review.refreshRequired
              ? "Application outcome unconfirmed"
              : statusKnown
                ? "No application receipt"
                : "Checking recorded state"}
        </span>
      </div>
      <p>
        Package approval saved the exact reviewed artifact. Creating its fixed
        local work branch needs a separate explicit authorization. The active
        checkout, index and branch stay unchanged; no code execution, push, PR,
        merge or deployment.
      </p>
      <Values
        entries={[
          ["Approved package SHA-256", run.artifact!.sha256],
          ["Pinned base commit", run.profile.baseCommit],
          ["Fixed destination", `refs/heads/vuzmi/development/${run.id}`],
        ]}
      />
      {statusError && (
        <div className="inline-error" role="alert">
          {statusError}
        </div>
      )}
      {actionError && (
        <div className="inline-error" role="alert">
          {actionError}
        </div>
      )}
      {review.refreshRequired && !operation && (
        <p className="development-application-warning" role="status">
          The authorization response is unconfirmed. Background polling cannot
          renew acknowledgment. Check recorded status explicitly; if no
          operation is returned, review the plan again to retry the same exact
          request.
        </p>
      )}
      <div className="development-application-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={statusLoading || authorizing}
          onClick={() => loadStatusRef.current(true)}
        >
          <Icon
            name="refresh"
            size={16}
            className={statusLoading ? "spinning" : ""}
          />
          {statusLoading ? "Checking status…" : "Check application status"}
        </button>
        {!operation && (
          <button
            type="button"
            className="button button-secondary"
            disabled={
              planLoading ||
              authorizing ||
              review.refreshRequired ||
              !statusKnown ||
              !connected
            }
            onClick={() => loadPlanRef.current(true)}
          >
            <Icon name="knowledge" size={17} />
            {planLoading
              ? "Loading exact plan…"
              : changed
                ? "Review updated application plan"
                : "Review local application"}
          </button>
        )}
      </div>
      {planError && (
        <div className="inline-error" role="alert">
          {planError}
        </div>
      )}
      {displayed && !available && (
        <div className="development-application-warning" role="status">
          <strong>Local application is unavailable</strong>
          <p>
            {reason ??
              "The server did not report an available registered Git connector. The plan can be inspected, but application is disabled."}
          </p>
        </div>
      )}
      {changed && !operation && (
        <div className="development-application-warning" role="status">
          <strong>Application plan changed</strong>
          <p>
            The displayed plan is retained. Open and acknowledge its exact
            replacement before authorizing; the old acknowledgment cannot select
            a new plan.
          </p>
        </div>
      )}
      {showPlan && displayed && !operation && (
        <div className="development-application-exact">
          <h3>Exact local application plan</h3>
          <p className="knowledge-hint">
            Review the repository identity, approved package, pinned base,
            generated branch and every changed file hash.
          </p>
          <Values entries={[["Plan fingerprint", displayed.fingerprint]]} />
          <pre
            id="development-application-plan"
            className="development-code"
            tabIndex={-1}
            aria-label="Exact local work branch application plan"
          >
            {JSON.stringify(displayed, null, 2)}
          </pre>
          <div className="development-acknowledgment">
            <p>
              {acknowledged
                ? "This exact application plan is acknowledged. Applying it remains a separate action."
                : "Acknowledge only the exact displayed local application plan."}
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={
                !shown ||
                !available ||
                !connected ||
                changed ||
                acknowledged ||
                review.refreshRequired ||
                authorizing ||
                !sameApplicationVersion(shown, review.opened)
              }
              onClick={() => {
                if (shown)
                  store(acknowledgeApplicationPlan(reviewRef.current, shown));
              }}
            >
              {acknowledged
                ? "Application plan acknowledged"
                : "I reviewed this application plan"}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!ready || authorizing}
              onClick={() => {
                void authorize();
              }}
            >
              <Icon
                name={authorizing ? "refresh" : "build"}
                size={17}
                className={authorizing ? "spinning" : ""}
              />
              {authorizing
                ? "Recording application authorization…"
                : review.attempt
                  ? "Retry exact local application request"
                  : "Apply to local work branch"}
            </button>
          </div>
        </div>
      )}
      {operation && (
        <div className="development-application-record">
          <h3>{statusLabels[operation.status]}</h3>
          <p className="knowledge-hint">
            Authorization is recorded separately from the original approved
            package.{" "}
            {operation.status === "queued" || operation.status === "running"
              ? "A successful branch-application receipt has not been recorded yet."
              : operation.status !== "applied"
                ? "This outcome does not establish a successful application or the absence of partial Git metadata effects."
                : "The receipt records the exact local work branch and commit created by this operation."}
          </p>
          <Values
            entries={[
              ["Application ID", operation.id],
              ["Revision", String(operation.revision)],
              ["Authorized by", operation.actorName ?? operation.actor],
              ["Authorized", when(operation.authorizedAt)],
              ["Request ID", operation.requestId],
              ["Plan fingerprint", operation.plan.fingerprint],
            ]}
          />
          {operation.error && (
            <div className="inline-error" role="status">
              <strong>{operation.error.code}</strong>
              <p>{operation.error.message}</p>
            </div>
          )}
          {operation.receipt && (
            <>
              <h3>Recorded application receipt</h3>
              <Values
                entries={[
                  ["Base commit", operation.receipt.baseCommit],
                  ["Local destination", operation.receipt.destinationRef],
                  ["Created commit", operation.receipt.commitOid],
                  ["Created tree", operation.receipt.treeOid],
                  ["Approved package SHA-256", operation.receipt.packageSha256],
                  ["Applied", when(operation.receipt.appliedAt)],
                ]}
              />
              <details className="development-disclosure">
                <summary>Exact receipt and changed file hashes</summary>
                <pre className="development-code" tabIndex={0}>
                  {JSON.stringify(operation.receipt, null, 2)}
                </pre>
                <Values
                  entries={operation.receipt.files.map((file) => [
                    file.path,
                    `Mode ${file.mode}\nBefore ${file.beforeSha256}\nAfter ${file.afterSha256}`,
                  ])}
                />
              </details>
              <button
                type="button"
                className="button button-secondary"
                onClick={downloadReceipt}
              >
                <Icon name="download" size={17} />
                Download receipt JSON
              </button>
            </>
          )}
          <details className="development-disclosure">
            <summary>Application authorization, plan and events</summary>
            <pre className="development-code" tabIndex={0}>
              {JSON.stringify(operation, null, 2)}
            </pre>
          </details>
        </div>
      )}
      {!operation && statusKnown && !review.refreshRequired && (
        <p className="knowledge-hint">
          No application receipt is recorded by Vuzmi. An operator may have
          applied this package separately outside the app.
        </p>
      )}
    </section>
  );
}

function Values({ entries }: { entries: [string, string][] }) {
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
