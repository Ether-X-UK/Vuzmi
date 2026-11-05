import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createRunSchema,
  deriveRunSteps,
  getRunWorkflowLabel,
  extractDraftBody,
  domainLabels,
  domainSchema,
  type CreateRunInput,
  type Domain,
  type Run,
  type RunStatus,
  type SafeOwner,
  type WorkspaceSnapshot,
  type RuntimeInfo,
  type KnowledgeSnapshot,
  type EvidenceSelection,
} from "@vuzmi/core";
import {
  ApiError,
  createRun,
  decideRun,
  getRun,
  getWorkspace,
  getRuntime,
} from "./api";
import { BrandMark, Icon, type IconName } from "./icons";
import { runtimeBlockReason } from "./runtime";
import { RuntimeView } from "./RuntimeView";
import { KnowledgeView } from "./KnowledgeView";
import { OutboxView } from "./OutboxView";
const ArtifactDocument = lazy(() =>
  import("./ArtifactDocument").then((module) => ({
    default: module.ArtifactDocument,
  })),
);
const DraftEditor = lazy(() =>
  import("./DraftEditor").then((module) => ({ default: module.DraftEditor })),
);
import { getKnowledge } from "./knowledgeApi";
import { EvidencePanel, EvidencePicker, validSelection } from "./Evidence";
import {
  openDraftSession,
  retainedDraft,
  type DraftSession,
} from "./draftSession";

type Route = {
  page: "command" | "runs" | "approvals" | "outbox" | "roadmap";
  runId?: string;
  section?: string;
};
const domains = Object.keys(domainLabels) as Domain[];
const statusLabels: Record<RunStatus, string> = {
  queued: "Queued",
  running: "In progress",
  waiting_approval: "Needs review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const defaultBrief =
  "Prepare a reviewable release brief for Vuzmi’s private alpha. Set out the intended outcome, checks still to perform, known limitations, and the handoff to our infrastructure team. Keep every proposed action local and subject to review.";

function readRoute(): Route {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "runs") {
    try {
      return {
        page: "runs",
        runId: parts[1] ? decodeURIComponent(parts[1]) : undefined,
      };
    } catch {
      return { page: "runs" };
    }
  }
  if (parts[0] === "outbox") return { page: "outbox" };
  if (parts[0] === "approvals") return { page: "approvals" };
  if (parts[0] === "roadmap")
    return { page: "roadmap", section: parts[1] ?? "foundation" };
  return { page: "command" };
}

