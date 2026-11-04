import type { RuntimeInfo } from "@vuzmi/core";
import { Icon } from "./icons";
import { runtimeBlockReason } from "./runtime";

function timestamp(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function RuntimeView({
  runtime,
  error,
  loading,
  onRefresh,
}: {
  runtime: RuntimeInfo | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const reason = runtimeBlockReason(runtime, error);
  const ready = !reason;
  return (
    <>
      <div className="standard-page-header runtime-header">
        <div>
          <div className="page-eyebrow">
            <span className="eyebrow-line" />
            RUNTIME / MODEL CONTROL
          </div>
          <h1>
            Local models.
            <br />
            <span>A visible runtime.</span>
          </h1>
          <p>
            Installed models, worker readiness, and the storage behind your
            runs. These are observations from your backend.
          </p>
        </div>
        <button
          className="button button-secondary"
          onClick={onRefresh}
          disabled={loading}
        >
          <Icon
            name="refresh"
            size={17}
            className={loading ? "spinning" : ""}
          />
          {loading ? "Checking runtime…" : "Refresh runtime"}
        </button>
      </div>
      {error && (
        <div className="connection-notice" role="status">
          <Icon name="alert" size={18} />
          <div>
            <strong>Runtime state could not be refreshed</strong>
            <p>
              {error} Saved runs remain available.{" "}
              {runtime
                ? `Showing observations from ${timestamp(runtime.checkedAt)}.`
                : "Local generation is unavailable until readiness is verified."}
            </p>
          </div>
        </div>
      )}
      {!runtime ? (
        <section className="empty-state">
          <span className="empty-state-icon">
            <Icon name={loading ? "refresh" : "models"} size={28} />
          </span>
          <h2>
            {loading
              ? "Checking the local runtime."
              : "Runtime readiness is unavailable."}
          </h2>
          <p>
            {loading
              ? "Reading the backend’s observed storage, worker, and installed model state."
              : "Refresh runtime to check the configured backend. Simulation can still be used when the workspace is connected."}
          </p>
        </section>
      ) : (
        <>
          <section
            className={`runtime-readiness ${ready ? "runtime-ready" : ""}`}
          >
            <span className="available-icon">
              <Icon name={ready ? "check" : "alert"} size={23} />
            </span>
            <div>
              <div className="section-kicker">
                {ready
                  ? "LOCAL GENERATION AVAILABLE"
                  : "LOCAL GENERATION UNAVAILABLE"}
              </div>
              <h2>
                {ready
                  ? "Ready for an explicit local model run."
                  : "The next run needs its foundations."}
              </h2>
              <p>
                {reason ??
                  "Choose Local Ollama and an installed model when creating a mission. Simulation remains the default; no cloud fallback is enabled."}
              </p>
            </div>
          </section>
          <section
            className="runtime-facts"
            aria-label="Observed runtime state"
          >
            <div>
              <Icon name="knowledge" size={21} />
              <span>Run storage</span>
              <strong>
                {runtime.storage === "postgres" ? "PostgreSQL" : "Local file"}
              </strong>
              <p>
                {runtime.storage === "postgres"
                  ? "PostgreSQL-backed execution configured"
                  : "Simulation storage; live generation requires PostgreSQL"}
              </p>
            </div>
            <div>
              <Icon name="operate" size={21} />
              <span>Local worker</span>
              <strong>
                {runtime.worker.state === "ready"
                  ? "Ready"
                  : runtime.worker.state === "offline"
                    ? "Offline"
                    : "Not configured"}
              </strong>
              <p>
                {runtime.worker.lastSeenAt
                  ? `Last seen ${timestamp(runtime.worker.lastSeenAt)}`
                  : "No worker heartbeat recorded"}
              </p>
            </div>
            <div>
              <Icon name="models" size={21} />
              <span>Ollama connection</span>
              <strong>
                {runtime.ollama.reachable ? "Reachable" : "Unreachable"}
              </strong>
              <p>
                {runtime.ollama.error ??
                  (runtime.ollama.reachable
                    ? "The backend reached the configured local runtime"
                    : "No successful connection recorded")}
              </p>
            </div>
          </section>
          <div className="section-header">
            <div>
              <div className="section-kicker">DISCOVERED ON YOUR RUNTIME</div>
              <h2>
                Installed models{" "}
                <span className="inline-count">
                  {runtime.ollama.models.length}
                </span>
              </h2>
            </div>
          </div>
          {runtime.ollama.models.length ? (
            <ul className="installed-model-list">
              {runtime.ollama.models.map((model) => (
                <li key={`${model.name}-${model.digest}`}>
                  <div className="installed-model-heading">
                    <span className="run-domain-icon">
                      <Icon name="models" size={21} />
                    </span>
                    <div>
                      <h3>{model.name}</h3>
                      <span>
                        {[
                          model.parameterSize,
                          model.quantization,
                          model.sizeBytes
                            ? `${(model.sizeBytes / 1024 ** 3).toLocaleString("en-GB", { maximumFractionDigits: 2 })} GiB on disk`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Model details not reported"}
                      </span>
                    </div>
                    {runtime.ollama.configuredModel === model.name && (
                      <span className="planned-badge">Configured default</span>
                    )}
                  </div>
                  <dl className="model-capabilities">
                    <div>
                      <dt>Reported capabilities</dt>
                      <dd>
                        {model.capabilities.length
                          ? model.capabilities.join(", ")
                          : "Not reported"}
                      </dd>
                    </div>
                    <div>
                      <dt>Context length</dt>
                      <dd>
                        {model.contextLength === null
                          ? "Not reported"
                          : `${model.contextLength.toLocaleString("en-GB")} tokens`}
                      </dd>
                    </div>
                  </dl>
                  <details className="route-details">
                    <summary>
                      Model identity
                      <Icon name="chevron" size={13} />
                    </summary>
                    <code className="fingerprint">
                      {model.digest || "Digest not reported"}
                    </code>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <section className="quiet-empty">
              <Icon name="models" size={21} />
              <span>
                {runtime.ollama.reachable
                  ? "No installed models were discovered. Manage model installation on your local Ollama runtime."
                  : "Installed models cannot be read while the configured Ollama runtime is unreachable."}
              </span>
            </section>
          )}
          <p className="runtime-checked">
            Observed {timestamp(runtime.checkedAt)} · Connection and capability
            reports do not prove output quality. No automatic downloads or cloud
            fallback.
          </p>
        </>
      )}
    </>
  );
}
