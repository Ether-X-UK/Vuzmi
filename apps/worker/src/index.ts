import {
  discoverEmbeddingProfile,
  embedLocal,
  generateReleaseBrief,
  generateDevelopmentPatch,
} from "@vuzmi/providers";
import {
  PostgresRunRepository,
  startWorker,
  startDevelopmentWorker,
  createDevelopmentRunner,
  createDevelopmentGitConnector,
  startDevelopmentApplicationWorker,
} from "@vuzmi/runtime";
import { loadServerConfig } from "@vuzmi/runtime/config";

const config = loadServerConfig();
if (!config.databaseUrl)
  throw new Error(
    "The local worker requires PostgreSQL configuration. No database is configured.",
  );

let repository: PostgresRunRepository | undefined;
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let developmentWorker:
  Awaited<ReturnType<typeof startDevelopmentWorker>> | undefined;
let applicationWorker:
  Awaited<ReturnType<typeof startDevelopmentApplicationWorker>> | undefined;
try {
  repository = await PostgresRunRepository.connect({
    connectionString: config.databaseUrl,
  });
  worker = await startWorker({
    repository,
    generate: (input) =>
      generateReleaseBrief({ ...input, baseUrl: config.ollamaBaseUrl }),
    embed: async ({ texts, kind, title, signal }) => {
      const profile = await discoverEmbeddingProfile({
        baseUrl: config.ollamaBaseUrl,
        model: config.ollamaEmbeddingModel,
        signal,
      });
      const result = await embedLocal({
        profile,
        purpose: kind,
        inputs: texts.map((text) => ({ text, title })),
        baseUrl: config.ollamaBaseUrl,
        signal,
      });
      return { profile, vectors: result.vectors };
    },
    onError: () =>
      console.error(
        "A local worker operation failed. Inspect the run ledger and local dependency health.",
      ),
  });
  developmentWorker = await startDevelopmentWorker({
    repository,
    runner: createDevelopmentRunner(),
    generate: (input) =>
      generateDevelopmentPatch({ ...input, baseUrl: config.ollamaBaseUrl }),
    onError: () =>
      console.error(
        "A bounded development operation failed. Inspect its persisted attempt and isolated runner readiness.",
      ),
  });
  applicationWorker = await startDevelopmentApplicationWorker({
    repository,
    connector: createDevelopmentGitConnector(),
    onError: () =>
      console.error(
        "A local branch operation needs inspection. Consult its retained application record.",
      ),
  });
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void Promise.all([
      worker!.stop(),
      developmentWorker!.stop(),
      applicationWorker!.stop(),
    ])
      .then(() => repository!.close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  console.info(
    "Vuzmi local Ollama worker is ready. Cloud execution is disabled.",
  );
} catch (error) {
  await applicationWorker?.stop().catch(() => undefined);
  await developmentWorker?.stop().catch(() => undefined);
  await worker?.stop().catch(() => undefined);
  await repository?.close().catch(() => undefined);
  console.error(
    "Vuzmi worker could not start:",
    error instanceof Error ? error.message : "Unknown startup failure",
  );
  process.exitCode = 1;
}
