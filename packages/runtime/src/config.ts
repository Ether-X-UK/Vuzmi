import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);

export function loadServerConfig(): {
  databaseUrl?: string;
  ollamaBaseUrl: string;
  ollamaModel?: string;
  ollamaEmbeddingModel: string;
  authRequired: boolean;
  publicUrl: string;
  authSecret?: string;
  ownerSetupKey?: string;
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
  const privateValue = (
    environment: string,
    relative: string,
  ): string | undefined => {
    if (process.env[environment]) return process.env[environment];
    const path = fileURLToPath(new URL(relative, `file://${repositoryRoot}`));
    if (!existsSync(path)) return undefined;
    if ((statSync(path).mode & 0o077) !== 0)
      throw new Error("Local authentication files must have permissions 0600.");
    return readFileSync(path, "utf8").trim();
  };
  return {
    databaseUrl:
      process.env.VUZMI_SIMULATION_ONLY === "1"
        ? undefined
        : process.env.DATABASE_URL,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11435",
    ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3.5:4b",
    ollamaEmbeddingModel:
      process.env.OLLAMA_EMBEDDING_MODEL ?? "embeddinggemma:300m",
    authRequired: process.env.VUZMI_DEV_NO_AUTH !== "1",
    publicUrl: process.env.VUZMI_PUBLIC_URL ?? "http://127.0.0.1:5173",
    authSecret: privateValue("BETTER_AUTH_SECRET", ".data/dev/auth-secret"),
    ownerSetupKey: privateValue(
      "VUZMI_OWNER_SETUP_KEY",
      ".data/dev/owner-setup-key",
    ),
  };
}
