import { buildApp } from "./app.js";

try {
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const app = await buildApp({ dataDir: process.env.VUZMI_DATA_DIR });
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
    `Vuzmi local simulation API: http://127.0.0.1:${port} — no provider calls or external actions.`,
  );
} catch (error) {
  console.error(
    "Vuzmi local API could not start:",
    error instanceof Error ? error.message : "Unknown startup failure",
  );
  process.exitCode = 1;
}
