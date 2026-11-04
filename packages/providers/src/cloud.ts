/**
 * Text-only cloud protocol contracts. No app/router integration is enabled here.
 * Execution is disabled unless explicitly allowed AND given an injected transport.
 * Current verification uses fixture transports and synthetic credentials only.
 *
 * Primary protocol references reviewed 4 November 2026:
 * https://developers.openai.com/api/docs/guides/text
 * https://developers.openai.com/api/docs/guides/migrate-to-responses
 * https://platform.claude.com/docs/en/api/messages/create
 * https://platform.claude.com/docs/en/api/overview
 * https://platform.claude.com/docs/en/api/versioning
 *
 * Sign in with ChatGPT is deliberately separate: its current preview requires
 * streaming and forbids max_output_tokens, among other differences:
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */

export type CloudProviderErrorCode =
  | "REMOTE_EXECUTION_DISABLED"
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "REQUEST_REJECTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "ABORTED"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "INCOMPLETE_OUTPUT"
  | "REFUSED"
  | "UNSUPPORTED_RESPONSE";

export class CloudProviderError extends Error {
  constructor(
    public readonly code: CloudProviderErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "CloudProviderError";
  }
}

export type CloudTextInput = {
  model: string;
  instructions: string;
  input: string;
  apiKey?: string;
  allowRemoteExecution?: boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
};

export type ClaudeTextInput = CloudTextInput & { workspaceId?: string };

export type CloudTextResult = {
  provider: "openai" | "anthropic";
  model: string;
  content: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: null;
  };
};

export const CLOUD_CONTRACT_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  maxTimeoutMs: 180_000,
  maxInputBytes: 16_384,
  maxResponseBytes: 1_048_576,
  outputTokens: 2_048,
  maxOutputTokens: 4_096,
  maxOutputCharacters: 24_000,
  anthropicVersion: "2026-10-21",
});

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalidResponse(): CloudProviderError {
  return new CloudProviderError(
    "INVALID_RESPONSE",
    "The provider response could not be accepted as a complete text result.",
  );
}

function validateInput(input: CloudTextInput): {
  fetcher: typeof fetch;
  timeoutMs: number;
  outputTokens: number;
  credential: string;
} {
  // This check deliberately precedes validation, credential use and fetch setup.
  if (input.allowRemoteExecution !== true) {
    throw new CloudProviderError(
      "REMOTE_EXECUTION_DISABLED",
      "Cloud execution is disabled. Configured credentials do not grant permission to make requests.",
    );
  }
  if (typeof input.fetch !== "function") {
    throw new CloudProviderError(
      "INVALID_CONFIGURATION",
      "This contract slice requires an explicitly injected transport. No default cloud transport is enabled.",
    );
  }
  if (
    typeof input.apiKey !== "string" ||
    !input.apiKey.trim() ||
    input.apiKey.length > 4096 ||
    /[\r\n\u0000]/.test(input.apiKey)
  ) {
    throw new CloudProviderError(
      "INVALID_CONFIGURATION",
      "A valid server-side provider credential is required for this explicitly allowed transport.",
    );
  }
  if (
    typeof input.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model) ||
    typeof input.instructions !== "string" ||
    !input.instructions.trim() ||
    typeof input.input !== "string" ||
    !input.input.trim() ||
    Buffer.byteLength(input.instructions + input.input, "utf8") >
      CLOUD_CONTRACT_LIMITS.maxInputBytes
  ) {
    throw new CloudProviderError(
      "INVALID_INPUT",
      "Provide a configured model, instructions and bounded nonempty text input.",
    );
  }
  const timeoutMs = input.timeoutMs ?? CLOUD_CONTRACT_LIMITS.timeoutMs;
  const outputTokens =
    input.maxOutputTokens ?? CLOUD_CONTRACT_LIMITS.outputTokens;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > CLOUD_CONTRACT_LIMITS.maxTimeoutMs ||
    !Number.isInteger(outputTokens) ||
    outputTokens <= 0 ||
    outputTokens > CLOUD_CONTRACT_LIMITS.maxOutputTokens
  ) {
    throw new CloudProviderError(
      "INVALID_CONFIGURATION",
      "The provider timeout or output limit is outside the supported bounds.",
    );
  }
  return {
    fetcher: input.fetch,
    timeoutMs,
    outputTokens,
    credential: input.apiKey,
  };
}

