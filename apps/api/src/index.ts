import { buildApp } from "./app.js";
import { loadServerConfig } from "@vuzmi/runtime/config";

try {
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const config = loadServerConfig();
  const app = await buildApp({
    ...config,
    dataDir: process.env.VUZMI_DATA_DIR,
  });
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await app.listen({ host: "127.0.0.1", port });
  console.info(
    `Vuzmi local API: http://127.0.0.1:${port} — ${config.databaseUrl ? "PostgreSQL execution" : "file-backed simulation"}; external actions disabled.`,
  );
} catch {
  console.error(
    "Vuzmi local API could not start. Check the loopback port, private configuration, database availability, and migration compatibility.",
  );
  process.exitCode = 1;
}
