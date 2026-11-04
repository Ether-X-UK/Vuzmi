import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { root } from "./dev-services.mjs";

export class RecoveryError extends Error {}
export const fail = (message) => {
  throw new RecoveryError(message);
};
export function identifier(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value))
    fail("Configure a valid lowercase database schema name.");
  return `"${value}"`;
}
export function privateDirectory(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    info.uid !== process.getuid()
  )
    fail(
      "Backup directories must be owned by the current user with permissions 0700 and must not be symlinks.",
    );
}
export function privateFile(path, maxBytes = Number.MAX_SAFE_INTEGER) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.uid !== process.getuid() ||
      info.size > maxBytes
    )
      fail(
        "Backup files must be owned by the current user, bounded, regular files with permissions 0600.",
      );
    return {
      data:
        maxBytes < Number.MAX_SAFE_INTEGER
          ? readFileSync(descriptor)
          : undefined,
      size: info.size,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function connectionEnvironment(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail("Configure an explicit PostgreSQL connection URL in the environment.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    parsed.pathname.length < 2 ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some((key) => key !== "sslmode") ||
    parsed.searchParams.getAll("sslmode").length > 1
  )
    fail(
      "Use a PostgreSQL URL with explicit host, user, database, and optional sslmode only.",
    );
  try {
    return {
      PGHOST: parsed.hostname.replace(/^\[|\]$/g, ""),
      PGPORT: parsed.port || "5432",
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
      PGSSLMODE: parsed.searchParams.get("sslmode") ?? "prefer",
    };
  } catch {
    fail("The PostgreSQL connection URL could not be read.");
  }
}
export function native(command, args, databaseUrl) {
  const connection = databaseUrl ? connectionEnvironment(databaseUrl) : {};
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
  );
  const result = spawnSync(command, args, {
    // Connection strings stay out of process arguments and all output/errors.
    env: {
      ...environment,
      ...connection,
      PGPASSFILE: "/dev/null",
      PGCONNECT_TIMEOUT: "10",
      PGAPPNAME: "vuzmi-recovery",
    },
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0)
    fail(
      "A native PostgreSQL operation failed. No connection details or database output were printed. Check PostgreSQL 16 tools, connectivity, disk space, privileges, and the private target before retrying.",
    );
  return result.stdout;
}
export async function connectDatabase(databaseUrl) {
  connectionEnvironment(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    application_name: "vuzmi-recovery",
  });
  client.on("error", () => undefined); // Operational errors are reported through sanitized command results.
  try {
    await client.connect();
    const version = await client.query("SHOW server_version_num");
    if (Math.floor(Number(version.rows[0].server_version_num) / 10_000) !== 16)
      fail("This native recovery increment supports PostgreSQL 16 only.");
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    if (error instanceof RecoveryError) throw error;
    fail(
      "The configured PostgreSQL database could not be inspected. No connection details were printed.",
    );
  }
}
export function checkNativeVersion(command) {
  if (!/\(PostgreSQL\) 16\./.test(native(command, ["--version"])))
    fail(
      "Use PostgreSQL 16 native dump/restore binaries for this recovery increment.",
    );
}
export function loadPrivateEnvironment() {
  for (const relative of [".env", ".data/dev/database.env"]) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    if (relative.startsWith(".data/")) privateFile(path, 16_384);
    process.loadEnvFile(path);
  }
}

/** Whole-database snapshot; no application, worker, inference, or remote storage starts. */
export async function backupDatabase({
  databaseUrl,
  authSecret,
  directory = join(root, ".data/backups"),
  queueSchema = "vuzmi_queue",
  runtimeSchema = "vuzmi",
}) {
  identifier(queueSchema);
  identifier(runtimeSchema);
  if (
    typeof authSecret !== "string" ||
    authSecret.trim().length < 32 ||
    Buffer.byteLength(authSecret) > 8192
  )
    fail(
      "A recoverable backup requires the original private authentication secret.",
    );
  checkNativeVersion("pg_dump");
  const client = await connectDatabase(databaseUrl);
  let bundle;
  try {
    const queue = await client.query(
      "SELECT to_regclass($1)::text AS table_name",
      [`${queueSchema}.job`],
    );
    if (!queue.rows[0]?.table_name)
      fail(
        "The configured Vuzmi queue schema was not found. Configure the source queue schema explicitly.",
      );
    const runtime = await client.query(
      "SELECT to_regclass($1)::text AS table_name",
      [`${runtimeSchema}.worker_heartbeats`],
    );
    if (!runtime.rows[0]?.table_name)
      fail(
        "The configured Vuzmi runtime schema was not found. Configure the source runtime schema explicitly.",
      );
    privateDirectory(resolve(directory), true);
    bundle = mkdtempSync(
      join(
        resolve(directory),
        `backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-`,
      ),
    );
    privateDirectory(bundle);
    const dump = join(bundle, "database.dump");
    writeFileSync(dump, "", { mode: 0o600, flag: "wx" });
    native(
      "pg_dump",
      ["--format=custom", "--no-password", "--file", dump],
      databaseUrl,
    );
    privateFile(dump);
    writeFileSync(join(bundle, "auth-secret"), authSecret, {
      mode: 0o600,
      flag: "wx",
    });
    const files = {};
    for (const name of ["database.dump", "auth-secret"]) {
      const path = join(bundle, name);
      files[name] = {
        bytes: statSync(path).size,
        sha256: await fileHash(path),
      };
    }
    const manifest = {
      format: "vuzmi-native-backup-v1",
      createdAt: new Date().toISOString(),
      postgresMajor: 16,
      queueSchema,
      runtimeSchema,
      encrypted: false,
      files,
    };
    // Manifest creation marks a complete bundle. Interrupted bundles lack it.
    writeFileSync(
      join(bundle, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return { bundle };
  } catch (error) {
    if (bundle) rmSync(bundle, { recursive: true, force: true });
    if (error instanceof RecoveryError) throw error;
    fail(
      "Backup creation failed. The incomplete private bundle was removed; no database content or secrets were printed.",
    );
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (process.argv.length !== 2)
      fail(
        "Usage: node scripts/backup.mjs. Configure DATABASE_URL, BETTER_AUTH_SECRET or the private local auth-secret file, and optional VUZMI_BACKUP_DIR.",
      );
    loadPrivateEnvironment();
    const authSecret =
      process.env.BETTER_AUTH_SECRET ??
      privateFile(join(root, ".data/dev/auth-secret"), 8192)
        .data.toString("utf8")
        .trim();
    const result = await backupDatabase({
      databaseUrl: process.env.DATABASE_URL,
      authSecret,
      directory: process.env.VUZMI_BACKUP_DIR,
      queueSchema: process.env.VUZMI_QUEUE_SCHEMA,
      runtimeSchema: process.env.VUZMI_RUNTIME_SCHEMA,
    });
    console.info(`Private backup completed: ${result.bundle}`);
    console.info(
      "Contains database content, session state, and the auth secret. This bundle is not encrypted; protect it as a whole.",
    );
  } catch (error) {
    console.error(
      error instanceof RecoveryError
        ? error.message
        : "Backup failed. Check private configuration and permissions; no secrets were printed.",
    );
    process.exitCode = 1;
  }
}
