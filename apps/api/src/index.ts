import { buildApp } from "./app.js";
import { loadServerConfig } from "@vuzmi/runtime/config";
import { AuthService } from "@vuzmi/auth";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

let auth: AuthService | undefined;
let app: FastifyInstance | undefined;
try {
  const config = loadServerConfig();
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (
    process.env.VUZMI_SERVE_WEB === "1" &&
    (!config.authRequired || !config.databaseUrl)
  ) {
    throw new Error(
      "The built self-host service requires owner authentication and PostgreSQL.",
    );
  }
  if (
    config.authRequired &&
    (!config.databaseUrl || !config.authSecret || !config.ownerSetupKey)
  ) {
    throw new Error(
      "Owner authentication requires PostgreSQL and private authentication configuration. Run services:start first.",
    );
  }
  auth = config.authRequired
    ? await AuthService.connect({
        connectionString: config.databaseUrl!,
        baseUrl: config.publicUrl,
        secret: config.authSecret!,
        setupToken: config.ownerSetupKey!,
      })
    : undefined;
  app = await buildApp({
    ...config,
    auth,
    authBaseUrl: config.publicUrl,
    webRoot:
      process.env.VUZMI_SERVE_WEB === "1"
        ? fileURLToPath(new URL("../../web/dist/", import.meta.url))
        : undefined,
    dataDir: process.env.VUZMI_DATA_DIR,
  });
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void app!.close().then(
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
  await app?.close().catch(() => undefined);
  await auth?.close().catch(() => undefined);
  console.error(
    "Vuzmi local API could not start. Check the loopback port, private configuration, database availability, and migration compatibility.",
  );
  process.exitCode = 1;
}
