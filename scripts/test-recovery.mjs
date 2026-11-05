import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { AuthService } from "../packages/auth/src/index.ts";
import {
  createApprovedPackage,
  githubPreviewFingerprintInput,
  renderDraftDocument,
} from "../packages/core/src/index.ts";
import {
  PostgresRunRepository,
  processIndexJob,
  processRunJob,
  processDevelopmentJob,
} from "../packages/runtime/src/index.ts";
import {
  developmentFixtureInput,
  developmentFixturePatch,
  developmentFixtureProfile,
  developmentFixtureRunner,
} from "../packages/runtime/test/development-fixtures.ts";
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
  const fixtureText =
    "# Release recovery\nThe local release artifact requires explicit owner review and durable evidence.";
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const importPreview = {
    previewId: randomUUID(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    title: "Release recovery fixture",
    format: "markdown",
    text: fixtureText,
    origin: {
      kind: "github-public",
      repositoryId: 123456,
      owner: "Ether-X-UK",
      repository: "Vuzmi",
      path: "docs/RECOVERY_FIXTURE.md",
      gitHashAlgorithm: "sha1",
      commitOid: "a".repeat(40),
      blobOid: createHash("sha1")
        .update(`blob ${Buffer.byteLength(fixtureText)}\0${fixtureText}`)
        .digest("hex"),
      rawSha256: digest(fixtureText),
      rawBytes: Buffer.byteLength(fixtureText),
      normalizedSha256: digest(fixtureText),
      normalizedBytes: Buffer.byteLength(fixtureText),
      normalizationVersion: "plain-text-v1",
      fetchedAt: new Date().toISOString(),
    },
  };
  importPreview.fingerprint = digest(
    githubPreviewFingerprintInput(importPreview),
  );
  const importRequest = {
    importId: randomUUID(),
    previewId: importPreview.previewId,
    fingerprint: importPreview.fingerprint,
  };
  const { source } = await repository.knowledge.importGithubSource(
    "local-workspace",
    importRequest,
    importPreview,
  );
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
  stage = "synthetic approved and interrupted development fixtures";
  const developmentWorkerId = randomUUID();
  await repository.development.heartbeat(developmentWorkerId, {
    ready: true,
    reason: "Synthetic recovery fixture; no container executed.",
    profile: developmentFixtureProfile,
  });
  const development = (
    await repository.development.create(developmentFixtureInput(), {
      id: randomUUID(),
      actor: owner.id,
      profile: developmentFixtureProfile,
    })
  ).run;
  await processDevelopmentJob({
    repository,
    workerId: developmentWorkerId,
    runner: developmentFixtureRunner(),
    generate: async () => ({
      patch: developmentFixturePatch,
      usage: { inputTokens: null, outputTokens: null, durationMs: null },
      modelDigest: "synthetic-recovery-model",
    }),
    job: { data: { workspaceId: "local-workspace", runId: development.id } },
  });
  const developmentWaiting = await repository.development.get(
    "local-workspace",
    development.id,
  );
  const expectedDevelopment = await repository.development.decide(
    "local-workspace",
    development.id,
    {
      decision: "approve",
      revision: developmentWaiting.revision,
      fingerprint: developmentWaiting.reviewFingerprint,
    },
    { id: owner.id, name: owner.name },
  );
  const expectedDevelopmentPackage = await repository.development.package(
    "local-workspace",
    development.id,
  );
  await repository.applications.heartbeat(developmentWorkerId, {
    ready: true,
    reason: "Synthetic recovery registration; no Git effects.",
    repositoryIdentity: "1".repeat(64),
  });
  const applicationPlan = (
    await repository.applications.plan("local-workspace", development.id)
  ).plan;
  const expectedApplication = (
    await repository.applications.authorize(
      "local-workspace",
      development.id,
      {
        requestId: randomUUID(),
        packageSha256: applicationPlan.packageSha256,
        planFingerprint: applicationPlan.fingerprint,
      },
      { id: owner.id, name: owner.name },
    )
  ).operation;
  const interruptedDevelopment = (
    await repository.development.create(developmentFixtureInput(), {
      id: randomUUID(),
      actor: owner.id,
      profile: developmentFixtureProfile,
    })
  ).run;
  const interruptedAttempt = await repository.development.claim(
    "local-workspace",
    interruptedDevelopment.id,
    developmentWorkerId,
    randomUUID(),
  );
  await repository.development.reserveExecution(
    "local-workspace",
    interruptedDevelopment.id,
    {
      workerId: developmentWorkerId,
      attemptId: interruptedAttempt.attemptId,
      revision: interruptedAttempt.revision,
    },
    "baseline",
    `vuzmi-dev-${interruptedDevelopment.id}-${interruptedAttempt.attemptId}-baseline`,
  );
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
        [
          [
            "vuzmi-generate-release",
            "vuzmi-index-source",
            "vuzmi-development-patch",
            "vuzmi-development-application",
          ],
        ],
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
  assert.equal(
    (
      await targetSql.query(
        "SELECT count(*)::integer count FROM vuzmi.development_runtime",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await targetSql.query(
        "SELECT count(*)::integer count FROM vuzmi.development_attempts WHERE state IN ('active','recovering')",
      )
    ).rows[0].count,
    0,
  );
  assert.equal((await restoredRepository.development.runtime()).ready, false);
  assert.equal(
    (
      await targetSql.query(
        "SELECT count(*)::int count FROM vuzmi.development_application_runtime",
      )
    ).rows[0].count,
    0,
  );
  const restoredApplication = await restoredRepository.applications.get(
    "local-workspace",
    development.id,
  );
  assert.equal(restoredApplication.status, "unconfirmed");
  assert.equal(
    restoredApplication.error.code,
    "APPLICATION_RESTORE_QUARANTINED",
  );
  assert.deepEqual(restoredApplication.plan, expectedApplication.plan);
  assert.equal(restoredApplication.receipt, undefined);
  let applicationEffects = 0;
  await restoredRepository.applications.reconcile({
    inspect: async () => {
      applicationEffects++;
      return "absent";
    },
  });
  assert.equal(applicationEffects, 0);

  assert.deepEqual(
    await restoredRepository.development.get("local-workspace", development.id),
    expectedDevelopment,
  );
  assert.deepEqual(
    await restoredRepository.development.package(
      "local-workspace",
      development.id,
    ),
    expectedDevelopmentPackage,
  );
  let restoredCleanupCalls = 0;
  await restoredRepository.development.reconcile(randomUUID(), async () => {
    restoredCleanupCalls++;
    return true;
  });
  assert.equal(
    restoredCleanupCalls,
    0,
    "a restored target cannot claim ownership of original-host execution resources",
  );
  assert.equal(
    (
      await restoredRepository.development.get(
        "local-workspace",
        interruptedDevelopment.id,
      )
    ).status,
    "failed",
  );
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
    await restoredRepository.knowledge.importGithubSource(
      "local-workspace",
      importRequest,
      {
        ...importPreview,
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ),
    { source: expectedSource.source, replayed: true },
    "restored import receipts replay without a new source or indexing job",
  );
  assert.deepEqual(
    expectedPackage.evidence.items.find((item) => item.kind === "source")
      .origin,
    importPreview.origin,
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
    "Recovery drill passed: isolated native dump/restore, permission/checksum/empty-target guards, source/memory/vectors, GitHub origin/import receipt replay, exact run/artifact/fingerprint/revision/events and human revision history/package, exact development package, separate application authorization/restore quarantine and interrupted-attempt/runtime quarantine, owner/session binding, session revocation, and pending-job quarantine.",
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
