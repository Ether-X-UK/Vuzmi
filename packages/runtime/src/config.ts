import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);

export function loadServerConfig(): {
  databaseUrl?: string;
  ollamaBaseUrl: string;
  ollamaModel?: string;
} {
  // Node's loader preserves explicitly exported variables. Secrets stay server-side.
  for (const relative of [".env", ".data/dev/database.env"]) {
    const path = fileURLToPath(new URL(relative, `file://${repositoryRoot}`));
    if (!existsSync(path)) continue;
    if (relative.includes(".data") && (statSync(path).mode & 0o077) !== 0)
      throw new Error(
        "Local database configuration must have permissions 0600.",
      );
    process.loadEnvFile(path);
  }
  return {
    databaseUrl:
      process.env.VUZMI_SIMULATION_ONLY === "1"
        ? undefined
        : process.env.DATABASE_URL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11435",
    ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3.5:4b",
  };
}
