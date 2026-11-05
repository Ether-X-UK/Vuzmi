import {
  developmentInputSchema,
  developmentPackageSchema,
  developmentRunSchema,
  developmentRuntimeSchema,
  type DecisionInput,
  type DevelopmentInput,
  type DevelopmentPackage,
  type DevelopmentRun,
  type DevelopmentRuntime,
} from "@vuzmi/core";
import { ApiError } from "./api";

type TransportOptions = {
  fetcher?: typeof fetch;
  expireSession?: () => void;
  scheduleDeadline?: (expire: () => void) => () => void;
};

/** Fixed local module transport. Header authority and deadlines do not depend on body/abort cooperation. */
export async function developmentRequest<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (text: string) => T | Promise<T>,
  options: TransportOptions = {},
): Promise<T> {
  const aborted = () =>
    new ApiError(
      "The development request was cancelled. Its mutation result may be unconfirmed; refresh saved state before retrying.",
      "ABORTED",
      0,
    );
  if (init?.signal?.aborted) throw aborted();
  const controller = new AbortController();
  let active = true;
  let cancelDeadline = () => {};
  let relay = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    relay = () => {
      active = false;
      controller.abort();
      reject(aborted());
    };
    init?.signal?.addEventListener("abort", relay, { once: true });
  });
  const deadline = new Promise<never>((_, reject) => {
    const expire = () => {
      active = false;
      controller.abort();
      reject(
        new ApiError(
          "The development request timed out. Refresh saved state before retrying an unconfirmed change.",
          "TIMEOUT",
          0,
        ),
      );
    };
    cancelDeadline = options.scheduleDeadline
      ? options.scheduleDeadline(expire)
      : (() => {
          const timer = setTimeout(expire, 20_000);
          return () => clearTimeout(timer);
        })();
  });
  async function operation(): Promise<T> {
    if (!active) throw aborted();
    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(`/v1/development${path}`, {
        ...init,
        signal: controller.signal,
        credentials: "same-origin",
        headers: {
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch {
      throw new ApiError(
        "The local development backend could not be reached. Check the connection, then refresh saved state.",
        "CONNECTION_FAILED",
        0,
      );
    }
    if (!active) throw aborted();
    if (response.status === 401)
      (
        options.expireSession ??
        (() => window.dispatchEvent(new Event("vuzmi:session-expired")))
      )();
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ApiError(
        "The development response body could not be read. Refresh saved state before retrying an unconfirmed change.",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    if (!active) throw aborted();
    if (!response.ok) {
      let message = `The development request failed (HTTP ${response.status}). Refresh saved state and try again explicitly.`;
      let code = "REQUEST_FAILED";
      try {
        const body = JSON.parse(text);
        if (typeof body?.error?.message === "string")
          message = body.error.message;
        if (typeof body?.error?.code === "string") code = body.error.code;
      } catch {
        /* HTTP failure remains authoritative for unreadable response bodies. */
      }
      throw new ApiError(message, code, response.status);
    }
    let value: T;
    try {
      value = await parse(text);
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      return invalid();
    }
    if (!active) throw aborted();
    return value;
  }
  try {
    return await Promise.race([operation(), deadline, cancelled]);
  } finally {
    active = false;
    cancelDeadline();
    init?.signal?.removeEventListener("abort", relay);
  }
}

async function call<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (body: unknown) => T,
): Promise<T> {
  return developmentRequest(path, init, (text) => parse(JSON.parse(text)));
}

function invalid(): never {
  throw new ApiError(
    "The development response could not be verified. Refresh saved state before deciding or retrying.",
    "INVALID_RESPONSE",
    0,
  );
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : invalid();
}
function runResponse(value: unknown, id?: string): DevelopmentRun {
  const parsed = developmentRunSchema.safeParse(object(value).run);
  if (!parsed.success || (id && parsed.data.id !== id)) return invalid();
  return parsed.data;
}
export async function getDevelopmentRuntime(
  signal?: AbortSignal,
): Promise<DevelopmentRuntime> {
  return call("/runtime", { signal }, (body) => {
    const parsed = developmentRuntimeSchema.safeParse(body);
    return parsed.success ? parsed.data : invalid();
  });
}
export async function listDevelopmentRuns(
  signal?: AbortSignal,
): Promise<DevelopmentRun[]> {
  return call("", { signal }, (value) => {
    const body = object(value);
    if (!Array.isArray(body.runs)) return invalid();
    return body.runs.map((run) => {
      const parsed = developmentRunSchema.safeParse(run);
      return parsed.success ? parsed.data : invalid();
    });
  });
}
export async function createDevelopment(
  input: DevelopmentInput,
  signal?: AbortSignal,
): Promise<{ run: DevelopmentRun; replayed: boolean }> {
  return call(
    "",
    {
      method: "POST",
      body: JSON.stringify(developmentInputSchema.parse(input)),
      signal,
    },
    (value) => {
      const body = object(value);
      if (typeof body.replayed !== "boolean") return invalid();
      const run = runResponse(body);
      if (run.requestId !== input.requestId) return invalid();
      return { run, replayed: body.replayed };
    },
  );
}
export async function getDevelopmentRun(
  id: string,
  signal?: AbortSignal,
): Promise<DevelopmentRun> {
  return call(`/${encodeURIComponent(id)}`, { signal }, (value) =>
    runResponse(value, id),
  );
}
export async function decideDevelopment(
  id: string,
  input: DecisionInput,
  signal?: AbortSignal,
): Promise<DevelopmentRun> {
  return call(
    `/${encodeURIComponent(id)}/decisions`,
    { method: "POST", body: JSON.stringify(input), signal },
    (value) => runResponse(value, id),
  );
}
export async function getDevelopmentPackage(
  id: string,
  signal?: AbortSignal,
): Promise<{ content: string; value: DevelopmentPackage }> {
  return developmentRequest(
    `/${encodeURIComponent(id)}/package`,
    { signal },
    (content) => {
      const value: unknown = JSON.parse(content);
      const parsed = developmentPackageSchema.safeParse(value);
      if (!parsed.success || parsed.data.review.runId !== id) return invalid();
      return { content, value: parsed.data };
    },
  );
}
