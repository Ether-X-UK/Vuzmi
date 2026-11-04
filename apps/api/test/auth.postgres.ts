import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { AuthService } from "@vuzmi/auth";
import { buildApp } from "../src/app.js";
const connectionString = process.env.VUZMI_TEST_DATABASE_URL;
test(
  "HTTP owner boundary, cookie bridge, CSRF, actor and logout on real PostgreSQL",
  { skip: !connectionString },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
    const schema = `http_${suffix}`;
    const queueSchema = `queue_${suffix}`;
    const authSchema = `auth_${suffix}`;
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
    const sql = new Pool({ connectionString });
    t.after(async () => {
      await app.close();
      for (const name of [queueSchema, schema, authSchema])
        await sql.query(`DROP SCHEMA "${name}" CASCADE`);
      await sql.end();
    });
    const get = () => app.inject({ method: "GET", url: "/v1/workspace" });
    assert.equal((await get()).statusCode, 401);
    for (const url of [
      "/v1/runs",
      "/%76%31/runs",
      "/v%31/runs",
      "/%76%31/knowledge",
      "/%76%31/outbox",
    ]) {
      assert.equal(
        (await app.inject({ method: "GET", url })).statusCode,
        401,
        url,
      );
    }
    assert.equal(
      (await app.inject({ method: "POST", url: "/%76%31/runs", payload: {} }))
        .statusCode,
      401,
    );
    const state = await app.inject({ method: "GET", url: "/v1/auth/state" });
    assert.deepEqual(state.json(), {
      mode: "owner",
      setupNeeded: true,
      user: null,
    });
    const setup = {
      token,
      name: "HTTP fixture owner",
      email: "http-owner@example.test",
      password: "Fixture-only-Strong-Password-2026",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/setup",
          payload: setup,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/setup",
          headers: { origin: "vuzmi://" },
          payload: setup,
        })
      ).statusCode,
      403,
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/auth/setup",
      headers: { origin: baseUrl },
      payload: setup,
    });
    assert.equal(created.statusCode, 201, created.body);
    const owner = created.json().user;
    assert.equal((await get()).statusCode, 401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: baseUrl },
      payload: { email: setup.email, password: setup.password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const setCookies = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .filter(Boolean)
      .map((v) => v!.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const headers = { cookie, origin: baseUrl };
    assert.equal(
      (await app.inject({ method: "GET", url: "/v1/workspace", headers }))
        .statusCode,
      200,
    );
    const identity = (
      await app.inject({ method: "GET", url: "/v1/auth/state", headers })
    ).json();
    assert.equal(identity.user.id, owner.id);
    assert.equal("token" in identity.user, false);
    const input = {
      title: "Owner reviewed release",
      brief:
        "Prepare a local release readiness artifact for our private alpha.",
      domain: "build",
      mode: "simulation",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/runs",
          headers: { cookie },
          payload: input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/%76%31/runs",
          headers: { cookie },
          payload: input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/runs",
          headers: { cookie, origin: "https://attacker.example" },
          payload: input,
        })
      ).statusCode,
      403,
    );
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: input,
    });
    assert.equal(proposed.statusCode, 201, proposed.body);
    const run = proposed.json().run;
    const approved = await app.inject({
      method: "POST",
      url: `/v1/runs/${run.id}/decisions`,
      headers: { cookie, origin: "vuzmi://" },
      payload: {
        decision: "approve",
        revision: run.revision,
        fingerprint: run.proposal.fingerprint,
      },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().run.decision.actor, owner.id);
    assert.equal(approved.json().run.decision.actorName, owner.name);
    assert.equal(approved.json().run.artifact.content, run.proposal.content);
    const publicSignup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers,
      payload: setup,
    });
    assert.equal(publicSignup.statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/sign-out",
          headers,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "GET", url: "/v1/workspace", headers }))
        .statusCode,
      401,
    );
  },
);
