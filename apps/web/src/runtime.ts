import type { RuntimeInfo } from "@vuzmi/core";

export function runtimeBlockReason(
  runtime: RuntimeInfo | null,
  error: string | null,
): string | null {
  if (error)
    return "Runtime readiness could not be verified. Refresh Model control before starting local generation.";
  if (!runtime) return "Runtime readiness has not been checked yet.";
  if (runtime.storage !== "postgres")
    return "Local generation requires PostgreSQL-backed execution. Simulation remains available.";
  if (runtime.worker.state !== "ready")
    return runtime.worker.state === "not_configured"
      ? "The local worker is not configured."
      : "The local worker is offline. Waiting runs and saved artifacts remain available.";
  if (!runtime.ollama.reachable)
    return (
      runtime.ollama.error ?? "The configured Ollama runtime is unreachable."
    );
  if (!runtime.ollama.models.length)
    return "No installed local models were discovered. Install a model through the local runtime first.";
  return runtime.liveAvailable
    ? null
    : "The backend has not reported local generation as ready.";
}
