import {
  authStateSchema,
  decisionSchema,
  runSchema,
  type AuthState,
  type DecisionInput,
  type Run,
  type WorkspaceSnapshot,
} from "@vuzmi/core";

export type AuthHeadersProvider = () => Promise<Record<string, string>>;

export class NativeApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "NativeApiError";
  }
}

export function normalizeBackendUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new NativeApiError(
      "Enter a complete loopback URL, such as http://127.0.0.1:4310.",
      "INVALID_BACKEND",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new NativeApiError(
      "Use the backend origin without credentials, a path, query, or fragment.",
      "INVALID_BACKEND",
    );
  }
  if (
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    )
  ) {
    throw new NativeApiError(
      "This alpha connects only to a loopback backend in the iOS Simulator. Authenticated physical-device access is not configured yet.",
      "DEVICE_ACCESS_UNAVAILABLE",
    );
  }
  return url.origin;
}

export class NativeApi {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly authHeaders: AuthHeadersProvider = async () => ({}),
  ) {
    this.baseUrl = normalizeBackendUrl(baseUrl);
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    try {
      let headers: Record<string, string>;
      try {
        headers = await this.authHeaders();
      } catch {
        throw new NativeApiError(
          "The secure owner session could not be read. Restart this signed app and reconnect before loading business data.",
          "SESSION_UNAVAILABLE",
        );
      }
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/v1${path}`, {
          ...init,
          signal: controller.signal,
          credentials: "omit",
          redirect: "error",
          headers: {
            Accept: "application/json",
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
        });
      } catch {
        throw new NativeApiError(
          timedOut
            ? "The backend request timed out. The saved result has not been confirmed; refresh before deciding again."
            : "The local backend could not be reached. Check the API on this Mac, then reconnect or refresh.",
          timedOut ? "TIMEOUT" : "CONNECTION_FAILED",
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new NativeApiError(
          "The backend returned an unreadable response. No action result has been confirmed.",
          "INVALID_RESPONSE",
          response.status,
        );
      }
      if (!response.ok) {
        const error = (body as { error?: { code?: string; message?: string } })
          ?.error;
        throw new NativeApiError(
          response.status === 401
            ? "Your owner session is missing or has expired. Sign in again before loading runs or recording a decision."
            : (error?.message ??
              "The backend could not complete this request."),
          error?.code ?? "REQUEST_FAILED",
          response.status,
        );
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async workspace(): Promise<WorkspaceSnapshot> {
    const body = (await this.request("/workspace")) as WorkspaceSnapshot;
    if (
      !body?.workspace ||
      body.workspace.id !== "local-workspace" ||
      !Array.isArray(body.runs)
    )
      throw new NativeApiError(
        "The backend did not return the expected workspace contract.",
        "INVALID_RESPONSE",
      );
    try {
      return {
        workspace: body.workspace,
        runs: body.runs.map((run) => runSchema.parse(run)),
      };
    } catch {
      throw new NativeApiError(
        "A saved run did not match the shared client contract. Refresh after the API and companion versions are aligned.",
        "INVALID_RESPONSE",
      );
    }
  }

  async authState(): Promise<AuthState> {
    const result = authStateSchema.safeParse(await this.request("/auth/state"));
    if (!result.success)
      throw new NativeApiError(
        "The backend did not return the expected owner-session contract.",
        "INVALID_RESPONSE",
      );
    return result.data;
  }

  async run(id: string): Promise<Run> {
    const body = (await this.request(`/runs/${encodeURIComponent(id)}`)) as {
      run: unknown;
    };
    const result = runSchema.safeParse(body.run);
    if (!result.success)
      throw new NativeApiError(
        "The run did not match the shared client contract.",
        "INVALID_RESPONSE",
      );
    return result.data;
  }

  async decide(run: Run, decision: DecisionInput["decision"]): Promise<Run> {
    if (!run.proposal || run.status !== "waiting_approval")
      throw new NativeApiError(
        "This run has no proposal ready for a decision.",
        "INVALID_STATE",
      );
    const input = decisionSchema.parse({
      decision,
      revision: run.revision,
      fingerprint: run.proposal.fingerprint,
    });
    const body = (await this.request(
      `/runs/${encodeURIComponent(run.id)}/decisions`,
      { method: "POST", body: JSON.stringify(input) },
    )) as { run: unknown };
    const result = runSchema.safeParse(body.run);
    if (!result.success)
      throw new NativeApiError(
        "The decision response did not match the shared contract. Refresh to inspect the saved state.",
        "INVALID_RESPONSE",
      );
    return result.data;
  }
}
