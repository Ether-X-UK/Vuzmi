import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkNativeVersion,
  connectDatabase,
  fail,
  fileHash,
  identifier,
  loadPrivateEnvironment,
  native,
  privateDirectory,
  privateFile,
  RecoveryError,
} from "./backup.mjs";

const emptyDatabaseSql = `SELECT
  EXISTS (SELECT 1 FROM pg_namespace WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname !~ '^pg_')
  OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))
  OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
    AND NOT EXISTS (SELECT 1 FROM pg_type base JOIN pg_depend d ON d.classid='pg_type'::regclass AND d.objid=base.oid AND d.deptype='e' WHERE base.typarray=t.oid))
  OR EXISTS (SELECT 1 FROM pg_extension WHERE extname NOT IN ('plpgsql','vector'))
  OR EXISTS (SELECT 1 FROM pg_largeobject_metadata)
  OR EXISTS (SELECT 1 FROM pg_foreign_server)
  OR EXISTS (SELECT 1 FROM pg_publication)
  OR EXISTS (SELECT 1 FROM pg_event_trigger) AS occupied`;

function endpoint(value) {
  try {
    const url = new URL(value);
    return JSON.stringify([
      url.hostname.toLowerCase(),
      url.port || "5432",
      decodeURIComponent(url.pathname),
    ]);
  } catch {
    fail(
      "Configure valid, separately specified source and restore target URLs.",
    );
  }
}

export async function inspectBundle(directory) {
  const bundle = resolve(directory);
  privateDirectory(bundle);
  let manifest;
  try {
    manifest = JSON.parse(
      privateFile(join(bundle, "manifest.json"), 16_384).data.toString("utf8"),
    );
  } catch {
    fail(
      "The private backup manifest is missing or invalid. Only completed Vuzmi backup bundles can be restored.",
    );
  }
  if (
    manifest?.format !== "vuzmi-native-backup-v1" ||
    manifest.postgresMajor !== 16 ||
    manifest.encrypted !== false
  )
    fail("The backup format or PostgreSQL version is unsupported.");
  identifier(manifest.queueSchema);
  identifier(manifest.runtimeSchema);
  for (const name of ["database.dump", "auth-secret"]) {
    const expected = manifest.files?.[name];
    const actual = privateFile(
      join(bundle, name),
      name === "auth-secret" ? 8192 : Number.MAX_SAFE_INTEGER,
    );
    if (
      !expected ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      expected.bytes !== actual.size ||
      (await fileHash(join(bundle, name))) !== expected.sha256
    )
      fail(
        "The backup is incomplete or its checksum does not match. No restore was attempted.",
      );
  }
  const secret = privateFile(join(bundle, "auth-secret"), 8192)
    .data.toString("utf8")
    .trim();
  if (secret.length < 32) fail("The backup authentication secret is invalid.");
  native("pg_restore", ["--list", join(bundle, "database.dump")]);
  return { bundle, manifest };
}

/** Restores only to an explicit empty database. Never drops/cleans/recreates it. */
export async function restoreDatabase({
  directory,
  targetDatabaseUrl,
  sourceDatabaseUrl,
}) {
  if (!targetDatabaseUrl || !directory)
    fail(
      "Provide a backup bundle and a separately configured VUZMI_RESTORE_DATABASE_URL. DATABASE_URL is never a restore fallback.",
    );
  if (
    sourceDatabaseUrl &&
    endpoint(sourceDatabaseUrl) === endpoint(targetDatabaseUrl)
  )
    fail("The restore target must differ from the configured source database.");
  checkNativeVersion("pg_restore");
  const { bundle, manifest } = await inspectBundle(directory);
  const client = await connectDatabase(targetDatabaseUrl);
  try {
    const identity = await client.query(
      "SELECT current_database() AS name,pg_try_advisory_lock(hashtext($1)) AS locked",
      ["vuzmi:private-restore"],
    );
    if (
      !identity.rows[0].locked ||
      ["postgres", "template0", "template1"].includes(identity.rows[0].name)
    )
      fail(
        "Use an explicitly provisioned, private empty application database with no other restore in progress.",
      );
    if ((await client.query(emptyDatabaseSql)).rows[0].occupied)
      fail(
        "Restore refused: the target contains application objects or data. Nothing was removed or overwritten. Provision a different empty target.",
      );
    const connections = await client.query(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND backend_type=$1 AND pid<>pg_backend_pid()",
      ["client backend"],
    );
    if (connections.rows[0].count !== 0)
      fail(
        "Restore refused: other clients are connected to the target. Keep application services stopped and use an isolated empty target.",
      );
    // No --clean, --create, SQL-file execution, or URL-bearing process argument.
    const databaseName = decodeURIComponent(
      new URL(targetDatabaseUrl).pathname.slice(1),
    );
    native(
      "pg_restore",
      [
        "--dbname",
        databaseName,
        "--no-password",
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--no-comments",
        "--exit-on-error",
        join(bundle, "database.dump"),
      ],
      targetDatabaseUrl,
    );
    const queue = identifier(manifest.queueSchema);
    const runtime = identifier(manifest.runtimeSchema);
    // Recovery starts paused. Keep original business records and exact evidence,
    // but quarantine jobs so starting a worker cannot replay old inference.
    await client.query("BEGIN");
    try {
      await client.query(
        `UPDATE ${queue}.job SET state='cancelled',completed_on=now()
        WHERE name=ANY($1::text[]) AND state IN ('created','retry','active')`,
        [["vuzmi-generate-release", "vuzmi-index-source"]],
      );
      await client.query(`DELETE FROM ${runtime}.worker_heartbeats`);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      fail(
        "The database was restored but recovery quarantine could not complete. Keep all services stopped and inspect the private target; do not rerun restore into this nonempty database.",
      );
    }
    return { authSecretPath: join(bundle, "auth-secret") };
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    fail(
      "Restore failed. No services were started and no database details were printed. Keep the target isolated and inspect its state before retrying.",
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
    if (process.argv.length !== 3)
      fail(
        "Usage: VUZMI_RESTORE_DATABASE_URL=<private environment value> node scripts/restore.mjs <backup-bundle-directory>.",
      );
    loadPrivateEnvironment();
    await restoreDatabase({
      directory: process.argv[2],
      targetDatabaseUrl: process.env.VUZMI_RESTORE_DATABASE_URL,
      sourceDatabaseUrl: process.env.DATABASE_URL,
    });
    console.info(
      "Database restored into the empty target; restored inference jobs are quarantined. No application or inference services were started.",
    );
    console.info(
      "Keep the target private. Install the bundled auth secret, revoke restored sessions, verify ownership/data/deletion state, and review pending work before starting services.",
    );
  } catch (error) {
    console.error(
      error instanceof RecoveryError
        ? error.message
        : "Restore failed. Check the private bundle, target configuration and permissions; no secrets were printed.",
    );
    process.exitCode = 1;
  }
}
