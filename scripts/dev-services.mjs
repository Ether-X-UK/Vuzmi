import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
const devDir = join(root, ".data", "dev");

function run(command, args, { env = process.env, input, quiet = false } = {}) {
  const result = spawnSync(command, args, { env, input, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    // Never print SQL input, connection URLs, or child environment values.
    throw new Error(
      `${command} failed. ${quiet ? "Check the private local database configuration." : (result.error?.message ?? result.stderr?.trim() ?? "Check the private service log.")}`,
    );
  }
  return result.stdout.trim();
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error(
      `The local service directory must be private (0700): ${path}`,
    );
}

export function startPostgres(stateDir, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid local PostgreSQL port.");
  privateDirectory(stateDir);
  const credentialsPath = join(stateDir, "credentials.json");
  const dataDir = join(stateDir, "pgdata");
  let credentials;
  if (existsSync(credentialsPath)) {
    if ((statSync(credentialsPath).mode & 0o077) !== 0)
      throw new Error("Local database credentials must have permissions 0600.");
    credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } else {
    if (existsSync(join(dataDir, "PG_VERSION")))
      throw new Error(
        "Existing PostgreSQL data has no matching credential file; refusing to alter it.",
      );
    credentials = {
      admin: randomBytes(24).toString("hex"),
      application: randomBytes(24).toString("hex"),
    };
    writeFileSync(credentialsPath, JSON.stringify(credentials), {
      mode: 0o600,
      flag: "wx",
    });
  }
  if (
    !/^[a-f0-9]{48}$/.test(credentials.admin) ||
    !/^[a-f0-9]{48}$/.test(credentials.application)
  )
    throw new Error("Invalid local database credential format.");
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    const passwordFile = join(stateDir, "init-password");
    writeFileSync(passwordFile, credentials.admin, { mode: 0o600 });
    try {
      run("initdb", [
        "-D",
        dataDir,
        "-U",
        "vuzmi_admin",
        `--pwfile=${passwordFile}`,
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256",
        "--no-locale",
        "--encoding=UTF8",
      ]);
    } finally {
      rmSync(passwordFile, { force: true });
    }
  }
  const status = spawnSync("pg_ctl", ["-D", dataDir, "status"], {
    encoding: "utf8",
  });
  if (status.status !== 0)
    run("pg_ctl", [
      "-D",
      dataDir,
      "-l",
      join(stateDir, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ''`,
      "start",
      "-w",
    ]);
  const env = {
    ...process.env,
    PGHOST: "127.0.0.1",
    PGPORT: String(port),
    PGUSER: "vuzmi_admin",
    PGPASSWORD: credentials.admin,
    PGDATABASE: "postgres",
  };
  const roleExists = run(
    "psql",
    ["-X", "-tAc", "SELECT 1 FROM pg_roles WHERE rolname = 'vuzmi'"],
    { env, quiet: true },
  );
  if (roleExists !== "1")
    run("psql", ["-X", "-v", "ON_ERROR_STOP=1"], {
      env,
      quiet: true,
      input: `CREATE ROLE vuzmi LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${credentials.application}';`,
    });
  const databaseExists = run(
    "psql",
    ["-X", "-tAc", "SELECT 1 FROM pg_database WHERE datname = 'vuzmi'"],
    { env, quiet: true },
  );
  if (databaseExists !== "1")
    run("createdb", ["-O", "vuzmi", "vuzmi"], { env, quiet: true });
  return `postgresql://vuzmi:${credentials.application}@127.0.0.1:${port}/vuzmi`;
}

export function stopPostgres(stateDir) {
  const dataDir = join(stateDir, "pgdata");
  if (!existsSync(join(dataDir, "postmaster.pid"))) return;
  run("pg_ctl", ["-D", dataDir, "-m", "fast", "stop", "-w"]);
}

const ollamaRecordPath = join(devDir, "ollama-process.json");
function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

async function startOllama() {
  if (
    process.env.OLLAMA_BASE_URL &&
    process.env.OLLAMA_BASE_URL !== "http://127.0.0.1:11435"
  )
    return false;
  if (existsSync(ollamaRecordPath)) {
    const record = JSON.parse(readFileSync(ollamaRecordPath, "utf8"));
    if (processIdentity(record.pid) === record.identity) {
      const response = await fetch("http://127.0.0.1:11435/api/version", {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok)
        throw new Error(
          "The Vuzmi Ollama process is running but not ready. Inspect the private service log.",
        );
      return true;
    }
  }
  try {
    const response = await fetch("http://127.0.0.1:11435/api/version", {
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok)
      throw new Error(
        "Port 11435 is already in use by an unmanaged Ollama service. Configure OLLAMA_BASE_URL explicitly or stop that test service first.",
      );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Port 11435"))
      throw error;
  }
  const log = openSync(join(devDir, "ollama.log"), "a", 0o600);
  const child = spawn("ollama", ["serve"], {
    env: {
      ...process.env,
      OLLAMA_HOST: "127.0.0.1:11435",
      OLLAMA_NO_CLOUD: "1",
      OLLAMA_NUM_PARALLEL: "1",
    },
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.on("error", () => undefined);
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:11435/api/version", {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok && child.pid) {
        const identity = processIdentity(child.pid);
        if (!identity)
          throw new Error("The Vuzmi Ollama process did not stay running.");
        writeFileSync(
          ollamaRecordPath,
          JSON.stringify({ pid: child.pid, identity }),
          { mode: 0o600 },
        );
        return true;
      }
    } catch {
      /* The child may still be starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    "The local Ollama service did not become ready. Inspect the private .data/dev/ollama.log.",
  );
}

function stopOllama() {
  if (!existsSync(ollamaRecordPath)) return;
  const record = JSON.parse(readFileSync(ollamaRecordPath, "utf8"));
  if (processIdentity(record.pid) === record.identity)
    process.kill(record.pid, "SIGTERM");
  rmSync(ollamaRecordPath, { force: true });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const envPath = join(root, ".env");
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    if (process.argv[2] === "stop") {
      stopPostgres(devDir);
      stopOllama();
      console.info("Vuzmi-owned local services stopped.");
    } else {
      privateDirectory(join(root, ".data"));
      const databaseUrl = startPostgres(devDir, 55432);
      writeFileSync(
        join(devDir, "database.env"),
        `DATABASE_URL=${databaseUrl}\n`,
        { mode: 0o600 },
      );
      const ownsOllama = await startOllama();
      console.info("Private PostgreSQL ready on 127.0.0.1:55432.");
      console.info(
        ownsOllama
          ? "Vuzmi Ollama ready on 127.0.0.1:11435; cloud features disabled."
          : "A custom Ollama endpoint is configured. Its readiness and cloud-disable setting are operator-managed; startup has not verified them.",
      );
      console.info(
        "Local credentials are stored only in ignored, private .data/dev files. No models are downloaded automatically.",
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Local service startup failed.",
    );
    process.exitCode = 1;
  }
}
