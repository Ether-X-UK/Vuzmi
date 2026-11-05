import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { decisionSchema, developmentInputSchema } from "@vuzmi/core";
import type { SafeOwner } from "@vuzmi/core";
import type { DevelopmentRepository } from "@vuzmi/runtime";
import type { listLocalModels } from "@vuzmi/providers";
import { GithubKnowledgeImporter } from "./github.js";
import { HttpError } from "./errors.js";

export function registerDevelopmentRoutes(
  app: FastifyInstance,
  options: {
    repository: () => DevelopmentRepository;
    owner: (request: FastifyRequest) => SafeOwner | undefined;
    models: () => ReturnType<typeof listLocalModels>;
    defaultModel?: string;
    githubFetch?: typeof globalThis.fetch;
    now?: () => Date;
  },
): void {
  const github = new GithubKnowledgeImporter({
    fetch: options.githubFetch,
    now: options.now,
  });
  app.addHook("onClose", async () => github.close());
  const owner = (request: FastifyRequest) => {
    const actor = options.owner(request);
    if (!actor)
      throw new HttpError(
        401,
        "SESSION_REQUIRED",
        "Sign in as the workspace owner to access development workflows.",
      );
    return actor;
  };
  const id = (value: string) => {
    if (!developmentInputSchema.shape.requestId.safeParse(value).success)
      throw new HttpError(
        404,
        "DEVELOPMENT_NOT_FOUND",
        "This development run does not exist.",
      );
    return value;
  };
  app.get("/v1/development/runtime", async (request) => {
    owner(request);
    const runtime = await options.repository().runtime(options.defaultModel);
    if (!runtime.ready) return runtime;
    try {
      const models = await options.models();
      if (
        !models.some(
          (model) =>
            model.name === runtime.defaultModel &&
            model.capabilities.includes("completion"),
        )
      )
        return {
          ...runtime,
          ready: false,
          reason:
            "The default local development model is not installed or eligible. Refresh Model control and the runner readiness.",
        };
      return runtime;
    } catch {
      return {
        ...runtime,
        ready: false,
        reason:
          "The local Ollama service could not be inspected. No cloud or host execution fallback is available.",
      };
    }
  });
  app.get("/v1/development", async (request) => {
    owner(request);
    return { runs: await options.repository().list() };
  });
  app.post(
    "/v1/development",
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      const actor = owner(request);
      const input = developmentInputSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide a request UUID, title, bounded task brief, installed local model and optional public Vuzmi issue number.",
        );
      const repository = options.repository();
      const previous = await repository.findRequest(
        "local-workspace",
        input.data,
        actor.id,
      );
      if (previous) return { run: previous, replayed: true };
      const runtime = await repository.runtime(options.defaultModel);
      if (!runtime.ready || !runtime.profile)
        throw new HttpError(
          503,
          "DEVELOPMENT_UNAVAILABLE",
          runtime.reason ??
            "The fixed isolated development runner is unavailable.",
        );
      let eligible = false;
      try {
        eligible = (await options.models()).some(
          (model) =>
            model.name === input.data.model &&
            model.capabilities.includes("completion"),
        );
      } catch {}
      if (!eligible)
        throw new HttpError(
          503,
          "DEVELOPMENT_MODEL_UNAVAILABLE",
          "The selected local development model is unavailable or ineligible. No cloud fallback was attempted.",
        );
      const issue = input.data.issueNumber
        ? await github.issue(input.data.issueNumber)
        : null;
      const result = await repository.create(input.data, {
        id: randomUUID(),
        actor: actor.id,
        profile: runtime.profile,
        issue,
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/development/:id",
    async (request) => {
      owner(request);
      const run = await options
        .repository()
        .get("local-workspace", id(request.params.id));
      if (!run)
        throw new HttpError(
          404,
          "DEVELOPMENT_NOT_FOUND",
          "This development run does not exist.",
        );
      return { run };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/development/:id/decisions",
    async (request) => {
      const actor = owner(request);
      const input = decisionSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide the decision and exact reviewed development revision/fingerprint.",
        );
      return {
        run: await options
          .repository()
          .decide("local-workspace", id(request.params.id), input.data, actor),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/development/:id/package",
    async (request, reply) => {
      owner(request);
      const runId = id(request.params.id);
      const artifact = await options
        .repository()
        .package("local-workspace", runId);
      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="vuzmi-development-${runId}-${artifact.sha256.slice(0, 12)}.json"`,
        )
        .header("X-Content-SHA256", artifact.sha256)
        .send(artifact.content);
    },
  );
}
