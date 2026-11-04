import type { FastifyInstance } from "fastify";
import {
  approvedPackageFilename,
  approvedPackageSummary,
  createApprovedPackage,
  OutboxError,
} from "@vuzmi/core";
import type { OutboxSnapshot, Run } from "@vuzmi/core";
import { HttpError } from "./errors.js";

export interface OutboxRouteOptions {
  listRuns: () => Promise<Run[]>;
  getRun: (id: string) => Promise<Run | undefined>;
}

async function packageFor(run: Run) {
  try {
    return await createApprovedPackage(run);
  } catch (error) {
    if (error instanceof OutboxError)
      throw new HttpError(error.statusCode, error.code, error.message);
    throw error;
  }
}

export function registerOutboxRoutes(
  app: FastifyInstance,
  options: OutboxRouteOptions,
): void {
  app.get("/v1/outbox", async (): Promise<OutboxSnapshot> => {
    const runs = (await options.listRuns())
      .filter(
        (run) =>
          run.workspaceId === "local-workspace" && run.status === "completed",
      )
      .sort(
        (a, b) =>
          (b.decision?.decidedAt ?? "").localeCompare(
            a.decision?.decidedAt ?? "",
          ) || a.id.localeCompare(b.id),
      );
    return {
      items: await Promise.all(
        runs.map(async (run) => approvedPackageSummary(await packageFor(run))),
      ),
    };
  });
  app.get<{ Params: { runId: string } }>(
    "/v1/outbox/:runId",
    async (request, reply) => {
      const run = await options.getRun(request.params.runId);
      if (!run || run.workspaceId !== "local-workspace")
        throw new HttpError(
          404,
          "RUN_NOT_FOUND",
          "This run does not exist in the local workspace.",
        );
      const value = await packageFor(run);
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `attachment; filename="${approvedPackageFilename(value)}"`,
        )
        .type("application/json; charset=utf-8")
        .send(JSON.stringify(value, null, 2) + "\n");
    },
  );
}
