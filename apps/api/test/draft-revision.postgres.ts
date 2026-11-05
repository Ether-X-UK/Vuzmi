import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { AuthService } from "@vuzmi/auth";
import { approvedPackageSchema, renderDraftDocument } from "@vuzmi/core";
import { PostgresRunRepository } from "@vuzmi/runtime";
import { buildApp } from "../src/app.js";

const connectionString = process.env.VUZMI_TEST_DATABASE_URL;
test(
  "authenticated draft revisions bind approval and export to corrected bytes",
  { skip: !connectionString },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
    const schema = `draft_${suffix}`;
    const queueSchema = `draftq_${suffix}`;
    const authSchema = `drafta_${suffix}`;
    const baseUrl = "http://127.0.0.1:5173";
    const token = randomBytes(40).toString("base64url");
    const auth = await AuthService.connect({
      connectionString: connectionString!,
      schema: authSchema,
      baseUrl,
      secret: randomBytes(40).toString("base64url"),
      setupToken: token,
    });
    const app = await buildApp({
      databaseUrl: connectionString,
      databaseSchema: schema,
      queueSchema,
      auth,
      authBaseUrl: baseUrl,
      discoverModels: async () => [],
    });
    const repository = await PostgresRunRepository.connect({
      connectionString: connectionString!,
      schema,
      queueSchema,
    });
    const sql = new Pool({ connectionString });
    t.after(async () => {
      await app.close();
      await repository.close();
      for (const name of [queueSchema, schema, authSchema])
        await sql.query(`DROP SCHEMA "${name}" CASCADE`);
      await sql.end();
    });
    const owner = await auth.setupOwner({
      token,
      name: "Revision fixture owner",
      email: "revision-owner@example.test",
      password: "Fixture-only-Strong-Password-2026",
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: baseUrl },
      payload: {
        email: owner.email,
        password: "Fixture-only-Strong-Password-2026",
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = login.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter(Boolean)
      .map((value) => value!.split(";")[0])
      .join("; ");
    const headers = { cookie, origin: baseUrl };
    const queued = await repository.create(
      {
        title: "Revise local release wording",
        brief: "Prepare an owner-reviewed local release readiness draft.",
        domain: "build",
        mode: "ollama",
      },
      {
        workspaceId: "local-workspace",
        id: randomUUID(),
        model: "fixture-local-no-inference",
      },
    );
    const running = await repository.claim("local-workspace", queued.id, {
      attemptId: "fixture-revision-attempt",
    });
    assert.ok(running);
    const waiting = await repository.complete("local-workspace", queued.id, {
      attemptId: running.attemptId!,
      expectedRevision: running.revision,
      content: renderDraftDocument(
        "# Draft\n\nRelease wording needs review.\n",
      ),
      usage: { inputTokens: null, outputTokens: null, durationMs: null },
    });
    assert.ok(waiting);
    const url = `/v1/runs/${queued.id}/draft`;
    const input = {
      editId: randomUUID(),
      revision: waiting.revision,
      fingerprint: waiting.proposal!.fingerprint,
      body: "# Corrected café 🚀\r\n\r\nLocal storage does not deploy a release.  \r\n",
      reason: "Correct the approval boundary.",
    };
    for (const path of [url, `/%76%31/runs/${queued.id}/draft`]) {
      assert.equal(
        (await app.inject({ method: "PATCH", url: path, payload: input }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: path,
            headers: { cookie },
            payload: input,
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: { cookie, origin: "https://attacker.example" },
          payload: input,
        })
      ).statusCode,
      403,
    );
    for (const invalid of [
      { ...input, actor: "forged-owner" },
      { ...input, body: "🚀".repeat(16385) },
      { ...input, body: "Unsupported [S999] reference." },
      { ...input, reason: "x" },
    ]) {
      const response = await app.inject({
        method: "PATCH",
        url,
        headers,
        payload: invalid,
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.deepEqual(
      await repository.get("local-workspace", queued.id),
      JSON.parse(JSON.stringify(waiting)),
    );
    const saved = await app.inject({
      method: "PATCH",
      url,
      headers,
      payload: input,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const amended = saved.json().run;
    assert.equal(amended.revision, waiting.revision + 1);
    assert.equal(amended.draftRevisions.length, 1);
    assert.equal(amended.draftRevisions[0].actor, owner.id);
    assert.equal(amended.draftRevisions[0].actorName, owner.name);
    assert.equal(
      amended.draftRevisions[0].previousProposal.content,
      waiting.proposal!.content,
    );
    assert.equal(
      amended.proposal.content,
      renderDraftDocument(input.body, undefined, "human"),
    );
    assert.deepEqual(amended.usage, waiting.usage);
    assert.notEqual(
      amended.proposal.fingerprint,
      waiting.proposal!.fingerprint,
    );
    const replay = await app.inject({
      method: "PATCH",
      url,
      headers,
      payload: input,
    });
    assert.deepEqual(replay.json().run, amended);
    for (const stale of [
      { ...input, editId: randomUUID() },
      { ...input, body: `${input.body}changed` },
    ]) {
      assert.equal(
        (await app.inject({ method: "PATCH", url, headers, payload: stale }))
          .statusCode,
        409,
      );
    }
    const decide = (revision: number, fingerprint: string) =>
      app.inject({
        method: "POST",
        url: `/v1/runs/${queued.id}/decisions`,
        headers,
        payload: { decision: "approve", revision, fingerprint },
      });
    assert.equal(
      (await decide(waiting.revision, waiting.proposal!.fingerprint))
        .statusCode,
      409,
    );
    const approval = await decide(
      amended.revision,
      amended.proposal.fingerprint,
    );
    assert.equal(approval.statusCode, 200, approval.body);
    const completed = approval.json().run;
    assert.equal(completed.artifact.content, amended.proposal.content);
    const download = await app.inject({
      method: "GET",
      url: `/v1/outbox/${queued.id}`,
      headers,
    });
    assert.equal(download.statusCode, 200, download.body);
    const bundle = approvedPackageSchema.parse(download.json());
    assert.equal(bundle.documents[0].content, completed.artifact.content);
    assert.equal(
      bundle.documents[0].sha256,
      createHash("sha256").update(completed.artifact.content).digest("hex"),
    );
    assert.equal(
      bundle.documents[0].byteLength,
      Buffer.byteLength(completed.artifact.content),
    );
    assert.deepEqual(bundle.draftRevisions, amended.draftRevisions);
    assert.equal(
      bundle.approval.actionFingerprint,
      amended.proposal.fingerprint,
    );
    assert.equal(bundle.approval.actor, owner.id);
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers,
          payload: {
            ...input,
            editId: randomUUID(),
            revision: completed.revision,
            fingerprint: completed.proposal.fingerprint,
          },
        })
      ).statusCode,
      409,
    );
    const terminalReplay = await app.inject({
      method: "PATCH",
      url,
      headers,
      payload: input,
    });
    assert.deepEqual(terminalReplay.json().run, completed);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/outbox/${queued.id}`,
          headers,
        })
      ).body,
      download.body,
    );
    const effects = await sql.query(
      `SELECT (SELECT count(*)::int FROM "${schema}".artifacts WHERE run_id=$1) artifacts, (SELECT count(*)::int FROM "${schema}".run_events WHERE run_id=$1) events`,
      [queued.id],
    );
    assert.equal(effects.rows[0].artifacts, 1);
    assert.equal(effects.rows[0].events, completed.events.length);
  },
);
