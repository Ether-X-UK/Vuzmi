import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { AuthError, type AuthService } from "@vuzmi/auth";
import {
  createRunSchema,
  createSimulationRun,
  decisionSchema,
  decideRun,
  DomainError,
  DraftRevisionError,
  DevelopmentError,
  DevelopmentApplicationError,
  DevelopmentDeliveryError,
  reviseDraftSchema,
} from "@vuzmi/core";
import type {
  Run,
  RuntimeInfo,
  SafeOwner,
  WorkspaceSnapshot,
} from "@vuzmi/core";
import {
  discoverEmbeddingProfile,
  listLocalModels,
  ProviderError,
} from "@vuzmi/providers";
import {
  KnowledgeError,
  PostgresRunRepository,
  RunNotFoundError,
  createDevelopmentGitHubConnector,
} from "@vuzmi/runtime";
import type { KnowledgeEmbedder, DevelopmentGitHubAdapter } from "@vuzmi/runtime";
import { LocalStateStore } from "./store.js";
import { HttpError } from "./errors.js";
import { registerKnowledgeRoutes } from "./knowledge.js";
import { registerOutboxRoutes } from "./outbox.js";
import { registerSourceRoutes } from "./source.js";
import { registerDevelopmentRoutes } from "./development.js";

export interface AppOptions {
  dataDir?: string;
  now?: () => Date;
  databaseUrl?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  ollamaDevelopmentModel?: string;
  ollamaEmbeddingModel?: string;
  databaseSchema?: string;
  queueSchema?: string;
  discoverProfile?: typeof discoverEmbeddingProfile;
  embedKnowledge?: KnowledgeEmbedder;
  discoverModels?: typeof listLocalModels;
  auth?: AuthService;
  authBaseUrl?: string;
  webRoot?: string;
  githubFetch?: typeof globalThis.fetch;
  githubDelivery?: DevelopmentGitHubAdapter;
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
  const repository = options.databaseUrl
    ? await PostgresRunRepository.connect({
        connectionString: options.databaseUrl,
        schema: options.databaseSchema,
        queueSchema: options.queueSchema,
        now: options.now,
      })
    : undefined;
  const store = repository
    ? undefined
    : await LocalStateStore.load(
        options.dataDir ??
          fileURLToPath(new URL("../../../.data", import.meta.url)),
      );
  const now = options.now ?? (() => new Date());
  const discoverModels = options.discoverModels ?? listLocalModels;
  const listRuns = () =>
    repository ? repository.list() : Promise.resolve(store!.snapshot().runs);
  const getRun = async (id: string): Promise<Run> => {
    if (!repository) return findRun(store!.snapshot().runs, id);
    const run = await repository.get("local-workspace", id);
    if (!run) throw new RunNotFoundError();
    return run;
  };
  const runtime = async (): Promise<RuntimeInfo> => {
    const worker = repository
      ? await repository.workerHealth()
      : { state: "not_configured" as const, lastSeenAt: null };
    let models: RuntimeInfo["ollama"]["models"] = [];
    let error: string | null = null;
    try {
      models = await discoverModels({ baseUrl: options.ollamaBaseUrl });
    } catch (cause) {
      error =
        cause instanceof ProviderError
          ? cause.message
          : "The local Ollama service could not be inspected.";
    }
    return {
      storage: repository ? "postgres" : "local_file",
      liveAvailable:
        !!repository && worker.state === "ready" && !error && models.length > 0,
      checkedAt: now().toISOString(),
      worker,
      ollama: {
        reachable: error === null,
        models,
        configuredModel: options.ollamaModel ?? null,
        error,
      },
    };
  };
  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024,
    trustProxy: false,
  });
  const owners = new WeakMap<object, SafeOwner>();
  const trustedOrigins = new Set(allowedOrigins);
  if (options.auth) {
    trustedOrigins.add(
      new URL(options.authBaseUrl ?? "http://127.0.0.1:5173").origin,
    );
    trustedOrigins.add("vuzmi://");
  }
  const webHeaders = (
    headers: Record<string, string | string[] | undefined>,
  ): Headers => {
    const result = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined)
        result.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    return result;
  };
  const authHeaders = (request: {
    headers: Record<string, string | string[] | undefined>;
    ip: string;
  }): Headers => {
    const headers = webHeaders(request.headers);
    for (const name of [
      "forwarded",
      "x-forwarded-for",
      "x-real-ip",
      "cf-connecting-ip",
      "true-client-ip",
    ])
      headers.delete(name);
    headers.set("x-forwarded-for", request.ip);
    return headers;
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!allowedHost.test(request.headers.host ?? "")) {
      return reply.code(403).send({
        error: {
          code: "HOST_NOT_ALLOWED",
          message: "This local API accepts loopback hosts only.",
        },
      });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !trustedOrigins.has(origin)) {
      return reply.code(403).send({
        error: {
          code: "ORIGIN_NOT_ALLOWED",
          message:
            "This browser origin is not permitted to access the local workspace.",
        },
      });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    // Use the matched route, not attacker-controlled URL spelling. Fastify can
    // match percent-encoded static segments to the same business handler.
    const path = request.routeOptions.url ?? "";
    if (
      options.auth &&
      path.startsWith("/v1/") &&
      path !== "/v1/auth/state" &&
      path !== "/v1/auth/setup"
    ) {
      const owner = await options.auth.session(authHeaders(request));
      if (!owner)
        throw new HttpError(
          401,
          "SESSION_REQUIRED",
          "Sign in to access this workspace.",
        );
      owners.set(request, owner);
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        (!origin || !trustedOrigins.has(origin))
      ) {
        throw new HttpError(
          403,
          "ORIGIN_REQUIRED",
          "Workspace changes require a trusted browser or Vuzmi app origin.",
        );
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof DevelopmentError ||
      error instanceof DevelopmentApplicationError ||
      error instanceof DevelopmentDeliveryError
    )
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof AuthError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof KnowledgeError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof DraftRevisionError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof RunNotFoundError)
      return reply
        .code(404)
        .send({ error: { code: error.code, message: error.message } });
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
      return reply.code(statusCode).send({
        error: {
          code: "INVALID_REQUEST",
          message:
            "The request could not be read. Send a valid JSON body within the supported size limit.",
        },
      });
    }
    return reply.code(500).send({
      error: {
        code: "PERSISTENCE_ERROR",
        message:
          "The local operation could not be saved. No completed result has been confirmed; retry after checking local storage.",
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "This local API route does not exist.",
      },
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  registerSourceRoutes(app);
  app.get("/readyz", async (_request, reply) => {
    try {
      const worker = repository ? await repository.workerHealth() : undefined;
      const ready = Boolean(
        repository && worker?.state === "ready" && options.auth,
      );
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? "ready" : "not_ready" });
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  if (options.webRoot)
    await app.register(fastifyStatic, {
      root: options.webRoot,
      dotfiles: "deny",
      cacheControl: false,
      index: "index.html",
    });

  app.get("/v1/auth/state", async (request) =>
    options.auth
      ? options.auth.state(authHeaders(request))
      : { mode: "development", setupNeeded: false, user: null },
  );
  app.post("/v1/auth/setup", async (request, reply) => {
    if (!options.auth)
      throw new HttpError(
        409,
        "AUTH_DEVELOPMENT_MODE",
        "Owner setup is unavailable in explicit development mode.",
      );
    if (
      request.headers.origin !==
      new URL(options.authBaseUrl ?? "http://127.0.0.1:5173").origin
    ) {
      throw new HttpError(
        403,
        "ORIGIN_REQUIRED",
        "Complete owner setup from the local web client.",
      );
    }
    const user = await options.auth.setupOwner(
      request.body as Parameters<AuthService["setupOwner"]>[0],
    );
    return reply.code(201).send({ user });
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      if (!options.auth)
        throw new HttpError(
          409,
          "AUTH_DEVELOPMENT_MODE",
          "Authentication is unavailable in explicit development mode.",
        );
      const headers = authHeaders(request);
      const body =
        request.body === undefined ? undefined : JSON.stringify(request.body);
      if (body !== undefined) {
        headers.set("Content-Type", "application/json");
        headers.delete("content-length");
      }
      const response = await options.auth.handler(
        new Request(
          new URL(request.url, options.authBaseUrl ?? "http://127.0.0.1:5173"),
          { method: request.method, headers, body },
        ),
      );
      for (const [name, value] of response.headers)
        if (name !== "set-cookie") reply.header(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("Set-Cookie", cookies);
      return reply.code(response.status).send(await response.text());
    },
  });

  app.get("/v1/workspace", async (): Promise<WorkspaceSnapshot> => ({
    workspace: {
      id: "local-workspace",
      name: "Vuzmi Lab",
      mode: repository ? "local" : "simulation",
      storage: repository ? "postgres" : "local_file",
      cloudExecution: false,
    },
    runs: await listRuns(),
  }));

  app.get("/v1/runtime", runtime);
  registerDevelopmentRoutes(app, {
    repository: () => {
      if (!repository?.development)
        throw new HttpError(
          503,
          "DEVELOPMENT_UNAVAILABLE",
          "Development workflows require PostgreSQL and an isolated worker.",
        );
      return repository.development;
    },
    applications: () => {
      if (!repository?.applications)
        throw new HttpError(
          503,
          "APPLICATION_UNAVAILABLE",
          "Local branch applications require PostgreSQL and a trusted worker.",
        );
      return repository.applications;
    },
    deliveries: () => {
      if (!repository?.deliveries)
        throw new HttpError(
          503,
          "DELIVERY_UNAVAILABLE",
          "GitHub delivery requires PostgreSQL and a trusted publication worker.",
        );
      return repository.deliveries;
    },
    githubDelivery:
      options.githubDelivery ??
      createDevelopmentGitHubConnector({
        fetch: options.githubFetch,
        now: options.now,
      }),
    owner: (request) => owners.get(request),
    models: () => discoverModels({ baseUrl: options.ollamaBaseUrl }),
    defaultModel:
      options.ollamaDevelopmentModel ?? options.ollamaModel ?? "qwen3.5:4b",
    githubFetch: options.githubFetch,
    now,
  });
  registerOutboxRoutes(app, { listRuns, getRun });
  registerKnowledgeRoutes(app, {
    repository,
    ollamaBaseUrl: options.ollamaBaseUrl,
    ollamaEmbeddingModel: options.ollamaEmbeddingModel,
    discoverProfile: options.discoverProfile,
    embed: options.embedKnowledge,
    githubFetch: options.githubFetch,
    ownerId: (request) => owners.get(request)?.id,
    now,
  });
  app.get("/v1/runs", async () => ({ runs: await listRuns() }));

  app.post("/v1/runs", async (request, reply) => {
    const input = createRunSchema.safeParse(request.body);
    if (!input.success)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Provide a title of 3–120 characters, a brief of 10–6000 characters, and a supported domain.",
      );
    if (input.data.mode === "ollama") {
      if (!repository)
        throw new HttpError(
          503,
          "LIVE_NOT_CONFIGURED",
          "Local model execution requires PostgreSQL and a running worker. Start the local services or use Simulation.",
        );
      const observed = await runtime();
      if (!observed.liveAvailable)
        throw new HttpError(
          503,
          "LOCAL_RUNTIME_UNAVAILABLE",
          observed.ollama.error ??
            (observed.worker.state !== "ready"
              ? "The local worker is offline. Start it before creating a live mission."
              : "No eligible local Ollama model is installed."),
        );
      const model = input.data.model ?? options.ollamaModel;
      if (
        !model ||
        !observed.ollama.models.some((candidate) => candidate.name === model)
      )
        throw new HttpError(
          400,
          "MODEL_UNAVAILABLE",
          "Choose an installed, eligible local model from Model control.",
        );
      const run = await repository.create(input.data, {
        workspaceId: "local-workspace",
        id: randomUUID(),
        model,
      });
      return reply.code(202).send({ run });
    }
    if (repository) {
      const run = await repository.create(input.data, {
        workspaceId: "local-workspace",
        id: randomUUID(),
      });
      return reply.code(201).send({ run });
    }
    const run = await store!.mutate((state) => {
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
    run: await getRun(request.params.id),
  }));

  app.patch<{ Params: { id: string } }>(
    "/v1/runs/:id/draft",
    { bodyLimit: 160 * 1024 },
    async (request) => {
      const input = reviseDraftSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_DRAFT",
          "Provide an edit UUID, the displayed revision and fingerprint, a draft body within 64 KiB, and a reason of 3–600 characters.",
        );
      if (!repository)
        throw new HttpError(
          409,
          "DRAFT_NOT_EDITABLE",
          "Draft revision requires a saved local Ollama proposal in PostgreSQL.",
        );
      return {
        run: await repository.amend(
          "local-workspace",
          request.params.id,
          input.data,
          owners.get(request),
        ),
      };
    },
  );

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
      if (repository)
        return {
          run: await repository.decide(
            "local-workspace",
            request.params.id,
            input.data,
            owners.get(request),
          ),
        };
      const run = await store!.mutate((state) => {
        const current = findRun(state.runs, request.params.id);
        const decided = decideRun(
          current,
          input.data,
          now().toISOString(),
          owners.get(request),
        );
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

  app.addHook("onClose", async () => {
    if (repository) await repository.close();
    else await store!.idle();
    await options.auth?.close();
  });
  await app.ready();
  return app;
}