function httpError(status: number): CloudProviderError {
  if (status === 401 || status === 403)
    return new CloudProviderError(
      "AUTHENTICATION_FAILED",
      "The provider did not accept the configured credentials or permissions.",
    );
  if (status === 429)
    return new CloudProviderError(
      "RATE_LIMITED",
      "The provider rate or usage limit was reached. No automatic retry or fallback was attempted.",
      true,
    );
  if (status >= 500)
    return new CloudProviderError(
      "UNAVAILABLE",
      "The provider is temporarily unavailable. No automatic retry or fallback was attempted.",
      true,
    );
  return new CloudProviderError(
    "REQUEST_REJECTED",
    "The provider rejected this text request. Review the selected model and configuration.",
  );
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (
    Number(response.headers.get("content-length")) >
    CLOUD_CONTRACT_LIMITS.maxResponseBytes
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new CloudProviderError(
      "RESPONSE_TOO_LARGE",
      "The provider response exceeded this operation's byte limit.",
    );
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CLOUD_CONTRACT_LIMITS.maxResponseBytes) {
        cancel();
        throw new CloudProviderError(
          "RESPONSE_TOO_LARGE",
          "The provider response exceeded this operation's byte limit.",
        );
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw invalidResponse();
    }
    if (!isObject(parsed)) throw invalidResponse();
    return parsed;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function request(
  input: CloudTextInput,
  options: ReturnType<typeof validateInput>,
  url:
    | "https://api.openai.com/v1/responses"
    | "https://api.anthropic.com/v1/messages",
  body: JsonObject,
  extraHeaders: Record<string, string> = {},
): Promise<JsonObject> {
  if (input.signal?.aborted)
    throw new CloudProviderError(
      "ABORTED",
      "The provider operation was cancelled.",
    );
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(
        new CloudProviderError(
          timedOut ? "TIMEOUT" : "ABORTED",
          timedOut
            ? "The provider operation exceeded its time limit."
            : "The provider operation was cancelled.",
          timedOut,
        ),
      );
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  const operation = async (): Promise<JsonObject> => {
    let response: Response;
    try {
      response = await options.fetcher(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${options.credential}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      // Raw exceptions can contain credentials, URL details or the complete prompt.
      throw new CloudProviderError(
        "UNAVAILABLE",
        "The provider transport failed. No automatic retry or fallback was attempted.",
        true,
      );
    }
    controller.signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw httpError(response.status);
    }
    return responseJson(response, controller.signal);
  };
  try {
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CloudProviderError(
        timedOut ? "TIMEOUT" : "ABORTED",
        timedOut
          ? "The provider operation exceeded its time limit."
          : "The provider operation was cancelled.",
        timedOut,
      );
    }
    if (error instanceof CloudProviderError) throw error;
    throw invalidResponse();
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
  }
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function content(parts: string[]): string {
  const text = parts.join("\n\n").trim();
  if (!text || text.includes("\u0000")) throw invalidResponse();
  if (text.length > CLOUD_CONTRACT_LIMITS.maxOutputCharacters) {
    throw new CloudProviderError(
      "INCOMPLETE_OUTPUT",
      "The generated text exceeded this operation's output limit. No partial text was accepted.",
    );
  }
  return text;
}

function returnedModel(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 200 ||
    /[\r\n\u0000]/.test(value)
  )
    throw invalidResponse();
  // A provider may resolve an explicitly configured alias to its concrete snapshot.
  return value;
}

