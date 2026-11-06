import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import type { AuthService } from "@vuzmi/auth";
import { PostgresRunRepository } from "@vuzmi/runtime";
import { approvedDeliveryFixture } from "../../../packages/runtime/test/delivery-fixtures.js";
import { buildApp } from "../src/app.js";
const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL,
  workspace = "local-workspace";
const owner = {
    id: "delivery-http-owner",
    name: "Synthetic HTTP owner",
    email: "fixture@example.invalid",
    workspaceId: workspace as "local-workspace",
  },
  headers = { cookie: "fixture=owner", origin: "http://127.0.0.1:4310" };
test(
  "GitHub delivery HTTP guards, exact review, disconnected replay and bounded read-only refresh",
  { skip: !databaseUrl },
  async (t) => {
    const source = approvedDeliveryFixture(),
      suffix = randomUUID().replaceAll("-", ""),
      schema = `delivery_http_${suffix}`,
      queueSchema = `delivery_hqueue_${suffix}`,
      repository = await PostgresRunRepository.connect({
        connectionString: databaseUrl!,
        schema,
        queueSchema,
      }),
      sql = new Pool({ connectionString: databaseUrl! }),
      workerId = randomUUID(),
      calls: string[] = [];
    let offline = false;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      if (offline) throw new Error("Synthetic network outage.");
      if (String(url) === "https://api.github.com/repos/Ether-X-UK/Vuzmi")
        return Response.json({
          id: 123,
          full_name: "Ether-X-UK/Vuzmi",
          name: "Vuzmi",
          owner: { login: "Ether-X-UK" },
          private: false,
          visibility: "public",
          default_branch: "main",
        });
      if (
        String(url) ===
        "https://api.github.com/repos/Ether-X-UK/Vuzmi/hash-algorithm"
      )
        return Response.json({ hash_algorithm: "sha1" });
      assert.equal(
        String(url),
        "https://api.github.com/repos/Ether-X-UK/Vuzmi/git/ref/heads/main",
      );
      return Response.json({
        ref: "refs/heads/main",
        object: { type: "commit", sha: source.target.targetSha },
      });
    };
    const auth = {
      session: async (value: Headers) =>
        value.get("cookie") === headers.cookie ? owner : null,
      close: async () => {},
    } as unknown as AuthService;
    const app = await buildApp({
      databaseUrl,
      databaseSchema: schema,
      queueSchema,
      auth,
      githubFetch: fetch,
    });
    t.after(async () => {
      await app.close();
      await repository.close();
      await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
      await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
      await sql.end();
    });
    const run = source.run,
      application = source.application;
    await sql.query(
      `INSERT INTO "${schema}".development_runs(workspace_id,id,request_id,request_hash,owner_id,revision,status,aggregate,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
      [
        workspace,
        run.id,
        run.requestId,
        run.requestFingerprint,
        owner.id,
        run.revision,
        run.status,
        JSON.stringify(run),
        run.createdAt,
        run.updatedAt,
      ],
    );
    await sql.query(
      `INSERT INTO "${schema}".development_artifacts(workspace_id,run_id,package,saved_at) VALUES($1,$2,$3::jsonb,$4)`,
      [workspace, run.id, run.artifact!.content, run.artifact!.savedAt],
    );
    await sql.query(
      `INSERT INTO "${schema}".development_applications(workspace_id,id,run_id,request_id,revision,status,aggregate) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        workspace,
        application.id,
        run.id,
        application.requestId,
        application.revision,
        application.status,
        JSON.stringify(application),
      ],
    );
    const base = `/v1/development/${run.id}/delivery`;
    for (const method of ["GET", "POST"] as const)
      assert.equal(
        (
          await app.inject({
            method,
            url: base,
            ...(method === "POST" ? { payload: source.input } : {}),
          })
        ).statusCode,
        401,
      );
    for (const suffix of ["/plan", "/refresh"]) {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: base + suffix,
            headers: { origin: headers.origin },
            payload: source.text,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: base + suffix,
            headers: { cookie: headers.cookie },
            payload: source.text,
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(calls.length, 0);
    const state = await app.inject({ method: "GET", url: base, headers });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().operation, null);
    assert.equal(state.json().available, false);
    assert.equal(state.json().authorityIdentity, null);
    const disconnected = await app.inject({
      method: "POST",
      url: base + "/plan",
      headers,
      payload: source.text,
    });
    assert.equal(disconnected.statusCode, 200);
    assert.equal(disconnected.json().available, false);
    assert.equal(disconnected.json().plan.authorityIdentity, null);
    assert.equal(calls.length, 3);
    await repository.deliveries.heartbeat(workerId, {
      ready: true,
      reason: "Synthetic explicit authority; no credential file.",
      authorityIdentity: source.authorityIdentity,
      target: source.target,
    });
    const prepared = await app.inject({
      method: "POST",
      url: base + "/plan",
      headers,
      payload: source.text,
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(prepared.json().available, true);
    const payload = {
      ...source.input,
      planFingerprint: prepared.json().plan.fingerprint,
    };
    for (const extra of [
      { repository: "other/repo" },
      { token: "forbidden" },
      { destinationRef: "refs/heads/main" },
    ])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: base,
            headers,
            payload: { ...payload, ...extra },
          })
        ).statusCode,
        400,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: { ...payload, planFingerprint: "0".repeat(64) },
        })
      ).statusCode,
      409,
    );
    const authorized = await app.inject({
      method: "POST",
      url: base,
      headers,
      payload,
    });
    assert.equal(authorized.statusCode, 201);
    assert.equal(authorized.json().operation.actor, owner.id);
    assert.equal(authorized.json().operation.status, "queued");
    await repository.deliveries.removeHeartbeat(workerId);
    offline = true;
    const before = calls.length;
    const replay = await app.inject({
      method: "POST",
      url: base,
      headers,
      payload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.deepEqual(replay.json().operation, authorized.json().operation);
    assert.equal(calls.length, before);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: { ...payload, body: "Conflicting retry" },
        })
      ).statusCode,
      409,
    );
    assert.equal(calls.length, before);
    const refresh = await app.inject({
      method: "POST",
      url: base + "/refresh",
      headers,
      payload: {},
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(refresh.json().operation.status, "queued");
    assert.equal(calls.length, before);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: base + "/refresh",
          headers,
          payload: { rerun: true },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/development/invalid/delivery",
          headers,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await repository.development.package(workspace, run.id)).content,
      run.artifact!.content,
    );
  },
);
