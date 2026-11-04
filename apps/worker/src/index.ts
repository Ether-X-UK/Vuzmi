import { generateReleaseBrief } from "@vuzmi/providers";
import { PostgresRunRepository, startWorker } from "@vuzmi/runtime";
import { loadServerConfig } from "@vuzmi/runtime/config";

const config = loadServerConfig();
if (!config.databaseUrl)
  throw new Error(
    "The local worker requires PostgreSQL configuration. No database is configured.",
  );

let repository: PostgresRunRepository | undefined;
try {
  repository = await PostgresRunRepository.connect({
    connectionString: config.databaseUrl,
  });
  const worker = await startWorker({
    repository,
    generate: (input) =>
      generateReleaseBrief({ ...input, baseUrl: config.ollamaBaseUrl }),
    onError: () =>
      console.error(
        "A local worker operation failed. Inspect the run ledger and local dependency health.",
      ),
  });
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void worker
      .stop()
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
  await repository?.close().catch(() => undefined);
  console.error(
    "Vuzmi worker could not start:",
    error instanceof Error ? error.message : "Unknown startup failure",
  );
  process.exitCode = 1;
}