export async function generateOpenAIText(
  input: CloudTextInput,
): Promise<CloudTextResult> {
  const options = validateInput(input);
  const result = await request(
    input,
    options,
    "https://api.openai.com/v1/responses",
    {
      model: input.model,
      instructions: input.instructions,
      input: [{ role: "user", content: input.input }],
      store: false,
      stream: false,
      max_output_tokens: options.outputTokens,
    },
  );
  if (result.status === "incomplete")
    throw new CloudProviderError(
      "INCOMPLETE_OUTPUT",
      "The provider returned an incomplete response. No partial text was accepted.",
    );
  if (result.status === "failed")
    throw new CloudProviderError(
      "REQUEST_REJECTED",
      "The provider could not complete this text response.",
    );
  if (
    result.status !== "completed" ||
    result.error != null ||
    !Array.isArray(result.output)
  )
    throw invalidResponse();
  const parts: string[] = [];
  for (const item of result.output) {
    if (!isObject(item)) throw invalidResponse();
    if (item.type === "reasoning") continue;
    if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      !Array.isArray(item.content)
    ) {
      throw new CloudProviderError(
        "UNSUPPORTED_RESPONSE",
        "The provider returned content outside this text-only contract.",
      );
    }
    if (item.status !== undefined && item.status !== "completed")
      throw invalidResponse();
    for (const block of item.content) {
      if (!isObject(block)) throw invalidResponse();
      if (block.type === "refusal")
        throw new CloudProviderError(
          "REFUSED",
          "The provider declined to produce this response.",
        );
      if (block.type !== "output_text" || typeof block.text !== "string")
        throw invalidResponse();
      parts.push(block.text);
    }
  }
  const usage = isObject(result.usage) ? result.usage : {};
  return {
    provider: "openai",
    model: returnedModel(result.model),
    content: content(parts),
    usage: {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      durationMs: null,
    },
  };
}

export async function generateClaudeText(
  input: ClaudeTextInput,
): Promise<CloudTextResult> {
  const options = validateInput(input);
  if (
    input.workspaceId !== undefined &&
    !/^wrkspc_[a-zA-Z0-9]+$/.test(input.workspaceId)
  ) {
    throw new CloudProviderError(
      "INVALID_CONFIGURATION",
      "Provide a valid provider workspace identifier when the credential requires one.",
    );
  }
  const result = await request(
    input,
    options,
    "https://api.anthropic.com/v1/messages",
    {
      model: input.model,
      system: input.instructions,
      messages: [{ role: "user", content: input.input }],
      max_tokens: options.outputTokens,
      stream: false,
    },
    {
      "anthropic-version": CLOUD_CONTRACT_LIMITS.anthropicVersion,
      ...(input.workspaceId
        ? { "anthropic-workspace-id": input.workspaceId }
        : {}),
    },
  );
  if (result.stop_reason === "refusal")
    throw new CloudProviderError(
      "REFUSED",
      "The provider declined to produce this response.",
    );
  if (
    ["max_tokens", "model_context_window_exceeded"].includes(
      String(result.stop_reason),
    )
  ) {
    throw new CloudProviderError(
      "INCOMPLETE_OUTPUT",
      "The provider reached a response or context limit. No partial text was accepted.",
    );
  }
  if (result.stop_reason !== "end_turn")
    throw new CloudProviderError(
      "UNSUPPORTED_RESPONSE",
      "The provider did not complete a natural text-only response.",
    );
  if (
    result.type !== "message" ||
    result.role !== "assistant" ||
    !Array.isArray(result.content)
  )
    throw invalidResponse();
  const parts: string[] = [];
  for (const block of result.content) {
    if (!isObject(block)) throw invalidResponse();
    if (["thinking", "redacted_thinking"].includes(String(block.type)))
      continue;
    if (block.type !== "text" || typeof block.text !== "string") {
      throw new CloudProviderError(
        "UNSUPPORTED_RESPONSE",
        "The provider returned content outside this text-only contract.",
      );
    }
    parts.push(block.text);
  }
  const usage = isObject(result.usage) ? result.usage : {};
  const uncached = count(usage.input_tokens);
  const cacheRead =
    usage.cache_read_input_tokens === undefined
      ? 0
      : count(usage.cache_read_input_tokens);
  const cacheWrite =
    usage.cache_creation_input_tokens === undefined
      ? 0
      : count(usage.cache_creation_input_tokens);
  const inputTokens =
    uncached === null || cacheRead === null || cacheWrite === null
      ? null
      : count(uncached + cacheRead + cacheWrite);
  return {
    provider: "anthropic",
    model: returnedModel(result.model),
    content: content(parts),
    usage: {
      inputTokens,
      outputTokens: count(usage.output_tokens),
      durationMs: null,
    },
  };
}
