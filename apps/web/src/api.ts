import {
  runSchema,
  runtimeInfoSchema,
  type CreateRunInput,
  type DecisionInput,
  type Run,
  type WorkspaceSnapshot,
  type RuntimeInfo,
} from "@vuzmi/core";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getRuntime(): Promise<RuntimeInfo> {
  return runtimeInfoSchema.parse(await request("/runtime"));
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/v1${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      "The local backend could not be reached. Check that the API is running, then try again.",
      "CONNECTION_FAILED",
      0,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      "The backend returned an unreadable response. Please refresh and try again.",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  if (!response.ok) {
    const error = (body as { error?: { message?: string; code?: string } })
      ?.error;
    throw new ApiError(
      error?.message ?? "The request could not be completed.",
      error?.code ?? "REQUEST_FAILED",
      response.status,
    );
  }
  return body;
}

export async function getWorkspace(): Promise<WorkspaceSnapshot> {
  const body = (await request("/workspace")) as WorkspaceSnapshot;
  if (
    !body?.workspace ||
    body.workspace.id !== "local-workspace" ||
    !Array.isArray(body.runs)
  ) {
    throw new ApiError(
      "The workspace response did not match the expected local API contract.",
      "INVALID_RESPONSE",
      0,
    );
  }
  return {
    workspace: body.workspace,
    runs: body.runs.map((run) => runSchema.parse(run)),
  };
}

export async function createRun(input: CreateRunInput): Promise<Run> {
  const body = (await request("/runs", {
    method: "POST",
    body: JSON.stringify(input),
  })) as { run: unknown };
  return runSchema.parse(body.run);
}

export async function getRun(id: string): Promise<Run> {
  const body = (await request(`/runs/${encodeURIComponent(id)}`)) as {
    run: unknown;
  };
  return runSchema.parse(body.run);
}

export async function decideRun(
  id: string,
  input: DecisionInput,
): Promise<Run> {
  const body = (await request(`/runs/${encodeURIComponent(id)}/decisions`, {
    method: "POST",
    body: JSON.stringify(input),
  })) as { run: unknown };
  return runSchema.parse(body.run);
}
