import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  createRunSchema,
  createSimulationRun,
  decisionSchema,
  decideRun,
  DomainError,
} from "@vuzmi/core";
import type { Run, WorkspaceSnapshot } from "@vuzmi/core";
import { LocalStateStore } from "./store.js";

export interface AppOptions {
  dataDir?: string;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const allowedHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4310",
  "http://localhost:4310",
]);

function findRun(runs: Run[], id: string): Run {
  const run = runs.find((candidate) => candidate.id === id);
  if (!run)
    throw new HttpError(
      404,
      "RUN_NOT_FOUND",
      "This run does not exist in the local workspace.",
    );
  return run;
}

export async function buildApp(
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const store = await LocalStateStore.load(
    options.dataDir ??
      fileURLToPath(new URL("../../../.data", import.meta.url)),
  );
  const now = options.now ?? (() => new Date());
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024,
    trustProxy: false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!allowedHost.test(request.headers.host ?? "")) {
      return reply
        .code(403)
        .send({
          error: {
            code: "HOST_NOT_ALLOWED",
            message: "This local API accepts loopback hosts only.",
          },
        });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reply
        .code(403)
        .send({
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message:
              "This browser origin is not permitted to access the local workspace.",
          },
        });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof DomainError) {
      return reply
        .code(409)
        .send({ error: { code: error.code, message: error.message } });
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({
          error: {
            code: "INVALID_REQUEST",
            message:
              "The request could not be read. Send a valid JSON body within the supported size limit.",
          },
        });
    }
    return reply
      .code(500)
      .send({
        error: {
          code: "PERSISTENCE_ERROR",
          message:
            "The local operation could not be saved. No completed result has been confirmed; retry after checking local storage.",
        },
      });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply
      .code(404)
      .send({
        error: {
          code: "NOT_FOUND",
          message: "This local API route does not exist.",
        },
      });
  });

  app.get(
    "/v1/workspace",
    async (): Promise<WorkspaceSnapshot> => ({
      workspace: {
        id: "local-workspace",
        name: "Vuzmi Lab",
        mode: "simulation",
        storage: "local_file",
        cloudExecution: false,
      },
      runs: store.snapshot().runs,
    }),
  );

  app.get("/v1/runs", async () => ({ runs: store.snapshot().runs }));

  app.post("/v1/runs", async (request, reply) => {
    const input = createRunSchema.safeParse(request.body);
    if (!input.success)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Provide a title of 3–120 characters, a brief of 10–6000 characters, and a supported domain.",
      );
    const run = await store.mutate((state) => {
      const created = createSimulationRun(input.data, {
        id: randomUUID(),
        now: now().toISOString(),
        fingerprint: (value) =>
          createHash("sha256").update(value).digest("hex"),
      });
      return {
        state: { ...state, runs: [created, ...state.runs] },
        result: created,
      };
    });
    return reply.code(201).send({ run });
  });

  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (request) => ({
    run: findRun(store.snapshot().runs, request.params.id),
  }));

  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/decisions",
    async (request) => {
      const input = decisionSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide approve or reject, the exact proposal fingerprint, and a positive integer revision.",
        );
      const run = await store.mutate((state) => {
        const current = findRun(state.runs, request.params.id);
        const decided = decideRun(current, input.data, now().toISOString());
        return {
          state: {
            ...state,
            runs: state.runs.map((candidate) =>
              candidate.id === decided.id ? decided : candidate,
            ),
          },
          result: decided,
        };
      });
      return { run };
    },
  );

  app.addHook("onClose", async () => store.idle());
  await app.ready();
  return app;
}
