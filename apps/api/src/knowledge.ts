import type { FastifyInstance } from "fastify";
import {
  sourceInputSchema,
  sourceUpdateSchema,
  memoryInputSchema,
  memoryUpdateSchema,
  searchKnowledgeSchema,
} from "@vuzmi/core";
import type { EmbeddingProfile, KnowledgeSnapshot } from "@vuzmi/core";
import {
  discoverEmbeddingProfile,
  embedLocal,
  ProviderError,
} from "@vuzmi/providers";
import type { KnowledgeEmbedder, PostgresRunRepository } from "@vuzmi/runtime";
import { HttpError } from "./errors.js";

export interface KnowledgeRouteOptions {
  repository?: PostgresRunRepository;
  ollamaBaseUrl?: string;
  ollamaEmbeddingModel?: string;
  discoverProfile?: typeof discoverEmbeddingProfile;
  embed?: KnowledgeEmbedder;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: KnowledgeRouteOptions,
): void {
  const model = options.ollamaEmbeddingModel ?? "embeddinggemma:300m";
  const discover = options.discoverProfile ?? discoverEmbeddingProfile;
  const embed: KnowledgeEmbedder =
    options.embed ??
    (async ({ texts, kind, title, signal }) => {
      const profile = await discover({
        model,
        baseUrl: options.ollamaBaseUrl,
        signal,
      });
      const result = await embedLocal({
        profile,
        purpose: kind,
        inputs: texts.map((text) => ({ text, title })),
        baseUrl: options.ollamaBaseUrl,
        signal,
      });
      return { profile, vectors: result.vectors };
    });
  const knowledge = () => {
    if (!options.repository)
      throw new HttpError(
        503,
        "KNOWLEDGE_NOT_CONFIGURED",
        "Knowledge and memory require PostgreSQL. Start the local services and worker; simulation remains available separately.",
      );
    return options.repository.knowledge;
  };
  app.get("/v1/knowledge", async (): Promise<KnowledgeSnapshot> => {
    const repository = knowledge();
    const [sources, memories] = await Promise.all([
      repository.listSources(),
      repository.listMemories(),
    ]);
    let profile: EmbeddingProfile | null = null;
    let error: string | null = null;
    try {
      profile = await discover({ model, baseUrl: options.ollamaBaseUrl });
    } catch (cause) {
      error =
        cause instanceof ProviderError
          ? cause.message
          : "The configured local embedding model could not be inspected.";
    }
    return {
      sources,
      memories,
      embedding: { model, profile, available: profile !== null, error },
    };
  });
  app.get<{ Params: { id: string } }>(
    "/v1/knowledge/sources/:id",
    async (request) => {
      const detail = await knowledge().getSource(
        "local-workspace",
        request.params.id,
      );
      if (!detail)
        throw new HttpError(
          404,
          "SOURCE_NOT_FOUND",
          "This source is unavailable in the local workspace.",
        );
      return detail;
    },
  );
  app.post(
    "/v1/knowledge/sources",
    { bodyLimit: 160 * 1024 },
    async (request, reply) => {
      const input = sourceInputSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide a source title and plain text or Markdown between 10 characters and 64 KiB.",
        );
      const source = await knowledge().createSource(
        "local-workspace",
        input.data,
      );
      return reply.code(202).send({ source });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/v1/knowledge/sources/:id",
    { bodyLimit: 160 * 1024 },
    async (request, reply) => {
      const input = sourceUpdateSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide the current revision, source title, format, and bounded text.",
        );
      const source = await knowledge().updateSource(
        "local-workspace",
        request.params.id,
        input.data,
      );
      return reply.code(202).send({ source });
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/knowledge/sources/:id",
    async (request) => {
      await knowledge().deleteSource("local-workspace", request.params.id);
      return { deleted: true, id: request.params.id };
    },
  );
  app.post("/v1/knowledge/search", async (request) => {
    const input = searchKnowledgeSchema.safeParse(request.body);
    if (!input.success)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Enter a query and select at least one source or memory without duplicate selections.",
      );
    return {
      result: await knowledge().search(
        input.data.selection,
        input.data.query,
        embed,
      ),
    };
  });
  app.post("/v1/knowledge/memories", async (request, reply) => {
    const input = memoryInputSchema.safeParse(request.body);
    if (!input.success)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Provide a memory title, a bounded fact, valid provenance, and optional expiry.",
      );
    return reply.code(201).send({
      memory: await knowledge().createMemory("local-workspace", input.data),
    });
  });
  app.patch<{ Params: { id: string } }>(
    "/v1/knowledge/memories/:id",
    async (request) => {
      const input = memoryUpdateSchema.safeParse(request.body);
      if (!input.success)
        throw new HttpError(
          400,
          "INVALID_INPUT",
          "Provide the current memory revision, title, fact, provenance, and expiry.",
        );
      return {
        memory: await knowledge().updateMemory(
          "local-workspace",
          request.params.id,
          input.data,
        ),
      };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/knowledge/memories/:id",
    async (request) => {
      await knowledge().deleteMemory("local-workspace", request.params.id);
      return { deleted: true, id: request.params.id };
    },
  );
}
