import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(new URL("../.env", import.meta.url)))
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
if (
  process.env.VUZMI_DEV_NO_AUTH === "1" ||
  process.env.VUZMI_SIMULATION_ONLY === "1"
)
  throw new Error(
    "The self-host command requires owner authentication and PostgreSQL. Use dev:simulation for explicit UI development.",
  );
if (!existsSync(new URL("../apps/web/dist/index.html", import.meta.url)))
  throw new Error("Build the web client first with npm run build.");
const port = process.env.PORT ?? "4310";
const env = {
  ...process.env,
  NODE_ENV: "production",
  VUZMI_SERVE_WEB: "1",
  VUZMI_PUBLIC_URL: process.env.VUZMI_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
};
const children = [];
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}
for (const path of ["apps/api/src/index.ts", "apps/worker/src/index.ts"]) {
  const child = spawn(process.execPath, ["--import", "tsx", path], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  children.push(child);
  child.once("error", () => {
    process.exitCode = 1;
    stop();
  });
  child.once("exit", (code, signal) => {
    if (!stopping) {
      process.exitCode = code || 1;
      stop();
    }
  });
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop());
console.info(
  "Vuzmi self-host processes started on loopback; PostgreSQL and local Ollama must already be running.",
);
