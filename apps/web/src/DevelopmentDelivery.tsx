import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  developmentDeliveryTextSchema,
  type DevelopmentDelivery,
  type DevelopmentDeliveryCi,
  type DevelopmentRun,
} from "@vuzmi/core";
import { Icon } from "./icons";
import {
  authorizeDevelopmentDelivery,
  getDevelopmentDelivery,
  prepareDevelopmentDelivery,
  refreshDevelopmentDelivery,
} from "./developmentDeliveryApi";
import {
  acknowledgeDeliveryPlan,
  captureDeliveryRequest,
  confirmDeliveryRefresh,
  deliveryCiState,
  deliveryDecisionReady,
  deliveryOperationMatchesRun,
  deliveryPlanMatchesRun,
  deliveryVersion,
  editDeliveryDraft,
  initialDeliveryReview,
  newerDelivery,
  openDeliveryPlan,
  receiveDeliveryPlan,
  requireDeliveryRefresh,
  sameDeliveryDraft,
  sameDeliveryVersion,
  type DeliveryReviewState,
} from "./developmentDeliveryReview";

const statusLabels: Record<DevelopmentDelivery["status"], string> = {
  queued: "Authorized · Queued",
  running: "Publishing reviewed draft PR",
  published: "Draft PR published",
  unconfirmed: "Publication unconfirmed",
  conflict: "Publication conflict",
};
const ciLabels: Record<DevelopmentDeliveryCi["state"], string> = {
  waiting: "Waiting for CI",
  running: "CI in progress",
  passed: "Named workflows passed",
  failed: "CI failed",
  unavailable: "CI unavailable",
  stale: "CI evidence is stale",
};
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "The GitHub delivery state could not be verified. Check recorded status before continuing.";
const when = (value: string) =>
  new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function DevelopmentDeliveryPanel({ run }: { run: DevelopmentRun }) {
  const [review, setReview] = useState(() =>
    initialDeliveryReview({
      title: run.title,
      body: run.candidate?.summary ?? run.title,
    }),
  );
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const [operation, setOperation] = useState<DevelopmentDelivery | null>(null);
  const operationRef = useRef<DevelopmentDelivery | null>(null);
  const [known, setKnown] = useState(false),
    [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false),
    [preparing, setPreparing] = useState(false),
    [authorizing, setAuthorizing] = useState(false);
  const [available, setAvailable] = useState(false),
    [reason, setReason] = useState<string | null>(null);
  const [authorityIdentity, setAuthorityIdentity] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null),
    [planError, setPlanError] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false),
    [expired, setExpired] = useState(false);
  const active = useRef(true),
    mutationPending = useRef(false),
    controllers = useRef(new Set<AbortController>());
  const loadStatusRef = useRef<(explicit?: boolean) => void>(() => {});
  function store(next: DeliveryReviewState) {
    reviewRef.current = next;
    setReview(next);
  }
  function accept(incoming: DevelopmentDelivery | null) {
    if (!incoming) {
      if (operationRef.current)
        throw new Error(
          "The response omitted a previously recorded delivery. Retaining its last observed record; check status before continuing.",
        );
      return;
    }
    if (!deliveryOperationMatchesRun(incoming, run))
      throw new Error(
        "The delivery response differs from this approved package, file scope or published head. Its controls remain disabled.",
      );
    const next = newerDelivery(operationRef.current, incoming);
    operationRef.current = next;
    setOperation(next);
  }
  useEffect(() => {
    let current = true,
      pending = false;
    active.current = true;
    async function status(explicit = false) {
      if (pending) return;
      pending = true;
      setLoading(true);
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        if (explicit) {
          const incoming = await refreshDevelopmentDelivery(
            run.id,
            controller.signal,
          );
          if (!current) return;
          accept(incoming);
        }
        const incoming = await getDevelopmentDelivery(
          run.id,
          controller.signal,
        );
        if (!current) return;
        accept(incoming.operation);
        setKnown(true);
        setConnected(true);
        setError(null);
        setAvailable(incoming.available);
        setReason(incoming.reason);
        setAuthorityIdentity(incoming.authorityIdentity);
        if (explicit) store(confirmDeliveryRefresh(reviewRef.current));
      } catch (cause) {
        if (current) {
          setConnected(false);
          setError(message(cause));
        }
      } finally {
        controllers.current.delete(controller);
        pending = false;
        if (current) setLoading(false);
      }
    }
    function sessionExpired() {
      current = false;
      active.current = false;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      setExpired(true);
      setConnected(false);
    }
    loadStatusRef.current = (explicit = false) => {
      void status(explicit);
    };
    void status();
    const interval = window.setInterval(() => {
      if (!current) return;
      void status(); // Recorded database state only; no GitHub requests from background polling.
    }, 6000);
    window.addEventListener("vuzmi:session-expired", sessionExpired);
    return () => {
      current = false;
      active.current = false;
      window.clearInterval(interval);
      window.removeEventListener("vuzmi:session-expired", sessionExpired);
      loadStatusRef.current = () => {};
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [run.id, run.artifact?.sha256]);

  const displayed = review.displayed?.plan,
    shown = deliveryVersion(displayed);
  const changed = Boolean(
    review.latest &&
    (!sameDeliveryVersion(shown, deliveryVersion(review.latest.plan)) ||
      !sameDeliveryDraft(review.draft, review.latest.draft)),
  );
  const acknowledged = sameDeliveryVersion(shown, review.acknowledged);
  const textValid = developmentDeliveryTextSchema.safeParse(
    review.draft,
  ).success;
  const matchingAuthority = Boolean(
    displayed?.authorityIdentity &&
    displayed.authorityIdentity === authorityIdentity,
  );
  const ready =
    !expired &&
    matchingAuthority &&
    deliveryDecisionReady(review, shown) &&
    available &&
    connected &&
    known &&
    !operation &&
    !planError;
  async function prepare(event?: FormEvent) {
    event?.preventDefault();
    if (
      preparing ||
      authorizing ||
      reviewRef.current.refreshRequired ||
      operationRef.current ||
      !textValid
    )
      return;
    const input = { ...reviewRef.current.draft };
    setPreparing(true);
    setPlanError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const incoming = await prepareDevelopmentDelivery(
        run.id,
        input,
        controller.signal,
      );
      if (!active.current || !sameDeliveryDraft(input, reviewRef.current.draft))
        return;
      if (!deliveryPlanMatchesRun(incoming.plan, run))
        throw new Error(
          "The delivery plan does not match this exact approved package and changed files. Refresh the saved package before continuing.",
        );
      store(receiveDeliveryPlan(reviewRef.current, incoming.plan, input));
      setAvailable(incoming.available);
      setReason(incoming.reason);
      setAuthorityIdentity(
        incoming.available ? incoming.plan.authorityIdentity : null,
      );
      setConnected(true);
    } catch (cause) {
      if (active.current && sameDeliveryDraft(input, reviewRef.current.draft)) {
        setPlanError(message(cause));
        setAvailable(false);
      }
    } finally {
      controllers.current.delete(controller);
      if (active.current) setPreparing(false);
    }
  }
  function openExact() {
    const next = openDeliveryPlan(reviewRef.current);
    store(next);
    if (!next.opened) return;
    setShowPlan(true);
    window.requestAnimationFrame(() => {
      if (!active.current) return;
      const node = document.getElementById("development-delivery-plan");
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "start" });
    });
  }
  async function authorize() {
    if (mutationPending.current || !ready) return;
    const captured = captureDeliveryRequest(reviewRef.current, shown, () =>
      crypto.randomUUID(),
    );
    if (!captured) {
      setError(
        "Open and acknowledge the exact current publication plan before authorizing it.",
      );
      return;
    }
    store(captured.state);
    mutationPending.current = true;
    setAuthorizing(true);
    setError(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const incoming = await authorizeDevelopmentDelivery(
        run.id,
        captured.input,
        controller.signal,
      );
      if (!active.current) return;
      accept(incoming.operation);
      setKnown(true);
      setConnected(true);
      store(confirmDeliveryRefresh(reviewRef.current));
    } catch (cause) {
      if (active.current) {
        store(requireDeliveryRefresh(reviewRef.current));
        setAvailable(false);
        setError(
          `${message(cause)} Publication may already have started. Check recorded delivery status; the exact original request identity is retained.`,
        );
      }
    } finally {
      controllers.current.delete(controller);
      mutationPending.current = false;
      if (active.current) setAuthorizing(false);
    }
  }
  function downloadReceipt() {
    if (!operation?.receipt) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(operation.receipt, null, 2) + "\n"], {
        type: "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vuzmi-delivery-receipt-${operation.id}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (expired)
    return (
      <section className="development-panel">
        <p role="status">
          Session expired. Sign in to inspect protected delivery state.
        </p>
      </section>
    );
  return (
    <section
      className="development-panel development-delivery"
      aria-labelledby="development-delivery-title"
    >
      <div className="development-section-heading">
        <div>
          <div className="section-kicker">
            SEPARATE PUBLIC EFFECT / OWNER AUTHORIZATION
          </div>
          <h2 id="development-delivery-title" tabIndex={-1}>
            GitHub delivery
          </h2>
        </div>
        <span
          className={`source-state ${operation?.status === "published" ? "source-ready" : operation && ["unconfirmed", "conflict"].includes(operation.status) ? "source-failed" : "source-queued"}`}
          role="status"
        >
          {operation
            ? statusLabels[operation.status]
            : review.refreshRequired
              ? "Publication unconfirmed"
              : known
                ? "No delivery receipt"
                : "Checking recorded state"}
        </span>
      </div>
      <p>
        Publish the exact applied local commit to the public Vuzmi repository
        and create one reviewed draft pull request. Package approval and local
        branch application do not authorize this publication.
      </p>
      <Values
        entries={[
          ["Public repository", "Ether-X-UK/Vuzmi"],
          [
            "Fixed publication branch",
            `refs/heads/vuzmi/development/${run.id}`,
          ],
          ["Target branch", "main"],
          ["Approved package SHA-256", run.artifact!.sha256],
        ]}
      />
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {review.refreshRequired && !operation && (
        <div className="development-application-warning" role="status">
          <strong>Publication outcome unconfirmed</strong>
          <p>
            Public Git objects, a branch or a PR may already exist. Check
            recorded status explicitly before reviewing a retry. Background
            polling cannot renew acknowledgment or repeat publication.
          </p>
        </div>
      )}
      <div className="development-application-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={loading || authorizing}
          onClick={() => loadStatusRef.current(true)}
        >
          <Icon
            name="refresh"
            size={16}
            className={loading ? "spinning" : ""}
          />
          {loading
            ? "Checking delivery…"
            : operation
              ? "Reconcile delivery and refresh CI"
              : "Check recorded delivery status"}
        </button>
      </div>
      {!operation && (
        <>
          <form
            className="knowledge-form development-delivery-form"
            onSubmit={(event) => {
              void prepare(event);
            }}
          >
            <h3>Prepare a draft PR plan</h3>
            <p className="knowledge-hint">
              Preparation is read-only. The title and body below will be public
              if you separately authorize the reviewed plan. The server adds a
              visible operation marker to the exact PR body.
            </p>
            <label
              className="field-label"
              htmlFor="development-delivery-title-input"
            >
              Public PR title
            </label>
            <input
              id="development-delivery-title-input"
              required
              minLength={3}
              maxLength={160}
              value={review.draft.title}
              disabled={authorizing || review.refreshRequired}
              onChange={(event) => {
                store(
                  editDeliveryDraft(reviewRef.current, {
                    ...reviewRef.current.draft,
                    title: event.target.value,
                  }),
                );
                setAvailable(false);
              }}
            />
            <label
              className="field-label"
              htmlFor="development-delivery-body-input"
            >
              Public PR body
            </label>
            <textarea
              id="development-delivery-body-input"
              required
              maxLength={16000}
              rows={7}
              value={review.draft.body}
              disabled={authorizing || review.refreshRequired}
              onChange={(event) => {
                store(
                  editDeliveryDraft(reviewRef.current, {
                    ...reviewRef.current.draft,
                    body: event.target.value,
                  }),
                );
                setAvailable(false);
              }}
            />
            <p className="knowledge-hint">
              UTF-8 size: title{" "}
              {new TextEncoder().encode(review.draft.title).length}/160 bytes ·
              body{" "}
              {new TextEncoder()
                .encode(review.draft.body)
                .length.toLocaleString("en-GB")}
              /16,000 bytes. Use a title of at least 3 characters and nonempty
              body text. Control characters and reserved Vuzmi markers are
              unsupported.
            </p>
            <div className="development-application-actions">
              <button
                type="submit"
                className="button button-secondary"
                disabled={
                  !known ||
                  !connected ||
                  !textValid ||
                  preparing ||
                  authorizing ||
                  review.refreshRequired
                }
              >
                <Icon
                  name="refresh"
                  size={16}
                  className={preparing ? "spinning" : ""}
                />
                {preparing
                  ? "Observing exact publication plan…"
                  : review.latest
                    ? "Recheck publication plan"
                    : "Prepare draft PR plan"}
              </button>
              {review.latest && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    preparing ||
                    authorizing ||
                    review.refreshRequired ||
                    !sameDeliveryDraft(review.draft, review.latest.draft)
                  }
                  onClick={openExact}
                >
                  <Icon name="knowledge" size={16} />
                  {changed
                    ? "Read updated delivery plan"
                    : "Read exact delivery plan"}
                </button>
              )}
            </div>
          </form>
          {planError && (
            <div className="inline-error" role="alert">
              {planError}
            </div>
          )}
          {(!available || (displayed && !matchingAuthority)) && (
            <div className="development-application-warning" role="status">
              <strong>Publication is disabled</strong>
              <p>
                {available && displayed && !matchingAuthority
                  ? "The displayed plan does not match the currently connected publication authority. Recheck the publication plan and review its exact replacement."
                  : (reason ??
                    "An operator-configured server credential and a fresh matching trusted worker are required. You can prepare the actual plan without connecting a publication credential.")}
              </p>
            </div>
          )}
          {changed && (
            <div className="development-application-warning" role="status">
              <strong>Delivery plan changed</strong>
              <p>
                Your displayed plan and typed text are retained. Prepare the
                current text, then deliberately open and acknowledge the exact
                replacement before publishing.
              </p>
            </div>
          )}
          {showPlan && displayed && (
            <div className="development-application-exact">
              <h3>Exact public delivery plan</h3>
              <Values
                entries={[
                  ["Plan fingerprint", displayed.fingerprint],
                  ["Applied commit", displayed.commitOid],
                  ["Applied tree", displayed.treeOid],
                  ["Pinned parent commit", displayed.baseCommit],
                  ["Observed main commit", displayed.targetSha],
                  ["Target observed", when(displayed.targetObservedAt)],
                  ["Pull request", "Draft · targets main"],
                  ["Application ID", displayed.applicationId],
                  [
                    "Application plan fingerprint",
                    displayed.applicationPlanFingerprint,
                  ],
                  [
                    "Publication authority",
                    displayed.authorityIdentity ??
                      "Disconnected — prepare again after configuration",
                  ],
                ]}
              />
              <div className="development-delivery-disclosure">
                <h4>What becomes public</h4>
                <p>{displayed.disclosure}</p>
                <p>{displayed.scope}</p>
              </div>
              <h4>Exact public PR title</h4>
              <p className="development-delivery-text">{displayed.title}</p>
              <h4>Exact public PR body, including operation marker</h4>
              <pre
                className="development-code development-delivery-text"
                tabIndex={0}
              >
                {displayed.body}
              </pre>
              <h4>Exact commit author and committer</h4>
              <Values
                entries={[
                  [
                    "Author",
                    `${displayed.commit.author.name} <${displayed.commit.author.email}>\n${displayed.commit.author.date}`,
                  ],
                  [
                    "Committer",
                    `${displayed.commit.committer.name} <${displayed.commit.committer.email}>\n${displayed.commit.committer.date}`,
                  ],
                ]}
              />
              <h4>Exact commit message and retained identifiers</h4>
              <pre
                className="development-code development-delivery-text"
                tabIndex={0}
              >
                {displayed.commit.message}
              </pre>
              <h4>Complete plan</h4>
              <pre
                id="development-delivery-plan"
                className="development-code"
                tabIndex={-1}
                aria-label="Exact public GitHub delivery plan"
              >
                {JSON.stringify(displayed, null, 2)}
              </pre>
              <div className="development-acknowledgment">
                <p>
                  {acknowledged
                    ? "This exact publication plan is acknowledged. Publication remains a separate action."
                    : "Review the exact source identities, public text and commit metadata before acknowledging this plan."}
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={
                    !shown ||
                    !connected ||
                    changed ||
                    acknowledged ||
                    review.refreshRequired ||
                    authorizing ||
                    !sameDeliveryVersion(shown, review.opened)
                  }
                  onClick={() => {
                    if (shown)
                      store(acknowledgeDeliveryPlan(reviewRef.current, shown));
                  }}
                >
                  {acknowledged
                    ? "Publication plan acknowledged"
                    : "I reviewed this publication plan"}
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!ready || authorizing || preparing}
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
                    ? "Recording publication authorization…"
                    : review.attempt
                      ? "Retry exact reviewed publication request"
                      : "Publish branch and create draft PR"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {operation && (
        <div className="development-application-record">
          <h3>{statusLabels[operation.status]}</h3>
          <p className="knowledge-hint">
            {operation.status === "published"
              ? "The receipt records the exact public branch and draft PR. Publication does not merge, deploy or establish release readiness."
              : "This authorization is separate from the package and local application. A successful publication receipt has not been established."}
          </p>
          <Values
            entries={[
              ["Delivery ID", operation.id],
              ["Revision", String(operation.revision)],
              ["Authorized by", operation.actorName ?? operation.actor],
              ["Authorized", when(operation.authorizedAt)],
              ["Request ID", operation.requestId],
              ["Plan fingerprint", operation.plan.fingerprint],
              ["Exact head commit", operation.plan.commitOid],
              [
                "Last reserved publication phase",
                operation.phase ?? "Not started",
              ],
            ]}
          />
          {operation.error && (
            <div className="inline-error" role="status">
              <strong>{operation.error.code}</strong>
              <p>{operation.error.message}</p>
            </div>
          )}
          {operation.status === "unconfirmed" && (
            <div className="development-application-warning" role="status">
              <strong>Possible partial publication</strong>
              <p>
                Public objects, the work branch or a draft PR may already exist.
                Reconciliation uses reads only; an absent response does not
                prove no effects. This operation cannot automatically repeat an
                external write.
              </p>
            </div>
          )}
          {operation.receipt && (
            <>
              <h3>Recorded draft PR receipt</h3>
              <a
                className="button button-secondary development-delivery-link"
                href={operation.receipt.prUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open draft PR #{operation.receipt.prNumber}
                <span aria-hidden="true"> ↗</span>
              </a>
              <Values
                entries={[
                  ["Public PR URL", operation.receipt.prUrl],
                  ["Public head branch", operation.receipt.headRef],
                  ["Public head commit", operation.receipt.headSha],
                  [
                    "Observed main before publication",
                    operation.receipt.baseShaBefore,
                  ],
                  [
                    "Observed main after publication",
                    operation.receipt.baseShaAfter,
                  ],
                  [
                    "Target drift",
                    operation.receipt.targetDrift
                      ? "Main moved during publication — review the changed target"
                      : "No drift observed between recorded checks",
                  ],
                  ["Published", when(operation.receipt.publishedAt)],
                ]}
              />
              {operation.receipt.targetDrift && (
                <p className="development-application-warning" role="status">
                  The target moved during publication. GitHub creates PRs
                  against a branch name; these observations do not pin the PR
                  target forever.
                </p>
              )}
              <details className="development-disclosure">
                <summary>Exact publication receipt</summary>
                <pre className="development-code" tabIndex={0}>
                  {JSON.stringify(operation.receipt, null, 2)}
                </pre>
              </details>
              <button
                type="button"
                className="button button-secondary"
                onClick={downloadReceipt}
              >
                <Icon name="download" size={16} />
                Download delivery receipt JSON
              </button>
              <CiEvidence operation={operation} />
            </>
          )}
          <details className="development-disclosure">
            <summary>Delivery authorization, exact plan and events</summary>
            <pre className="development-code" tabIndex={0}>
              {JSON.stringify(operation, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}

function CiEvidence({ operation }: { operation: DevelopmentDelivery }) {
  const ci = operation.ci,
    state = ci ? deliveryCiState(ci, operation.plan.commitOid) : null;
  return (
    <section
      className="development-delivery-ci"
      aria-labelledby="development-delivery-ci-title"
    >
      <div className="development-section-heading">
        <h3 id="development-delivery-ci-title">CI evidence</h3>
        <span
          className={`source-state ${state === "passed" ? "source-ready" : state === "failed" || state === "stale" || state === "unavailable" ? "source-failed" : "source-queued"}`}
        >
          {state ? ciLabels[state] : "Not observed"}
        </span>
      </div>
      <p className="knowledge-hint">
        Read-only Actions observations for this exact published head. Refreshing
        evidence does not dispatch or rerun a workflow. Named workflow results
        do not establish all branch-protection requirements or release
        readiness.
      </p>
      <Values
        entries={[
          ["Expected head", operation.plan.commitOid],
          [
            "Last observed",
            ci ? when(ci.observedAt) : "No CI observation recorded",
          ],
        ]}
      />
      {ci && (
        <>
          <Values
            entries={[
              ["Observed current head", ci.currentHeadSha ?? "Unavailable"],
              ["Observed current target", ci.currentBaseSha ?? "Unavailable"],
              [
                "Target changed since publication plan",
                ci.targetDrift
                  ? "Yes — review changed target before relying on CI"
                  : "No drift reported in this observation",
              ],
            ]}
          />
          {ci.reason && (
            <p className="development-application-warning">{ci.reason}</p>
          )}
          {ci.runs.length === 0 && (
            <p className="development-application-warning">
              No workflow runs were returned for this head. This is not passing
              CI evidence.
            </p>
          )}
          {ci.truncated && (
            <p className="development-application-warning">
              The workflow list reached its bounded limit. This observation may
              omit additional runs.
            </p>
          )}
          <ul className="development-delivery-workflows">
            {ci.runs.map((workflow) => (
              <li key={workflow.id}>
                <a href={workflow.url} target="_blank" rel="noreferrer">
                  {workflow.workflowName || "Unnamed workflow"} ↗
                </a>
                <Values
                  entries={[
                    ["Run", `${workflow.id} · attempt ${workflow.runAttempt}`],
                    [
                      "Workflow",
                      `${workflow.workflowId}\n${workflow.workflowPath}`,
                    ],
                    ["Event", workflow.event],
                    ["Status", workflow.status],
                    ["Conclusion", workflow.conclusion ?? "No conclusion yet"],
                    ["Head", workflow.headSha],
                    ["Recorded base", workflow.baseSha ?? "Not supplied"],
                    [
                      "Observed PR merge context",
                      workflow.observedPrMergeSha ?? "Not supplied",
                    ],
                  ]}
                />
              </li>
            ))}
          </ul>
        </>
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
