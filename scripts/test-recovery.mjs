import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { AuthService } from "../packages/auth/src/index.ts";
import {
  createApprovedPackage,
  renderDraftDocument,
} from "../packages/core/src/index.ts";
import {
  PostgresRunRepository,
  processIndexJob,
  processRunJob,
} from "../packages/runtime/src/index.ts";
import { backupDatabase, RecoveryError } from "./backup.mjs";
import { inspectBundle, restoreDatabase } from "./restore.mjs";
import { startPostgres, stopPostgres } from "./dev-services.mjs";

// No operator environment/configuration is loaded. Both clusters, passwords,
// backup files and business content exist only below this temporary directory.
const stateDir = await mkdtemp(join(tmpdir(), "vuzmi-recovery-drill-"));
const sourceDir = join(stateDir, "source");
const targetDir = join(stateDir, "target");
const services = [];
const clients = [];
let sourceStarted = false;
let targetStarted = false;
let stage = "temporary cluster startup";
async function port() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(value)));
    });
  });
}
async function database(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  clients.push(client);
  return client;
}
const baseUrl = "http://127.0.0.1:4310";
function authRequest(path, body, cookie) {
  return new Request(`${baseUrl}/api/auth${path}`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

try {
  const sourcePort = await port();
  let targetPort = await port();
  while (targetPort === sourcePort) targetPort = await port();
  sourceStarted = true;
  const sourceUrl = startPostgres(sourceDir, sourcePort);
  targetStarted = true;
  const targetUrl = startPostgres(targetDir, targetPort);
  stage = "synthetic owner setup";
  const secret = randomBytes(48).toString("base64url");
  const setupToken = randomBytes(48).toString("base64url");
  const password = randomBytes(32).toString("base64url");
  const options = { connectionString: sourceUrl, baseUrl, secret, setupToken };
  const auth = await AuthService.connect(options);
  services.push(auth);
  const owner = await auth.setupOwner({
    token: setupToken,
    name: "Recovery drill owner",
    email: "recovery-owner@example.test",
    password,
  });
  const login = await auth.handler(
    authRequest("/sign-in/email", { email: owner.email, password }),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.equal((await auth.session(new Headers({ cookie }))).id, owner.id);

  stage = "source, memory and approved artifact fixtures";
  const repository = await PostgresRunRepository.connect({
    connectionString: sourceUrl,
  });
  services.push(repository);
  const profile = {
    provider: "ollama",
    model: "embeddinggemma:300m",
    digest: "synthetic-recovery-profile",
    dimensions: 3,
    normalization: "l2",
    version: 1,
    promptVersion: "embeddinggemma-retrieval-v1",
  };
  const embed = async ({ texts }) => ({
    profile,
    vectors: texts.map(() => [1, 0, 0]),
  });
  const source = await repository.knowledge.createSource("local-workspace", {
    title: "Release recovery fixture",
    format: "markdown",
    text: "# Release recovery\nThe local release artifact requires explicit owner review and durable evidence.",
  });
  await processIndexJob({
    repository,
    embed,
    job: {
      data: {
        workspaceId: "local-workspace",
        sourceId: source.id,
        revision: 1,
      },
      retryCount: 0,
    },
  });
  const memory = await repository.knowledge.createMemory("local-workspace", {
    title: "Release owner review",
    content: "Release readiness always requires explicit owner review.",
    provenance: { kind: "source", sourceId: source.id, sourceRevision: 1 },
    expiresAt: null,
  });
  const run = await repository.create(
    {
      title: "Prepare release recovery",
      brief:
        "Prepare local release readiness using the reviewed release source and owner preference.",
      mode: "ollama",
      domain: "build",
      knowledge: { sourceIds: [source.id], memoryIds: [memory.id] },
    },
    {
      id: randomUUID(),
      workspaceId: "local-workspace",
      model: "fixture-local-no-inference",
    },
  );
  await processRunJob({
    repository,
    embed,
    job: {
      data: {
        workspaceId: "local-workspace",
        runId: run.id,
        model: run.route.model,
      },
      retryCount: 0,
    },
    generate: async ({ evidence }) => ({
      content: renderDraftDocument(
        "# Proposed local release\n\nOwner review is required [S1] [M1].\n\nSynthetic recovery fixture; no inference, tests, or deployment was performed.",
        evidence,
      ),
      usage: { inputTokens: null, outputTokens: null, durationMs: null },
    }),
  });
  const proposed = await repository.get("local-workspace", run.id);
  assert.equal(proposed.status, "waiting_approval");
  const amended = await repository.amend(
    "local-workspace",
    run.id,
    {
      editId: randomUUID(),
      revision: proposed.revision,
      fingerprint: proposed.proposal.fingerprint,
      body: "# Revised local release\n\nOwner review is required [S1] [M1].\n\nSynthetic recovery fixture; local storage alone does not authorize publication. No inference, tests, or deployment was performed.\n",
      reason: "Clarify the local storage approval boundary.",
    },
    { id: owner.id, name: owner.name },
  );
  assert.equal(amended.draftRevisions.length, 1);
  const expectedRun = await repository.decide(
    "local-workspace",
    run.id,
    {
      decision: "approve",
      revision: amended.revision,
      fingerprint: amended.proposal.fingerprint,
    },
    { id: owner.id, name: owner.name },
  );
  const expectedPackage = await createApprovedPackage(expectedRun);
  const expectedSource = await repository.knowledge.getSource(
    "local-workspace",
    source.id,
  );
  const expectedMemory = await repository.knowledge.listMemories();
  const sourceSql = await database(sourceUrl);
  const expectedEvents = (
    await sourceSql.query(
      "SELECT sequence,event FROM vuzmi.run_events WHERE run_id=$1 ORDER BY sequence",
      [run.id],
    )
  ).rows;
  const expectedBinding = (
    await sourceSql.query("SELECT * FROM vuzmi_auth.vuzmi_owner")
  ).rows;
  const expectedSessions = (
    await sourceSql.query("SELECT * FROM vuzmi_auth.session ORDER BY id")
  ).rows;
  const expectedChunks = (
    await sourceSql.query(
      "SELECT chunk_index,body,content_hash,embedding::text AS embedding FROM vuzmi.source_chunks WHERE source_id=$1 ORDER BY chunk_index",
      [source.id],
    )
  ).rows;
  await repository.heartbeat("synthetic-old-worker");
  assert.equal(expectedSessions.length, 1);
  stage = "native backup and private bundle guards";
  const { bundle } = await backupDatabase({
    databaseUrl: sourceUrl,
    authSecret: secret,
    directory: join(stateDir, "backups"),
  });
  assert.equal((await stat(bundle)).mode & 0o777, 0o700);
  for (const name of ["database.dump", "manifest.json", "auth-secret"])
    assert.equal((await stat(join(bundle, name))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(bundle, "auth-secret"), "utf8"), secret);
  await writeFile(join(bundle, "auth-secret"), `${secret}tampered`, {
    mode: 0o600,
  });
  await assert.rejects(
    inspectBundle(bundle),
    (error) => error instanceof RecoveryError && /checksum/.test(error.message),
  );
  await writeFile(join(bundle, "auth-secret"), secret, { mode: 0o600 });
  await assert.rejects(
    restoreDatabase({
      directory: bundle,
      targetDatabaseUrl: sourceUrl,
      sourceDatabaseUrl: sourceUrl,
    }),
    (error) => error instanceof RecoveryError && /differ/.test(error.message),
  );
  // Demonstrate the documented deletion rollback: a pre-deletion snapshot will
  // contain the source and linked memory even after the source is deleted live.
  await repository.knowledge.deleteSource("local-workspace", source.id);
  assert.equal(
    await repository.knowledge.getSource("local-workspace", source.id),
    undefined,
  );
  for (const service of services.splice(0)) await service.close();
  for (const client of clients.splice(0)) await client.end();

  const marker = await database(targetUrl);
  stage = "nonempty target refusal";
  await marker.query("CREATE TABLE public.restore_guard(value text)");
  await marker.query("INSERT INTO public.restore_guard VALUES($1)", [
    "private fixture remains untouched",
  ]);
  await marker.end();
  clients.splice(clients.indexOf(marker), 1);
  await assert.rejects(
    restoreDatabase({
      directory: bundle,
      targetDatabaseUrl: targetUrl,
      sourceDatabaseUrl: sourceUrl,
    }),
    (error) =>
      error instanceof RecoveryError &&
      /contains application/.test(error.message),
  );
  const cleanup = await database(targetUrl);
  assert.equal(
    (await cleanup.query("SELECT value FROM public.restore_guard")).rows[0]
      .value,
    "private fixture remains untouched",
  );
  await cleanup.query("DROP TABLE public.restore_guard"); // Test-created disposable target only.
  await cleanup.end();
  clients.splice(clients.indexOf(cleanup), 1);
  stage = "native restore into empty target";
  const restored = await restoreDatabase({
    directory: bundle,
    targetDatabaseUrl: targetUrl,
    sourceDatabaseUrl: sourceUrl,
  });
  assert.equal(restored.authSecretPath, join(bundle, "auth-secret"));
  const targetSql = await database(targetUrl);
  stage = "exact restored data and pending job checks";
  assert.deepEqual(
    (await targetSql.query("SELECT * FROM vuzmi_auth.vuzmi_owner")).rows,
    expectedBinding,
  );
  assert.deepEqual(
    (await targetSql.query("SELECT * FROM vuzmi_auth.session ORDER BY id"))
      .rows,
    expectedSessions,
  );
  assert.deepEqual(
    (
      await targetSql.query(
        "SELECT sequence,event FROM vuzmi.run_events WHERE run_id=$1 ORDER BY sequence",
        [run.id],
      )
    ).rows,
    expectedEvents,
  );
  assert.deepEqual(
    (
      await targetSql.query(
        "SELECT chunk_index,body,content_hash,embedding::text AS embedding FROM vuzmi.source_chunks WHERE source_id=$1 ORDER BY chunk_index",
        [source.id],
      )
    ).rows,
    expectedChunks,
  );
  assert.equal(
    (
      await targetSql.query(
        "SELECT count(*)::int count FROM vuzmi_queue.job WHERE name=ANY($1::text[]) AND state IN ('created','retry','active')",
        [["vuzmi-generate-release", "vuzmi-index-source"]],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await targetSql.query(
        "SELECT count(*)::int count FROM vuzmi.worker_heartbeats",
      )
    ).rows[0].count,
    0,
  );
  const restoredRepository = await PostgresRunRepository.connect({
    connectionString: targetUrl,
  });
  services.push(restoredRepository);
  assert.deepEqual(
    await restoredRepository.get("local-workspace", run.id),
    expectedRun,
  );
  assert.deepEqual(
    await createApprovedPackage(
      await restoredRepository.get("local-workspace", run.id),
    ),
    expectedPackage,
  );
  assert.deepEqual(
    await restoredRepository.knowledge.getSource("local-workspace", source.id),
    expectedSource,
  );
  assert.deepEqual(
    await restoredRepository.knowledge.listMemories(),
    expectedMemory,
  );
  stage = "restored owner session and revocation";
  const restoredAuth = await AuthService.connect({
    ...options,
    connectionString: targetUrl,
  });
  services.push(restoredAuth);
  assert.equal(
    (await restoredAuth.session(new Headers({ cookie }))).id,
    owner.id,
  );
  const revoked = await restoredAuth.handler(
    authRequest("/revoke-sessions", {}, cookie),
  );
  assert.equal(revoked.status, 200);
  assert.equal(await restoredAuth.session(new Headers({ cookie })), null);
  await assert.rejects(
    restoreDatabase({
      directory: bundle,
      targetDatabaseUrl: targetUrl,
      sourceDatabaseUrl: sourceUrl,
    }),
    (error) =>
      error instanceof RecoveryError &&
      /contains application/.test(error.message),
  );
  assert.deepEqual(
    await restoredRepository.get("local-workspace", run.id),
    expectedRun,
  );
  console.info(
    "Recovery drill passed: isolated native dump/restore, permission/checksum/empty-target guards, source/memory/vectors, exact run/artifact/fingerprint/revision/events and human revision history/package, owner/session binding, session revocation, and pending-job quarantine.",
  );
  console.info(
    "Only disposable clusters and synthetic fixtures were used. No operator database, model, or cloud service was contacted.",
  );
} catch (error) {
  console.error(
    `Recovery drill failed during ${stage}. ${error instanceof RecoveryError ? error.message : "Database details, fixture content and secrets are suppressed."}`,
  );
  process.exitCode = 1;
} finally {
  for (const service of services) await service.close().catch(() => undefined);
  for (const client of clients) await client.end().catch(() => undefined);
  let cleanupFailed = false;
  for (const directory of [
    targetStarted ? targetDir : null,
    sourceStarted ? sourceDir : null,
  ]) {
    if (!directory) continue;
    try {
      stopPostgres(directory);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    console.error(
      `Temporary PostgreSQL cleanup was incomplete. Private test state was retained for local repair: ${stateDir}`,
    );
    process.exitCode = 1;
  } else await rm(stateDir, { recursive: true, force: true });
}
