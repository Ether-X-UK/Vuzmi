import {
  developmentDeliveryInputSchema,
  developmentDeliveryPlanSchema,
  developmentDeliverySchema,
  developmentDeliveryTextSchema,
  type DevelopmentDelivery,
  type DevelopmentDeliveryInput,
  type DevelopmentDeliveryPlan,
  type DevelopmentDeliveryText,
} from "@vuzmi/core";
import { ApiError } from "./api";
import { developmentRequest } from "./developmentApi";

function invalid(): never {
  throw new ApiError(
    "The GitHub delivery response could not be verified. Check recorded status before deciding or retrying.",
    "INVALID_RESPONSE",
    0,
  );
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}
async function call<T>(
  id: string,
  suffix: string,
  init: RequestInit | undefined,
  parse: (value: unknown) => T,
): Promise<T> {
  return developmentRequest(
    `/${encodeURIComponent(id)}/delivery${suffix}`,
    init,
    (text) => parse(JSON.parse(text)),
  );
}
function operationResponse(value: unknown, id: string): DevelopmentDelivery {
  const parsed = developmentDeliverySchema.safeParse(value);
  return parsed.success &&
    parsed.data.runId === id &&
    parsed.data.plan.runId === id &&
    parsed.data.plan.destinationRef === `refs/heads/vuzmi/development/${id}`
    ? parsed.data
    : invalid();
}
export async function getDevelopmentDelivery(
  id: string,
  signal?: AbortSignal,
): Promise<{
  operation: DevelopmentDelivery | null;
  available: boolean;
  authorityIdentity: string | null;
  reason: string | null;
  checkedAt: string;
}> {
  return call(id, "", { signal }, (value) => {
    const body = object(value);
    if (
      typeof body.available !== "boolean" ||
      !(body.reason === null || typeof body.reason === "string") ||
      typeof body.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(body.checkedAt)) ||
      !(
        body.authorityIdentity === null ||
        (typeof body.authorityIdentity === "string" &&
          /^[a-f0-9]{64}$/.test(body.authorityIdentity))
      ) ||
      (body.available && body.authorityIdentity === null)
    )
      return invalid();
    return {
      operation:
        body.operation === null ? null : operationResponse(body.operation, id),
      available: body.available,
      authorityIdentity: body.authorityIdentity as string | null,
      reason: body.reason as string | null,
      checkedAt: body.checkedAt,
    };
  });
}
export async function prepareDevelopmentDelivery(
  id: string,
  input: DevelopmentDeliveryText,
  signal?: AbortSignal,
): Promise<{
  plan: DevelopmentDeliveryPlan;
  available: boolean;
  reason: string | null;
}> {
  return call(
    id,
    "/plan",
    {
      method: "POST",
      body: JSON.stringify(developmentDeliveryTextSchema.parse(input)),
      signal,
    },
    (value) => {
      const body = object(value),
        parsed = developmentDeliveryPlanSchema.safeParse(body.plan);
      if (
        !parsed.success ||
        parsed.data.runId !== id ||
        parsed.data.destinationRef !== `refs/heads/vuzmi/development/${id}` ||
        parsed.data.title !== input.title ||
        parsed.data.inputBody !== input.body ||
        typeof body.available !== "boolean" ||
        !(body.reason === null || typeof body.reason === "string")
      )
        return invalid();
      return {
        plan: parsed.data,
        available: body.available,
        reason: body.reason as string | null,
      };
    },
  );
}
export async function authorizeDevelopmentDelivery(
  id: string,
  input: DevelopmentDeliveryInput,
  signal?: AbortSignal,
): Promise<{ operation: DevelopmentDelivery; replayed: boolean }> {
  return call(
    id,
    "",
    {
      method: "POST",
      body: JSON.stringify(developmentDeliveryInputSchema.parse(input)),
      signal,
    },
    (value) => {
      const body = object(value),
        operation = operationResponse(body.operation, id);
      if (
        typeof body.replayed !== "boolean" ||
        operation.requestId !== input.requestId ||
        operation.plan.fingerprint !== input.planFingerprint ||
        operation.plan.packageSha256 !== input.packageSha256 ||
        operation.plan.title !== input.title ||
        operation.plan.inputBody !== input.body
      )
        return invalid();
      return { operation, replayed: body.replayed };
    },
  );
}
export async function refreshDevelopmentDelivery(
  id: string,
  signal?: AbortSignal,
): Promise<DevelopmentDelivery | null> {
  return call(
    id,
    "/refresh",
    { method: "POST", body: "{}", signal },
    (value) => {
      const body = object(value);
      return body.operation === null
        ? null
        : operationResponse(body.operation, id);
    },
  );
}