function runLink(run: Run): string {
  return `#/runs/${encodeURIComponent(run.id)}`;
}
function dateTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function shortId(value: string): string {
  return value.replace(/^run-/, "").slice(0, 8);
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
function recordedNumber(value: number | null): string {
  return value === null ? "Not recorded" : value.toLocaleString("en-GB");
}
function latestRuns(runs: Run[]): Run[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function preserveNewerRuns(current: Run[], incoming: Run[]): Run[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const existing = byId.get(run.id);
    if (!existing || run.revision >= existing.revision) byId.set(run.id, run);
  }
  return latestRuns([...byId.values()]);
}

export function App({
  owner = null,
  development = true,
  onSignOut,
  signingOut = false,
}: {
  owner?: SafeOwner | null;
  development?: boolean;
  onSignOut?: () => void;
  signingOut?: boolean;
}) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [missionOpen, setMissionOpen] = useState(false);
  const [domain, setDomain] = useState<Domain | "all">("all");
  const [runError, setRunError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const requestVersion = useRef(0);
  const runtimeVersion = useRef(0);
  const [knowledge, setKnowledge] = useState<KnowledgeSnapshot | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);
  const knowledgeVersion = useRef(0);
  const refreshKnowledge = useCallback(async () => {
    const version = ++knowledgeVersion.current;
    setKnowledgeLoading(true);
    try {
      const incoming = await getKnowledge();
      if (version !== knowledgeVersion.current) return;
      setKnowledge(incoming);
      setKnowledgeError(null);
    } catch (error) {
      if (version === knowledgeVersion.current)
        setKnowledgeError(errorMessage(error));
    } finally {
      if (version === knowledgeVersion.current) setKnowledgeLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshKnowledge();
    const interval = window.setInterval(() => {
      void refreshKnowledge();
    }, 6000);
    return () => {
      window.clearInterval(interval);
      knowledgeVersion.current += 1;
    };
  }, [refreshKnowledge]);

  const refreshRuntime = useCallback(async () => {
    const version = ++runtimeVersion.current;
    setRuntimeLoading(true);
    try {
      const info = await getRuntime();
      if (version !== runtimeVersion.current) return;
      setRuntime(info);
      setRuntimeError(null);
    } catch (error) {
      if (version === runtimeVersion.current)
        setRuntimeError(errorMessage(error));
    } finally {
      if (version === runtimeVersion.current) setRuntimeLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshRuntime();
    const interval = window.setInterval(() => {
      void refreshRuntime();
    }, 15000);
    return () => {
      window.clearInterval(interval);
      runtimeVersion.current += 1;
    };
  }, [refreshRuntime]);

  useEffect(() => {
    const update = () => {
      setRoute(readRoute());
      setRunError(null);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  const refresh = useCallback(async (showLoading = false) => {
    const version = ++requestVersion.current;
    if (showLoading) setLoading(true);
    try {
      const incoming = await getWorkspace();
      if (version !== requestVersion.current) return;
      setSnapshot((current) => ({
        ...incoming,
        runs: preserveNewerRuns(current?.runs ?? [], incoming.runs),
      }));
      setConnectionError(null);
      setLastUpdated(new Date().toISOString());
    } catch (error) {
      if (version === requestVersion.current)
        setConnectionError(errorMessage(error));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => {
      void refresh();
    }, 7000);
    return () => {
      window.clearInterval(interval);
      requestVersion.current += 1;
    };
  }, [refresh]);

  const updateRun = useCallback((run: Run) => {
    requestVersion.current += 1;
    setSnapshot((current) =>
      current
        ? { ...current, runs: preserveNewerRuns(current.runs, [run]) }
        : current,
    );
    setLoading(false);
    setConnectionError(null);
    setLastUpdated(new Date().toISOString());
  }, []);

  const selectedRun = route.runId
    ? snapshot?.runs.find((run) => run.id === route.runId)
    : undefined;
  useEffect(() => {
    if (!route.runId || !snapshot || selectedRun) return;
    let active = true;
    void getRun(route.runId)
      .then((run) => {
        if (active) updateRun(run);
      })
      .catch((error: unknown) => {
        if (active) setRunError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [route.runId, Boolean(snapshot), Boolean(selectedRun), updateRun]);

  const runs = snapshot?.runs ?? [];
  const waitingCount = runs.filter(
    (run) => run.status === "waiting_approval",
  ).length;
  const connected = Boolean(snapshot) && !connectionError;

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          main?.focus();
          main?.scrollIntoView({ block: "start" });
        }}
      >
        Skip to content
      </a>
      <Sidebar
        route={route}
        waitingCount={waitingCount}
        connected={connected}
        operatorName={owner?.name ?? "Local operator"}
      />
      <div className="app-body">
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {selectedRun
            ? `${selectedRun.title}: ${statusLabels[selectedRun.status]}.${selectedRun.artifact ? " Local artifact saved." : selectedRun.decision?.decision === "reject" ? " No artifact was saved." : ""}`
            : ""}
        </p>
        <header className="topbar">
          <div className="workspace-identity">
            <span className="workspace-avatar">
              <BrandMark size={21} />
            </span>
            <div>
              <strong>{snapshot?.workspace.name ?? "Vuzmi workspace"}</strong>
              <span>Private local workspace</span>
            </div>
          </div>
          <div className="topbar-end">
            <span className={development ? "development-badge" : "owner-name"}>
              {development ? "Development · no sign-in" : owner?.name}
            </span>
            {!development && (
              <button
                className="button button-small button-secondary"
                onClick={onSignOut}
                disabled={signingOut}
              >
                Sign out
              </button>
            )}
            <span className="local-policy">
              <Icon name="shield" size={15} /> Cloud execution off
            </span>
            <span
              className={`connection-state ${connected ? "connected" : ""}`}
            >
              <i />
              {loading && !snapshot
                ? "Connecting"
                : connected
                  ? "Backend connected"
                  : "Disconnected"}
            </span>
            <button
              className="icon-button refresh-button"
              aria-label="Refresh workspace"
              onClick={() => {
                void refresh(true);
              }}
              disabled={loading}
            >
              <Icon
                name="refresh"
                size={17}
                className={loading ? "spinning" : ""}
              />
            </button>
          </div>
        </header>

        <main
          id="main-content"
          className={`main-content ${route.runId ? "detail-content" : ""}`}
          tabIndex={-1}
        >
          {connectionError && (
            <div className="connection-notice" role="status">
              <Icon name="alert" size={18} />
              <div>
                <strong>Connection needs attention</strong>
                <p>
                  {connectionError}
                  {lastUpdated ? ` Last updated ${dateTime(lastUpdated)}.` : ""}
                </p>
              </div>
              <button
                className="button button-small button-secondary"
                onClick={() => {
                  void refresh(true);
                }}
              >
                Reconnect
              </button>
            </div>
          )}
          {loading && !snapshot ? (
            <LoadingState />
          ) : !snapshot ? (
            <EmptyState
              icon="operate"
              title="Let’s connect your workspace."
              description="Start the local Vuzmi API, then reconnect to see your real runs and approvals."
              action={
                <button
                  className="button button-primary"
                  onClick={() => {
                    void refresh(true);
                  }}
                >
                  <Icon name="refresh" size={17} />
                  Reconnect
                </button>
              }
            />
          ) : route.runId ? (
            selectedRun ? (
              <RunDetail
                run={selectedRun}
                onUpdate={updateRun}
                connected={connected}
                storage={snapshot.workspace.storage}
                ownerId={owner?.id ?? null}
              />
            ) : (
              <EmptyState
                icon="runs"
                title={
                  runError ? "This run could not be opened." : "Opening run…"
                }
                description={
                  runError ?? "Loading the saved run from your local workspace."
                }
                action={
                  <a className="button button-secondary" href="#/runs">
                    Back to runs
                  </a>
                }
              />
            )
          ) : route.page === "command" ? (
            <CommandView runs={runs} onNew={() => setMissionOpen(true)} />
          ) : route.page === "runs" ? (
            <RunsView
              runs={runs}
              domain={domain}
              onDomain={setDomain}
              onNew={() => setMissionOpen(true)}
            />
          ) : route.page === "outbox" ? (
            <OutboxView />
          ) : route.page === "approvals" ? (
            <ApprovalsView runs={runs} />
          ) : route.section === "knowledge" ? (
            <KnowledgeView
              snapshot={knowledge}
              error={knowledgeError}
              loading={knowledgeLoading}
              onRefresh={refreshKnowledge}
            />
          ) : route.section === "models" ? (
            <RuntimeView
              runtime={runtime}
              error={runtimeError}
              loading={runtimeLoading}
              onRefresh={() => {
                void refreshRuntime();
              }}
            />
          ) : (
            <RoadmapView section={route.section ?? "foundation"} />
          )}
          <footer className="page-footer">
            <span>
              Vuzmi <span className="footer-divider">/</span> Private alpha
            </span>
            <a className="footer-source" href="/source">
              Source · AGPL-3.0
            </a>
            <span>
              <span className="small-dot" /> Local-only · Human reviewed
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-navigation" aria-label="Mobile navigation">
        <MobileLink
          href="#/"
          name="command"
          label="Command"
          active={route.page === "command"}
        />
        <MobileLink
          href="#/runs"
          name="runs"
          label="Runs"
          active={route.page === "runs"}
        />
        <MobileLink
          href="#/approvals"
          name="check"
          label="Approvals"
          active={route.page === "approvals"}
        />
        <MobileLink
          href="#/roadmap/knowledge"
          name="knowledge"
          label="Knowledge"
          ariaLabel="Knowledge and memory"
          active={route.page === "roadmap" && route.section === "knowledge"}
        />
        <MobileLink
          href="#/roadmap/models"
          name="models"
          label="Models"
          ariaLabel="Model control"
          active={route.page === "roadmap" && route.section === "models"}
        />
      </nav>
      {missionOpen && (
        <NewMissionDialog
          initialDomain={domain === "all" ? "build" : domain}
          runtime={runtime}
          runtimeError={runtimeError}
          knowledge={knowledge}
          knowledgeError={knowledgeError}
          onClose={() => setMissionOpen(false)}
          onCreated={(run) => {
            updateRun(run);
            setMissionOpen(false);
            window.location.hash = runLink(run).slice(1);
          }}
        />
      )}
    </div>
  );
}

function Sidebar({
  route,
  waitingCount,
  connected,
  operatorName,
}: {
  route: Route;
  operatorName: string;
  waitingCount: number;
  connected: boolean;
}) {
  const links: {
    label: string;
    icon: IconName;
    href: string;
    page: Route["page"];
  }[] = [
    { label: "Command", icon: "command", href: "#/", page: "command" },
    { label: "Runs", icon: "runs", href: "#/runs", page: "runs" },
    {
      label: "Local outbox",
      icon: "download",
      href: "#/outbox",
      page: "outbox",
    },
    {
      label: "Approvals",
      icon: "check",
      href: "#/approvals",
      page: "approvals",
    },
  ];
  return (
    <aside className="sidebar">
      <a className="brand" href="#/" aria-label="Vuzmi command">
        <BrandMark />
        <span>
          vuzmi<span className="brand-period">.</span>
        </span>
      </a>
      <div className="sidebar-label">WORKSPACE</div>
      <nav className="primary-navigation" aria-label="Main navigation">
        {links.map((link) => (
          <a
            key={link.page}
            aria-label={link.label}
            href={link.href}
            className={`nav-link ${route.page === link.page ? "active" : ""}`}
            aria-current={route.page === link.page ? "page" : undefined}
          >
            <Icon name={link.icon} size={19} />
            <span>{link.label}</span>
            {link.page === "approvals" && waitingCount > 0 && (
              <span className="nav-count">{waitingCount}</span>
            )}
          </a>
        ))}
        <a
          aria-label="Model control"
          className={`nav-link ${route.section === "models" ? "active" : ""}`}
          aria-current={route.section === "models" ? "page" : undefined}
          href="#/roadmap/models"
        >
          <Icon name="models" size={19} />
          <span>Model control</span>
        </a>
        <a
          aria-label="Knowledge and memory"
          className={`nav-link ${route.section === "knowledge" ? "active" : ""}`}
          aria-current={route.section === "knowledge" ? "page" : undefined}
          href="#/roadmap/knowledge"
        >
          <Icon name="knowledge" size={19} />
          <span>Knowledge & memory</span>
        </a>
      </nav>
      <div className="sidebar-label platform-label">
        THE FOUNDATION <span>PLANNED</span>
      </div>
      <nav className="secondary-navigation" aria-label="Planned platform">
        <a
          aria-label="Agents and automations, planned"
          className={`nav-link ${route.section === "agents" ? "active" : ""}`}
          href="#/roadmap/agents"
        >
          <Icon name="agents" size={19} />
          <span>Agents & automations</span>
        </a>
      </nav>
      <div className="sidebar-bottom">
        <div className="local-instance">
          <div className="instance-icon">
            <Icon name="shield" size={19} />
          </div>
          <div>
            <strong>Your infrastructure.</strong>
            <span>Your control.</span>
          </div>
        </div>
        <div className="sidebar-version">
          <span className={connected ? "small-dot" : "small-dot muted-dot"} />
          LOCAL ALPHA <span>v0.1</span>
        </div>
        <div className="operator">
          <span className="operator-avatar">
            {operatorName
              .split(/\s+/)
              .map((word) => word[0])
              .slice(0, 2)
              .join("")
              .toUpperCase()}
          </span>
          <div>
            <strong>{operatorName}</strong>
            <span>Private workspace</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MobileLink({
  href,
  name,
  label,
  active,
  ariaLabel,
}: {
  href: string;
  name: IconName;
  label: string;
  active: boolean;
  ariaLabel?: string;
}) {
  return (
    <a
      href={href}
      aria-label={ariaLabel ?? label}
      className={active ? "active" : ""}
      aria-current={active ? "page" : undefined}
    >
      <Icon name={name} size={20} />
      <span>{label}</span>
    </a>
  );
}

function PageEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="page-eyebrow">
      <span className="eyebrow-line" />
      {children}
    </div>
  );
}
function SimulationBadge() {
  return (
    <span className="simulation-badge">
      <span />
      LOCAL SIMULATION
    </span>
  );
}

function ModeBadge({ run }: { run: Run }) {
  return run.mode === "simulation" ? (
    <SimulationBadge />
  ) : (
    <span className="simulation-badge">
      <span />
      LOCAL OLLAMA
    </span>
  );
}

function runNextStep(run: Run): string {
  if (run.artifact) return "Local artifact saved";
  if (run.status === "waiting_approval")
    return "Review the exact proposed artifact";
  if (run.decision?.decision === "reject")
    return "Proposal rejected · no artifact saved";
  if (run.error) return run.error.message;
  if (run.status === "queued") return "Queued for the local worker";
  if (run.status === "running") return "Local generation in progress";
  return run.mode === "simulation" ? "Local simulation" : "Local Ollama";
}
function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {statusLabels[status]}
    </span>
  );
}

function CommandView({ runs, onNew }: { runs: Run[]; onNew: () => void }) {
  const waiting = runs.filter((run) => run.status === "waiting_approval");
  const artifactCount = runs.filter((run) => run.artifact).length;
  return (
    <>
      <section className="command-hero">
        <div>
          <PageEyebrow>COMMAND / WORKSPACE OVERVIEW</PageEyebrow>
          <h1>
            Your business,
            <br />
            <span>in motion.</span>
          </h1>
          <p>
            One place to turn intent into action.
            <br className="desktop-break" /> A clear view of the work. You stay
            in control.
          </p>
          <button className="button button-primary" onClick={onNew}>
            <Icon name="plus" size={18} />
            New mission
            <Icon name="arrow" size={17} />
          </button>
        </div>
        <div
          className="execution-map"
          aria-label="Current workflow: brief, review, local artifact"
        >
          <div className="map-top">
            <span className="small-dot" />A DELIBERATE PATH FORWARD
            <span>01—03</span>
          </div>
          <div className="map-visual">
            <svg viewBox="0 0 360 120" fill="none" aria-hidden="true">
              <path
                className="map-grid"
                d="M0 30h360M0 60h360M0 90h360M60 0v120M120 0v120M180 0v120M240 0v120M300 0v120"
              />
              <path
                className="map-path-secondary"
                d="M0 97h50c30 0 30-37 60-37h140c30 0 30 37 60 37h50M0 23h50c30 0 30 37 60 37"
              />
              <path className="map-path" d="M0 60h360" />
              <circle cx="75" cy="60" r="15" className="map-node" />
              <circle cx="180" cy="60" r="21" className="map-node-active" />
              <circle cx="285" cy="60" r="15" className="map-node" />
              <path
                d="m69 60 4 4 8-8m102-3-9 9m0-9 9 9M280 60h10m-5-5v10"
                className="map-node-glyph"
              />
            </svg>
            <div className="map-labels">
              <span>
                <b>01</b> Brief
              </span>
              <span>
                <b>02</b> Review
              </span>
              <span>
                <b>03</b> Local artifact
              </span>
            </div>
          </div>
          <div className="map-bottom">
            <span className="simulation-badge">
              <span />
              HUMAN REVIEWED
            </span>
            <span>Simulation or local Ollama</span>
          </div>
        </div>
      </section>
      <section className="stats-strip" aria-label="Workspace run counts">
        <Stat
          label="Missions created"
          value={runs.length}
          detail="In this workspace"
          icon="runs"
        />
        <Stat
          label="Awaiting your review"
          value={waiting.length}
          detail={
            waiting.length
              ? "A decision moves work forward"
              : "Nothing waiting on you"
          }
          icon="check"
          accent={waiting.length > 0}
        />
        <Stat
          label="Artifacts saved"
          value={artifactCount}
          detail="Reviewed local results"
          icon="knowledge"
        />
      </section>
      {runs.length === 0 ? (
        <section className="first-mission-panel">
          <div className="first-mission-art" aria-hidden="true">
            <div className="art-ring ring-one" />
            <div className="art-ring ring-two" />
            <div className="art-center">
              <BrandMark size={52} />
            </div>
            <span className="art-axis axis-one" />
            <span className="art-axis axis-two" />
            <span className="art-corner corner-one" />
            <span className="art-corner corner-two" />
          </div>
          <div className="first-mission-copy">
            <div className="section-kicker">
              START WITH SOMETHING THAT MATTERS
            </div>
            <h2>Give Vuzmi its first mission.</h2>
            <p>
              Prepare our own release brief. Review the plan, make the decision,
              and keep a clear record of the result.
            </p>
            <div className="first-mission-actions">
              <button className="button button-primary" onClick={onNew}>
                Prepare a release brief
                <Icon name="arrow" size={18} />
              </button>
              <span>Local simulation. No services required.</span>
            </div>
          </div>
          <span className="panel-index">MISSION 001</span>
        </section>
      ) : (
        <>
          <section className="content-section">
            <div className="section-header">
              <div>
                <div className="section-kicker">THE NEXT MOVE</div>
                <h2>
                  Needs your review{" "}
                  <span className="inline-count">{waiting.length}</span>
                </h2>
              </div>
              <a className="text-link" href="#/approvals">
                All approvals
                <Icon name="arrow" size={16} />
              </a>
            </div>
            {waiting.length ? (
              <div className="approval-preview-list">
                {waiting.slice(0, 3).map((run) => (
                  <a
                    className="approval-preview"
                    href={runLink(run)}
                    key={run.id}
                  >
                    <span className="approval-preview-icon">
                      <Icon name="check" size={21} />
                    </span>
                    <div>
                      <span className="tiny-label">
                        {domainLabels[run.domain]} / SAVE LOCAL ARTIFACT
                      </span>
                      <h3>{run.title}</h3>
                      <p>The exact release brief is ready for your decision.</p>
                    </div>
                    <span className="button button-secondary button-small">
                      Review
                      <Icon name="arrow" size={16} />
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <div className="quiet-empty">
                <Icon name="check" size={21} />
                <span>No decisions waiting. Your next move is yours.</span>
              </div>
            )}
          </section>
          <section className="content-section">
            <div className="section-header">
              <div>
                <div className="section-kicker">THE WORK IN VIEW</div>
                <h2>Recent missions</h2>
              </div>
              <a className="text-link" href="#/runs">
                Run history
                <Icon name="arrow" size={16} />
              </a>
            </div>
            <RunList runs={latestRuns(runs).slice(0, 5)} />
          </section>
        </>
      )}
      <section className="business-path">
        <div>
          <span className="section-kicker">THE BIGGER PICTURE</span>
          <h2>
            One foundation.
            <br />
            Every next chapter.
          </h2>
        </div>
        <div className="business-path-steps">
          {(["build", "operate", "market", "sell"] as Domain[]).map(
            (item, index) => (
              <div
                className={index === 0 ? "path-step current" : "path-step"}
                key={item}
              >
                <div>
                  <Icon name={item} size={22} />
                  <span className="step-number">0{index + 1}</span>
                </div>
                <strong>{domainLabels[item]}</strong>
                <span>
                  {index === 0 ? "Start with a local plan" : "On the roadmap"}
                </span>
              </div>
            ),
          )}
        </div>
        <a
          className="foundation-link"
          style={{ display: "grid", minWidth: 44, minHeight: 44 }}
          href="#/roadmap/foundation"
          aria-label="Explore the platform foundation"
        >
          <Icon name="arrow" size={22} />
        </a>
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  detail,
  icon,
  accent = false,
}: {
  label: string;
  value: number;
  detail: string;
  icon: IconName;
  accent?: boolean;
}) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        <Icon name={icon} size={18} />
      </div>
      <strong>{String(value).padStart(2, "0")}</strong>
      <span className="stat-detail">{detail}</span>
    </div>
  );
}

function DomainFilters({
  value,
  onChange,
}: {
  value: Domain | "all";
  onChange: (domain: Domain | "all") => void;
}) {
  return (
    <div
      className="domain-filters"
      role="group"
      aria-label="Filter by business domain"
    >
      <button
        className={value === "all" ? "active" : ""}
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
      >
        All operations
      </button>
      {domains.map((domain) => (
        <button
          key={domain}
          className={value === domain ? "active" : ""}
          aria-pressed={value === domain}
          onClick={() => onChange(domain)}
        >
          <Icon name={domain} size={15} />
          {domainLabels[domain]}
        </button>
      ))}
    </div>
  );
}

function RunsView({
  runs,
  domain,
  onDomain,
  onNew,
}: {
  runs: Run[];
  domain: Domain | "all";
  onDomain: (value: Domain | "all") => void;
  onNew: () => void;
}) {
  const filtered = latestRuns(
    runs.filter((run) => domain === "all" || run.domain === domain),
  );
  return (
    <>
      <div className="standard-page-header">
        <div>
          <PageEyebrow>EXECUTION / RUN HISTORY</PageEyebrow>
          <h1>
            The work,
            <br />
            <span>in clear view.</span>
          </h1>
          <p>Every mission. Every decision. A record you can follow.</p>
        </div>
        <button className="button button-primary" onClick={onNew}>
          <Icon name="plus" size={18} />
          New mission
        </button>
      </div>
      <DomainFilters value={domain} onChange={onDomain} />
      <div className="section-header compact-header">
        <h2>
          Mission history{" "}
          <span className="inline-count">{filtered.length}</span>
        </h2>
        <span className="simulation-badge">
          <span />
          LOCAL-ONLY WORKSPACE
        </span>
      </div>
      {filtered.length ? (
        <RunList runs={filtered} />
      ) : (
        <EmptyState
          icon={domain === "all" ? "runs" : domain}
          title={
            domain === "all"
              ? "A clean slate. A clear next step."
              : `No ${domainLabels[domain].toLowerCase()} missions yet.`
          }
          description="Start a local mission and follow it from brief to reviewed artifact. Real runs will appear here."
          action={
            <button className="button button-primary" onClick={onNew}>
              <Icon name="plus" size={18} />
              Create a mission
            </button>
          }
        />
      )}
    </>
  );
}

function RunList({ runs }: { runs: Run[] }) {
  return (
    <div className="run-list">
      <div className="run-list-heading" aria-hidden="true">
        <span>MISSION</span>
        <span>DOMAIN</span>
        <span>STATUS</span>
        <span>CREATED</span>
        <span />
      </div>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <a className="run-row" href={runLink(run)}>
              <div className="run-title-cell">
                <span className={`run-domain-icon domain-${run.domain}`}>
                  <Icon name={run.domain} size={19} />
                </span>
                <div>
                  <strong>{run.title}</strong>
                  <span>
                    {run.artifact
                      ? "Local artifact saved"
                      : run.status === "waiting_approval"
                        ? "Review the exact proposed artifact"
                        : run.decision?.decision === "reject"
                          ? "Proposal rejected · no artifact saved"
                          : runNextStep(run)}{" "}
                    <span className="row-separator">·</span>{" "}
                    <code>{shortId(run.id)}</code>
                  </span>
                </div>
              </div>
              <span className="run-domain-label">
                {domainLabels[run.domain]}
              </span>
              <StatusBadge status={run.status} />
              <time dateTime={run.createdAt} title={dateTime(run.createdAt)}>
                {shortDate(run.createdAt)}
              </time>
              <Icon className="run-row-arrow" name="chevron" size={17} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovalsView({ runs }: { runs: Run[] }) {
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const pending = latestRuns(
    runs.filter((run) => run.status === "waiting_approval"),
  );
  const history = latestRuns(runs.filter((run) => Boolean(run.decision)));
  const visible = tab === "pending" ? pending : history;
  return (
    <>
      <div className="standard-page-header">
        <div>
          <PageEyebrow>AUTHORITY / HUMAN IN THE LOOP</PageEyebrow>
          <h1>
            Your decisions,
            <br />
            <span>in one place.</span>
          </h1>
          <p>
            See the exact action. Review the evidence. Decide what happens next.
          </p>
        </div>
        <span className="large-outline-icon">
          <Icon name="check" size={36} />
        </span>
      </div>
      <div className="approval-tabs" role="group" aria-label="Approval queue">
        <button
          className={tab === "pending" ? "active" : ""}
          aria-pressed={tab === "pending"}
          onClick={() => setTab("pending")}
        >
          Needs review<span>{pending.length}</span>
        </button>
        <button
          className={tab === "history" ? "active" : ""}
          aria-pressed={tab === "history"}
          onClick={() => setTab("history")}
        >
          Decision history<span>{history.length}</span>
        </button>
      </div>
      {visible.length ? (
        <RunList runs={visible} />
      ) : (
        <EmptyState
          icon="check"
          title={
            tab === "pending"
              ? "Nothing waiting on you."
              : "Your decisions will leave a trail."
          }
          description={
            tab === "pending"
              ? "New proposals will appear here when a mission needs your review. You remain in control of the next action."
              : "Approved and rejected proposals will appear here with their exact saved decision."
          }
          action={
            <a className="button button-secondary" href="#/runs">
              View runs
              <Icon name="arrow" size={17} />
            </a>
          }
        />
      )}
    </>
  );
}

function RunDetail({
  run,
  onUpdate,
  connected,
  storage,
  ownerId,
}: {
  run: Run;
  onUpdate: (run: Run) => void;
  connected: boolean;
  storage: WorkspaceSnapshot["workspace"]["storage"];
  ownerId: string | null;
}) {
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [editing, setEditing] = useState<DraftSession | null>(() => {
    const held = retainedDraft(ownerId);
    return held?.initialRun.id === run.id ? held : null;
  });
  const [revisionSaved, setRevisionSaved] = useState<string | null>(null);
  const proposal = run.proposal;
  const revisions = run.draftRevisions ?? [];
  const humanRevised = revisions.length > 0;
  const heldDraft = retainedDraft(ownerId);
  const editableBody =
    run.mode === "ollama" &&
    run.status === "waiting_approval" &&
    run.route.executed &&
    proposal &&
    revisions.length < 10
      ? extractDraftBody(
          proposal.content,
          run.evidence,
          humanRevised ? "human" : "model",
        )
      : undefined;
  const documentContent = run.artifact?.content ?? proposal?.content;
  const unresolvedCitations = [
    ...new Set(
      [...(documentContent ?? "").matchAll(/\[([SM][1-9][0-9]*)\]/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].filter(
    (citation) =>
      !run.evidence?.items.some((item) => item.citation === citation),
  );
  useEffect(() => {
    setError(null);
    setCopyState(null);
    const held = retainedDraft(ownerId);
    setEditing(held?.initialRun.id === run.id ? held : null);
    setRevisionSaved(null);
  }, [run.id]);
  const decide = async (decision: "approve" | "reject") => {
    if (!proposal || run.status !== "waiting_approval" || editing) return;
    setDeciding(decision);
    setError(null);
    try {
      onUpdate(
        await decideRun(run.id, {
          decision,
          fingerprint: proposal.fingerprint,
          revision: run.revision,
        }),
      );
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          onUpdate(await getRun(run.id));
        } catch {
          /* The visible decision error remains available. */
        }
      }
    } finally {
      setDeciding(null);
    }
  };
  const copy = async () => {
    if (documentContent === undefined) return;
    try {
      await navigator.clipboard.writeText(documentContent);
      setCopyState("Copied to clipboard");
    } catch {
      setCopyState("Clipboard unavailable. Use Download to save the document.");
    }
  };
  const download = () => {
    if (documentContent === undefined) return;
    const blob = new Blob([documentContent], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `vuzmi-${
      run.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 70) || "mission"
    }.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const approved = Boolean(run.artifact);
  const rejected = run.decision?.decision === "reject";
  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <a href="#/runs">Runs</a>
        <Icon name="chevron" size={12} />
        <span>{shortId(run.id)}</span>
      </nav>
      <div className="run-detail-header">
        <div>
          <div className="detail-status-line">
            <StatusBadge status={run.status} />
            <ModeBadge run={run} />
            {humanRevised && (
              <span className="draft-human-badge">
                Human-revised · {revisions.length}
              </span>
            )}
          </div>
          <h1>{run.title}</h1>
          <p>
            <span>{domainLabels[run.domain]}</span>
            <span className="metadata-dot">·</span>
            <time dateTime={run.createdAt}>{dateTime(run.createdAt)}</time>
            <span className="metadata-dot">·</span>Private workspace
          </p>
        </div>
      </div>
      <div className="run-detail-grid">
        <div className="run-main-column">
          {(run.knowledge || run.evidence) && (
            <EvidencePanel
              evidence={run.evidence}
              requested={Boolean(run.knowledge)}
              prefix={run.id}
              unresolved={unresolvedCitations}
            />
          )}
          {heldDraft && heldDraft.initialRun.id !== run.id && (
            <p className="draft-review-held">
              An editing session is held in memory in this tab.{" "}
              <a href={runLink(heldDraft.initialRun)}>
                Return to that correction
              </a>{" "}
              before starting another.
            </p>
          )}
          {revisionSaved && (
            <p className="draft-saved-feedback" role="status">
              {revisionSaved}
            </p>
          )}
          {editing ? (
            <Suspense
              fallback={<p role="status">Opening the local draft editor…</p>}
            >
              <DraftEditor
                key={editing.id}
                session={editing}
                currentRun={run}
                connected={connected}
                onObserved={onUpdate}
                onSaved={(saved) => {
                  setEditing(null);
                  onUpdate(saved);
                  setRevisionSaved(
                    `Human revision saved at run revision ${saved.revision}. Review the exact saved document before approving.`,
                  );
                  window.requestAnimationFrame(() => {
                    const preview = document.getElementById("artifact-preview");
                    preview?.focus({ preventScroll: true });
                    preview?.scrollIntoView({ block: "start" });
                  });
                }}
                onClose={() => {
                  setEditing(null);
                }}
              />
            </Suspense>
          ) : documentContent !== undefined ? (
            <section className="artifact-panel">
              <div className="artifact-toolbar">
                <div>
                  <Icon name="knowledge" size={18} />
                  <span>
                    {approved
                      ? "Saved local artifact"
                      : rejected
                        ? "Rejected proposal"
                        : "Artifact for review"}
                  </span>
                  <span className="revision-label">
                    REV {run.decision?.revision ?? run.revision}
                  </span>
                </div>
                <div>
                  <button
                    className="icon-button"
                    aria-label={
                      approved ? "Copy saved artifact" : "Copy draft artifact"
                    }
                    title="Copy document"
                    onClick={() => {
                      void copy();
                    }}
                  >
                    <Icon name="copy" size={17} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={
                      approved
                        ? "Download saved artifact"
                        : "Download draft artifact"
                    }
                    title="Download Markdown"
                    onClick={download}
                  >
                    <Icon name="download" size={17} />
                  </button>
                </div>
              </div>
              {copyState && (
                <p className="copy-feedback" role="status">
                  {copyState}
                </p>
              )}
              {run.mode === "ollama" && (
                <div className="provider-output-notice">
                  <Icon name="alert" size={17} />
                  <p>
                    {humanRevised
                      ? "Human-revised draft. Review every factual claim. The original model output is retained in revision history."
                      : "Unverified local model output. Review every factual claim."}
                    {run.evidence?.status === "matched"
                      ? " Recorded evidence was retrieved; citations still require your review."
                      : " No retrieval was used."}{" "}
                    No repository inspection or tools were run.
                  </p>
                </div>
              )}
              <div
                id="artifact-preview"
                className="document-preview"
                tabIndex={-1}
              >
                <Suspense
                  fallback={<p role="status">Opening the exact document…</p>}
                >
                  <ArtifactDocument
                    content={documentContent}
                    evidence={run.evidence}
                    prefix={run.id}
                  />
                </Suspense>
              </div>
              <div className="artifact-bottom">
                <span className="small-dot" />
                {approved && run.artifact
                  ? `Saved ${dateTime(run.artifact.savedAt)}`
                  : run.mode === "simulation"
                    ? "Deterministic local template · No model call"
                    : humanRevised
                      ? "Human-revised draft · Awaiting review"
                      : "Local Ollama draft · Awaiting review"}
                <span>MARKDOWN</span>
              </div>
            </section>
          ) : (
            <GenerationProgress run={run} />
          )}
          {revisions.length > 0 && (
            <section
              className="draft-revision-history"
              aria-labelledby="draft-history-title"
            >
              <div className="section-header">
                <div>
                  <div className="section-kicker">RETAINED PRIVATE HISTORY</div>
                  <h2 id="draft-history-title">
                    Draft revisions{" "}
                    <span className="inline-count">{revisions.length}</span>
                  </h2>
                </div>
              </div>
              <p>
                Prior full documents, correction reasons, and owner attribution
                remain retained. Human revisions do not represent another model
                call.
              </p>
              {[...revisions].reverse().map((revision) => (
                <details key={revision.editId}>
                  <summary>
                    <span>
                      Run revision {revision.fromRevision} →{" "}
                      {revision.toRevision}
                    </span>
                    <span>{dateTime(revision.occurredAt)}</span>
                  </summary>
                  <dl>
                    <div>
                      <dt>Revised by</dt>
                      <dd>
                        {revision.actorName ??
                          (revision.actor === "local-operator"
                            ? "local operator"
                            : "workspace owner")}
                      </dd>
                    </div>
                    <div>
                      <dt>Reason</dt>
                      <dd>{revision.reason}</dd>
                    </div>
                    <div>
                      <dt>Ledger event</dt>
                      <dd>{revision.eventSequence}</dd>
                    </div>
                  </dl>
                  <details className="draft-prior-record">
                    <summary>Read exact prior full document</summary>
                    <pre tabIndex={0}>{revision.previousProposal.content}</pre>
                  </details>
                  <span className="tiny-label">PRIOR PROPOSAL FINGERPRINT</span>
                  <code className="fingerprint">
                    {revision.previousProposal.fingerprint}
                  </code>
                  <span className="tiny-label">
                    REVISED PROPOSAL FINGERPRINT
                  </span>
                  <code className="fingerprint">
                    {revision.nextFingerprint}
                  </code>
                </details>
              ))}
            </section>
          )}
          <details className="workflow-panel">
            <summary>
              {getRunWorkflowLabel(run)}
              <span>Inspect workflow steps</span>
            </summary>
            <ol>
              {deriveRunSteps(run).map((step, index) => (
                <li key={step.id} data-status={step.status}>
                  <span className="workflow-stage-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <div className="workflow-stage-title">
                      <strong>{step.label}</strong>
                      <span>{step.status.replaceAll("_", " ")}</span>
                    </div>
                    <p>{step.detail}</p>
                    {step.eventSequences.length > 0 && (
                      <small>
                        Ledger{" "}
                        {step.eventSequences.length === 1 ? "event" : "events"}{" "}
                        {step.eventSequences.join(", ")}
                      </small>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </details>
          <section className="timeline-section">
            <div className="section-header">
              <div>
                <div className="section-kicker">A RECORD YOU CAN FOLLOW</div>
                <h2>
                  Execution trail{" "}
                  <span className="inline-count">{run.events.length}</span>
                </h2>
              </div>
            </div>
            <ol className="timeline">
              {[...run.events]
                .sort((a, b) => a.sequence - b.sequence)
                .map((event) => (
                  <li key={event.sequence}>
                    <span
                      className={`timeline-point ${event.type === "artifact.saved" ? "timeline-point-completed" : ""}`}
                    >
                      <Icon
                        name={
                          event.type.includes("approval")
                            ? "check"
                            : event.type === "artifact.saved"
                              ? "knowledge"
                              : "clock"
                        }
                        size={14}
                      />
                    </span>
                    <div>
                      <div className="timeline-event-header">
                        <strong>
                          {event.type
                            .split(".")
                            .map(
                              (part) =>
                                part.charAt(0).toUpperCase() +
                                part.slice(1).replace(/_/g, " "),
                            )
                            .join(" · ")}
                        </strong>
                        <time
                          dateTime={event.occurredAt}
                          title={dateTime(event.occurredAt)}
                        >
                          {new Intl.DateTimeFormat("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          }).format(new Date(event.occurredAt))}
                        </time>
                      </div>
                      <p>{event.message}</p>
                    </div>
                  </li>
                ))}
            </ol>
          </section>
        </div>
        <aside className="run-inspector" aria-label="Run review and details">
          <section
            className={`review-panel ${approved ? "review-completed" : rejected ? "review-rejected" : ""}`}
          >
            <div className="review-panel-symbol">
              <Icon
                name={
                  run.status === "failed"
                    ? "alert"
                    : rejected
                      ? "close"
                      : proposal
                        ? "check"
                        : "clock"
                }
                size={24}
              />
            </div>
            <div className="section-kicker">
              {approved
                ? "DECISION RECORDED"
                : rejected
                  ? "REVIEW CLOSED"
                  : proposal
                    ? "YOUR DECISION"
                    : "EXECUTION STATUS"}
            </div>
            <h2>
              {approved
                ? "A clear result."
                : rejected
                  ? "Proposal rejected."
                  : proposal
                    ? "Ready for your review."
                    : run.status === "failed"
                      ? "Generation stopped."
                      : run.status === "running"
                        ? "Work is in progress."
                        : "Waiting for the worker."}
            </h2>
            <p>
              {approved
                ? "This exact document is saved in your local artifact library."
                : rejected
                  ? "Your decision is recorded. No artifact was saved by this run."
                  : proposal
                    ? "Approve this exact release brief to save it in the local artifact library."
                    : run.status === "failed"
                      ? "No draft is ready for review. The recorded failure appears in the execution trail."
                      : "A reviewable document will appear only after local generation completes."}
            </p>
            {proposal && (
              <div className="review-action-scope">
                <span>PROPOSED ACTION</span>
                <strong>Save local artifact</strong>
                <p>No deployment, publication, or external message.</p>
              </div>
            )}
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            {run.status === "waiting_approval" && proposal && (
              <div className="review-buttons">
                {!editing && (
                  <>
                    <button
                      className="button button-secondary"
                      onClick={() => {
                        const preview =
                          document.getElementById("artifact-preview");
                        preview?.focus({ preventScroll: true });
                        preview?.scrollIntoView({ block: "start" });
                      }}
                    >
                      <Icon name="knowledge" size={17} />
                      Read exact document
                    </button>
                    <button
                      className="button button-primary"
                      disabled={
                        Boolean(deciding) || !connected || Boolean(editing)
                      }
                      onClick={() => {
                        void decide("approve");
                      }}
                    >
                      <Icon
                        name={deciding === "approve" ? "refresh" : "check"}
                        size={17}
                        className={deciding === "approve" ? "spinning" : ""}
                      />
                      {deciding === "approve"
                        ? "Saving local result…"
                        : "Approve local result"}
                    </button>
                    <button
                      className="button button-quiet"
                      disabled={
                        Boolean(deciding) || !connected || Boolean(editing)
                      }
                      onClick={() => {
                        void decide("reject");
                      }}
                    >
                      {deciding === "reject"
                        ? "Recording rejection…"
                        : "Reject proposal"}
                    </button>
                    {editableBody !== undefined && !editing && (
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={Boolean(deciding) || !connected}
                        onClick={() => {
                          const next = openDraftSession(
                            ownerId,
                            run,
                            editableBody,
                          );
                          if (!next) {
                            setError(
                              "Another unsaved correction is held in this tab. Return to that run and save or explicitly discard it before opening another editor.",
                            );
                            return;
                          }
                          setEditing(next);
                          setRevisionSaved(null);
                          setError(null);
                          window.requestAnimationFrame(() =>
                            document
                              .getElementById("draft-editor-title")
                              ?.scrollIntoView({ block: "start" }),
                          );
                        }}
                      >
                        Revise draft
                      </button>
                    )}
                  </>
                )}
                {editing && (
                  <p className="draft-review-held" role="status">
                    Editing session open. Save the revised draft or explicitly
                    discard this session before approving or rejecting.
                  </p>
                )}
                {!editing &&
                  run.mode === "ollama" &&
                  editableBody === undefined && (
                    <p className="decision-offline">
                      {revisions.length >= 10
                        ? "This run has reached its ten-revision limit. Create another mission to continue drafting."
                        : "This saved document format cannot be safely edited. It remains available for exact review."}
                    </p>
                  )}
                {!connected && (
                  <p className="decision-offline">
                    Reconnect to record a decision.
                  </p>
                )}
              </div>
            )}
            {run.decision && (
              <div className="recorded-decision">
                <Icon name={approved ? "check" : "close"} size={15} />
                <span>
                  {approved ? "Approved" : "Rejected"} by{" "}
                  {run.decision.actorName ??
                    (run.decision.actor === "local-operator"
                      ? "local operator"
                      : "workspace owner")}
                  <br />
                  <time dateTime={run.decision.decidedAt}>
                    {dateTime(run.decision.decidedAt)}
                  </time>
                </span>
              </div>
            )}
          </section>
          {run.artifact && (
            <a className="button button-secondary" href="#/outbox">
              <Icon name="download" size={16} />
              Open approved package
            </a>
          )}
          <section className="facts-panel">
            <div className="section-kicker">EXECUTION CONTEXT</div>
            <dl>
              <div>
                <dt>Workflow</dt>
                <dd>
                  {run.workflow
                    ? `Founder release · v${run.workflow.version}`
                    : "Legacy · version unknown"}
                </dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>
                  {run.mode === "simulation"
                    ? "Local simulation"
                    : "Local Ollama"}
                </dd>
              </div>
              <div>
                <dt>Data policy</dt>
                <dd>
                  <Icon name="shield" size={13} />
                  Local only
                </dd>
              </div>
              <div>
                <dt>Executor</dt>
                <dd>
                  {run.mode === "simulation"
                    ? "Deterministic template"
                    : "Local worker"}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  {run.mode === "simulation"
                    ? "No provider call"
                    : (run.route.model ?? "Not selected")}
                </dd>
              </div>
              {run.mode === "ollama" && (
                <div>
                  <dt>Generation result</dt>
                  <dd>
                    {run.route.executed
                      ? "Provider output recorded"
                      : "No output recorded"}
                  </dd>
                </div>
              )}
              <div>
                <dt>Storage</dt>
                <dd>{storage === "postgres" ? "PostgreSQL" : "Local file"}</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>
                  {run.evidence
                    ? run.evidence.status === "matched"
                      ? `${run.evidence.items.length} retained excerpts`
                      : "Insufficient"
                    : run.knowledge
                      ? "Required · pending"
                      : "Not requested"}
                </dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>{proposal?.destination ?? "No proposal yet"}</dd>
              </div>
              {run.usage && (
                <>
                  <div>
                    <dt>Input tokens</dt>
                    <dd>{recordedNumber(run.usage.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Output tokens</dt>
                    <dd>{recordedNumber(run.usage.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Provider duration</dt>
                    <dd>
                      {run.usage.durationMs === null
                        ? "Not recorded"
                        : `${(run.usage.durationMs / 1000).toLocaleString("en-GB", { maximumFractionDigits: 2 })}s`}
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {humanRevised && (
              <p className="draft-usage-note">
                Recorded token usage and provider duration describe the original
                model call. Human edits made no new provider request.
              </p>
            )}
            <details className="route-details">
              <summary>
                Routing & approval record
                <Icon name="chevron" size={13} />
              </summary>
              <p>{run.route.reason}</p>
              {proposal && (
                <>
                  <span className="tiny-label">PROPOSAL FINGERPRINT</span>
                  <code className="fingerprint">{proposal.fingerprint}</code>
                </>
              )}
              <span className="tiny-label">RUN ID</span>
              <code className="fingerprint">{run.id}</code>
              {run.attemptId && (
                <>
                  <span className="tiny-label">ATTEMPT ID</span>
                  <code className="fingerprint">{run.attemptId}</code>
                </>
              )}
            </details>
          </section>
          <details className="brief-details">
            <summary>
              Original mission brief
              <Icon name="chevron" size={14} />
            </summary>
            <p>{run.brief}</p>
          </details>
        </aside>
      </div>
    </>
  );
}

function GenerationProgress({ run }: { run: Run }) {
  const failed = run.status === "failed";
  return (
    <section
      className={`generation-state ${failed ? "generation-failed" : ""}`}
    >
      <span className="empty-state-icon">
        <Icon
          name={
            failed ? "alert" : run.status === "running" ? "operate" : "clock"
          }
          size={28}
        />
      </span>
      <div className="section-kicker">
        {failed ? "RECORDED FAILURE" : "LOCAL EXECUTION"}
      </div>
      <h2>
        {failed
          ? "No draft was produced."
          : run.status === "running"
            ? "Your mission is running."
            : "Your mission is queued."}
      </h2>
      <p>
        {failed
          ? "Generation stopped before a proposal was ready. No artifact was saved."
          : run.status === "running"
            ? run.knowledge && !run.evidence
              ? "The worker is preparing required evidence. No model output has been recorded."
              : run.evidence?.status === "insufficient"
                ? "Required evidence was insufficient. A draft cannot be produced without the required context."
                : "Local execution is in progress. A complete draft will appear only after the provider returns a usable result."
            : "Waiting for the local worker. No model output exists yet."}
      </p>
      {run.error && (
        <div className="inline-error">
          <strong>{run.error.code}</strong>
          <p>{run.error.message}</p>
          {run.status === "queued" && (
            <p>A bounded retry is queued. Cloud fallback is disabled.</p>
          )}
        </div>
      )}
      <div className="generation-last-event">
        <Icon name="clock" size={15} />
        <span>
          {run.events.at(-1)?.message ?? "No execution event recorded."}
        </span>
      </div>
      <time dateTime={run.updatedAt}>
        Last recorded update {dateTime(run.updatedAt)}
      </time>
    </section>
  );
}

function NewMissionDialog({
  initialDomain,
  runtime,
  runtimeError,
  knowledge,
  knowledgeError,
  onClose,
  onCreated,
}: {
  initialDomain: Domain;
  runtime: RuntimeInfo | null;
  runtimeError: string | null;
  knowledge: KnowledgeSnapshot | null;
  knowledgeError: string | null;
  onClose: () => void;
  onCreated: (run: Run) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState<CreateRunInput>({
    title: "Prepare Vuzmi’s release brief",
    brief: defaultBrief,
    domain: initialDomain,
    mode: "simulation",
  });
  const [model, setModel] = useState("");
  const [requireEvidence, setRequireEvidence] = useState(false);
  const [evidenceSelection, setEvidenceSelection] = useState<EvidenceSelection>(
    { sourceIds: [], memoryIds: [] },
  );
  const blockReason = runtimeBlockReason(runtime, runtimeError);
  const liveMode = input.mode === "ollama";
  const selectedModelAvailable = Boolean(
    runtime?.ollama.models.some((item) => item.name === model),
  );
  useEffect(() => {
    if (model || !runtime?.ollama.models.length) return;
    const configured = runtime.ollama.models.find(
      (item) => item.name === runtime.ollama.configuredModel,
    );
    setModel(configured?.name ?? runtime.ollama.models[0]!.name);
  }, [runtime, model]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      liveMode &&
      requireEvidence &&
      (knowledgeError ||
        !validSelection(knowledge, evidenceSelection) ||
        evidenceSelection.sourceIds.length +
          evidenceSelection.memoryIds.length ===
          0)
    ) {
      setError(
        knowledgeError
          ? "Knowledge readiness could not be verified. Refresh Knowledge before requiring evidence."
          : "Choose at least one ready source or unexpired confirmed memory. Unavailable evidence cannot be silently omitted.",
      );
      return;
    }
    if (liveMode && (blockReason || !selectedModelAvailable)) {
      setError(
        blockReason ??
          "Select an installed model before starting local generation.",
      );
      return;
    }
    const parsed = createRunSchema.safeParse({
      ...input,
      ...(liveMode ? { model } : {}),
      ...(liveMode && requireEvidence ? { knowledge: evidenceSelection } : {}),
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(" "),
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      onCreated(await createRun(parsed.data));
    } catch (caught) {
      setError(errorMessage(caught));
      setSubmitting(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="mission-dialog"
      aria-labelledby="mission-dialog-title"
      aria-describedby="mission-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <div className="dialog-heading-icon">
            <BrandMark size={28} />
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close new mission"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        <PageEyebrow>FROM INTENT TO ACTION</PageEyebrow>
        <h2 id="mission-dialog-title">Give the work a direction.</h2>
        <p id="mission-dialog-description" className="dialog-description">
          Start with a brief. Review the exact result before it becomes a local
          artifact.
        </p>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <div className="field-label-row execution-mode-label">
            <label className="field-label" htmlFor="mission-mode">
              Execution mode
            </label>
            <a
              href="#/roadmap/models"
              aria-disabled={submitting}
              onClick={(event) => {
                if (submitting) event.preventDefault();
                else onClose();
              }}
            >
              Model control
            </a>
          </div>
          <select
            id="mission-mode"
            value={input.mode ?? "simulation"}
            disabled={submitting}
            onChange={(event) => {
              setInput({
                ...input,
                mode: event.target.value === "ollama" ? "ollama" : "simulation",
              });
              setError(null);
            }}
          >
            <option value="simulation">
              Simulation — deterministic local template
            </option>
            <option value="ollama" disabled={Boolean(blockReason)}>
              Local Ollama
              {blockReason ? " — unavailable" : " — model generation"}
            </option>
          </select>
          {blockReason && <p className="mode-readiness">{blockReason}</p>}
          {liveMode && (
            <>
              <div className="field-label-row">
                <label className="field-label" htmlFor="mission-model">
                  Installed model
                </label>
                <span>Local-only · No cloud fallback</span>
              </div>
              <select
                id="mission-model"
                value={model}
                disabled={submitting || Boolean(blockReason)}
                required
                onChange={(event) => setModel(event.target.value)}
              >
                {!selectedModelAvailable && (
                  <option value={model}>
                    {model
                      ? `${model} — no longer available`
                      : "Select an installed model"}
                  </option>
                )}
                {runtime?.ollama.models.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <label className="field-label" htmlFor="mission-title">
            Mission title
          </label>
          <input
            id="mission-title"
            autoFocus
            required
            minLength={3}
            maxLength={120}
            value={input.title}
            onChange={(event) =>
              setInput({ ...input, title: event.target.value })
            }
            disabled={submitting}
          />
          <div className="field-label-row">
            <label className="field-label" htmlFor="mission-domain">
              Business domain
            </label>
            <span>One shared execution system</span>
          </div>
          <select
            id="mission-domain"
            value={input.domain}
            disabled={submitting}
            onChange={(event) =>
              setInput({
                ...input,
                domain: domainSchema.parse(event.target.value),
              })
            }
          >
            {domains.map((domain) => (
              <option key={domain} value={domain}>
                {domainLabels[domain]}
              </option>
            ))}
          </select>
          <div className="field-label-row">
            <label className="field-label" htmlFor="mission-brief">
              The brief
            </label>
            <span>Be specific about the outcome</span>
          </div>
          <textarea
            id="mission-brief"
            rows={5}
            minLength={10}
            maxLength={6000}
            required
            value={input.brief}
            disabled={submitting}
            onChange={(event) =>
              setInput({ ...input, brief: event.target.value })
            }
          />
          {liveMode && (
            <section className="mission-knowledge">
              <label className="require-evidence-toggle">
                <input
                  type="checkbox"
                  checked={requireEvidence}
                  disabled={
                    submitting ||
                    (!requireEvidence &&
                      (!knowledge || Boolean(knowledgeError)))
                  }
                  onChange={(event) => setRequireEvidence(event.target.checked)}
                />
                <span>
                  <strong>Require workspace evidence</strong>
                  <small>
                    No retrieval is the default. Selected sources and memories
                    become a required context boundary.
                  </small>
                </span>
              </label>
              {knowledgeError && (
                <p className="knowledge-hint">
                  Knowledge could not be refreshed. Open Knowledge to check
                  readiness.
                </p>
              )}
              {requireEvidence && knowledge && (
                <EvidencePicker
                  snapshot={knowledge}
                  selection={evidenceSelection}
                  disabled={submitting}
                  onChange={setEvidenceSelection}
                />
              )}
              <a
                className="text-link"
                href="#/roadmap/knowledge"
                aria-disabled={submitting}
                onClick={(event) => {
                  if (submitting) event.preventDefault();
                  else onClose();
                }}
              >
                Open Knowledge & memory
                <Icon name="arrow" size={15} />
              </a>
            </section>
          )}
          <div className="mission-mode">
            <div>
              {liveMode ? (
                <span className="simulation-badge">
                  <span />
                  LOCAL OLLAMA
                </span>
              ) : (
                <SimulationBadge />
              )}
              <span className="review-required">
                <Icon name="check" size={13} />
                Review required
              </span>
            </div>
            <p>
              {liveMode
                ? requireEvidence
                  ? "Selected workspace evidence is required before local generation. Missing or insufficient evidence stops the mission. Generated claims still need review; no repository inspection, tools, deployment, or messages."
                  : "Your brief is sent to the selected local Ollama model. Its output is unverified and requires review. No retrieval, repository inspection, tools, deployment, or messages."
                : "A deterministic template prepares a local release brief. No model calls, repository inspection, command execution, deployment, or messages."}
            </p>
          </div>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-footer">
            <button
              type="button"
              className="button button-quiet"
              disabled={submitting}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button-primary"
              disabled={
                submitting ||
                (liveMode && (Boolean(blockReason) || !selectedModelAvailable))
              }
            >
              <Icon
                name={submitting ? "refresh" : "arrow"}
                className={submitting ? "spinning" : ""}
                size={18}
              />
              {submitting ? "Creating local run…" : "Start local run"}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

const roadmapContent: Record<
  string,
  {
    eyebrow: string;
    title: string;
    accent: string;
    description: string;
    icon: IconName;
    features: {
      title: string;
      description: string;
      icon: IconName;
      href?: string;
    }[];
  }
> = {
  models: {
    eyebrow: "FOUNDATION / MODEL CONTROL",
    title: "The right model.",
    accent: "A visible decision.",
    description:
      "Ollama, OpenAI, and Claude will share one policy layer. Locality, capabilities, and budget come before a route is chosen.",
    icon: "models",
    features: [
      {
        title: "Local-first routing",
        description:
          "Hard locality constraints and explicit fallback rules. No silent move from local data to a cloud provider.",
        icon: "shield",
      },
      {
        title: "A traceable choice",
        description:
          "Inspect the chosen model, excluded candidates, policy, and recorded reason for each route.",
        icon: "models",
      },
      {
        title: "Honest usage",
        description:
          "Keep observed tokens, estimated cost, and missing information distinct.",
        icon: "operate",
      },
    ],
  },
  knowledge: {
    eyebrow: "FOUNDATION / KNOWLEDGE & MEMORY",
    title: "Context that lasts.",
    accent: "Evidence that matters.",
    description:
      "Versioned sources and explicit memory will give agents useful context without turning every conversation into an unquestioned fact.",
    icon: "knowledge",
    features: [
      {
        title: "Grounded knowledge",
        description:
          "Retrieve permitted passages and preserve their source revisions as real citations.",
        icon: "knowledge",
      },
      {
        title: "Curated memory",
        description:
          "Inspect, confirm, correct, expire, and delete retained facts within a defined scope.",
        icon: "agents",
      },
      {
        title: "A clear lifecycle",
        description:
          "Understand ingestion, indexing, changes, and deletion rather than treating knowledge as a black box.",
        icon: "runs",
      },
    ],
  },
  agents: {
    eyebrow: "FOUNDATION / AGENTS & AUTOMATIONS",
    title: "Specialist agents.",
    accent: "Shared accountability.",
    description:
      "Reusable roles and versioned recipes will coordinate the business through the same runs, permissions, evidence, and approvals.",
    icon: "agents",
    features: [
      {
        title: "Bounded roles",
        description:
          "Give each agent a purpose, model policy, explicit tools, and a narrow permission scope.",
        icon: "agents",
      },
      {
        title: "Readable recipes",
        description:
          "Follow the path from trigger to draft, review, authorised action, and verified result.",
        icon: "runs",
      },
      {
        title: "Your authority",
        description:
          "Review the exact effect before an agent sends, publishes, spends, or deploys.",
        icon: "check",
      },
    ],
  },
  foundation: {
    eyebrow: "PLATFORM / THE FOUNDATION",
    title: "One connected business.",
    accent: "Built deliberately.",
    description:
      "A common execution system will bring development, operations, support, marketing, and sales into one workspace.",
    icon: "command",
    features: [
      {
        title: "Agents & automations",
        description:
          "Versioned recipes and scoped roles, with one shared execution trail.",
        icon: "agents",
      },
      {
        title: "Knowledge & memory",
        description:
          "Manage local sources, test retrieved passages, and curate confirmed workspace memory. Connector sync and automatic memory remain planned.",
        icon: "knowledge",
        href: "#/roadmap/knowledge",
      },
      {
        title: "Model control",
        description:
          "Inspect installed Ollama models, worker readiness, and local routing. OpenAI and Claude adapters remain planned.",
        icon: "models",
        href: "#/roadmap/models",
      },
    ],
  },
};

function RoadmapView({ section }: { section: string }) {
  const content = roadmapContent[section] ?? roadmapContent.foundation!;
  return (
    <>
      <div className="standard-page-header roadmap-header">
        <div>
          <PageEyebrow>{content.eyebrow}</PageEyebrow>
          <h1>
            {content.title}
            <br />
            <span>{content.accent}</span>
          </h1>
          <p>{content.description}</p>
        </div>
        <span className="large-outline-icon">
          <Icon name={content.icon} size={40} />
        </span>
      </div>
      <div className="roadmap-notice">
        <span className="planned-badge">
          {section === "foundation" ? "PLATFORM IN PROGRESS" : "ON THE ROADMAP"}
        </span>
        <p>
          {section === "foundation"
            ? "The foundation combines local execution and curated knowledge with planned agents, connectors, and cloud providers."
            : "This area describes planned capabilities."}{" "}
          The current slice supports local simulation and configured local
          Ollama generation, ending in reviewed local artifacts.
        </p>
      </div>
      <div className="roadmap-cards">
        {content.features.map((feature, index) => (
          <section className="roadmap-card" key={feature.title}>
            <div className="roadmap-card-top">
              <Icon name={feature.icon} size={25} />
              <span>0{index + 1}</span>
            </div>
            <h2>{feature.title}</h2>
            <p>{feature.description}</p>
            {feature.href ? (
              <a className="text-link" href={feature.href}>
                Open {feature.title}
                <Icon name="arrow" size={16} />
              </a>
            ) : (
              <span className="planned-badge">Planned</span>
            )}
          </section>
        ))}
      </div>
      <section className="current-foundation">
        <div className="available-icon">
          <Icon name="check" size={22} />
        </div>
        <div>
          <span className="section-kicker">AVAILABLE IN THIS SLICE</span>
          <h2>Intent → review → local result.</h2>
          <p>
            Create a simulation or explicitly choose an available local Ollama
            model, review the exact proposal, and save a local artifact with a
            recorded decision.
          </p>
        </div>
        <a className="button button-secondary" href="#/">
          Open Command
          <Icon name="arrow" size={17} />
        </a>
      </section>
    </>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      <span className="empty-state-icon">
        <Icon name={icon} size={28} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}

function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <span className="loading-logo">
        <BrandMark size={38} />
      </span>
      <h1>Opening your workspace.</h1>
      <p>Connecting to the local backend…</p>
      <span className="loading-line" />
    </div>
  );
}
