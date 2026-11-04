import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { AuthError, AuthService } from "../src/index.js";
import type { AuthOptions } from "../src/index.js";

const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL;
const baseUrl = "http://127.0.0.1:4310";
const password = "Fixture-only-Strong-Password-2026";

async function fixture(t: TestContext) {
  const schema = `auth_test_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const options: AuthOptions = {
    connectionString: databaseUrl!,
    schema,
    baseUrl,
    secret: randomBytes(32).toString("base64url"),
    setupToken: randomBytes(32).toString("base64url"),
    trustedOrigins: ["http://127.0.0.1:5173", "vuzmi://"],
  };
  const auth = await AuthService.connect(options);
  const services = [auth];
  const sql = new Pool({ connectionString: databaseUrl!, max: 2 });
  t.after(async () => {
    for (const service of services) await service.close();
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const setup = {
    token: options.setupToken,
    name: "Fixture owner",
    email: "owner@example.test",
    password,
  };
  async function reopen() {
    const service = await AuthService.connect(options);
    services.push(service);
    return service;
  }
  return { auth, sql, schema, options, setup, reopen };
}
function request(
  path: string,
  body?: unknown,
  cookie?: string,
  origin = baseUrl,
): Request {
  return new Request(`${baseUrl}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
async function signIn(
  auth: AuthService,
  email = "owner@example.test",
  chosenPassword = password,
) {
  return auth.handler(
    request("/sign-in/email", { email, password: chosenPassword }),
  );
}

test(
  "private owner authentication on isolated PostgreSQL",
  { skip: !databaseUrl },
  async (t) => {
    await t.test(
      "unconfigured state is minimal and public signup/account routes cannot create users",
      async (t) => {
        const { auth, sql, schema, setup } = await fixture(t);
        assert.deepEqual(await auth.state(new Headers()), {
          mode: "owner",
          setupNeeded: true,
          user: null,
        });
        for (const path of [
          "/sign-up/email",
          "/sign-in/social",
          "/delete-user",
          "/request-password-reset",
          "/change-email",
        ]) {
          const response = await auth.handler(request(path, setup));
          assert.equal(response.status, 404);
          assert.equal(
            (await response.json()).error.code,
            "AUTH_ROUTE_NOT_AVAILABLE",
          );
        }
        assert.equal((await signIn(auth)).status, 409);
        const users = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}"."user"`,
        );
        assert.equal(users.rows[0].count, 0);
      },
    );

    await t.test(
      "setup key and password bounds protect bootstrap without exposing a session",
      async (t) => {
        const { auth, setup, sql, schema } = await fixture(t);
        await assert.rejects(
          auth.setupOwner({ ...setup, token: "x".repeat(43) }),
          (error: unknown) =>
            error instanceof AuthError && error.statusCode === 403,
        );
        await assert.rejects(
          auth.setupOwner({ ...setup, password: "too-short" }),
          (error: unknown) =>
            error instanceof AuthError && error.code === "INVALID_SETUP",
        );
        const owner = await auth.setupOwner(setup);
        assert.equal(owner.role, "owner");
        assert.equal(owner.workspaceId, "local-workspace");
        assert.equal("token" in owner, false);
        assert.equal("password" in owner, false);
        assert.deepEqual(await auth.state(new Headers()), {
          mode: "owner",
          setupNeeded: false,
          user: null,
        });
        const pending = await sql.query(
          `SELECT intended_user_id,state FROM "${schema}".vuzmi_bootstrap`,
        );
        assert.equal(pending.rows[0].intended_user_id, owner.id);
        assert.equal(pending.rows[0].state, "complete");
        const sessions = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}"."session"`,
        );
        assert.equal(
          sessions.rows[0].count,
          0,
          "setup must not create an implicit login session",
        );
        await assert.rejects(
          auth.setupOwner(setup),
          (error: unknown) =>
            error instanceof AuthError && error.statusCode === 409,
        );
      },
    );

    await t.test(
      "cross-instance setup races produce one immutable owner ID and one account",
      async (t) => {
        const { auth, setup, reopen, sql, schema } = await fixture(t);
        const other = await reopen();
        const results = await Promise.allSettled([
          auth.setupOwner(setup),
          other.setupOwner({
            ...setup,
            name: "Other owner",
            email: "other@example.test",
          }),
        ]);
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        assert.equal(
          results.filter((result) => result.status === "rejected").length,
          1,
        );
        const users = await sql.query(`SELECT id FROM "${schema}"."user"`);
        const bindings = await sql.query(
          `SELECT user_id FROM "${schema}".vuzmi_owner`,
        );
        const accounts = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}"."account"`,
        );
        assert.equal(users.rowCount, 1);
        assert.equal(bindings.rowCount, 1);
        assert.equal(accounts.rows[0].count, 1);
        assert.equal(users.rows[0].id, bindings.rows[0].user_id);
        await assert.rejects(
          sql.query(`UPDATE "${schema}".vuzmi_owner SET user_id=user_id`),
          /immutable/,
        );
        await assert.rejects(
          sql.query(`DELETE FROM "${schema}".vuzmi_owner`),
          /immutable/,
        );
      },
    );

    await t.test(
      "correct credentials set private cookies and identity follows immutable user ID, not email",
      async (t) => {
        const { auth, setup, sql, schema, reopen } = await fixture(t);
        const owner = await auth.setupOwner(setup);
        const invalid = await signIn(
          auth,
          setup.email,
          "Another-wrong-fixture-password",
        );
        assert.equal(invalid.status, 401);
        const response = await signIn(auth);
        assert.equal(response.status, 200);
        const cookie = cookies(response);
        assert.ok(cookie);
        const setCookie = response.headers.getSetCookie().join("\n");
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.equal(
          (await auth.session(new Headers({ cookie })))?.id,
          owner.id,
        );
        assert.equal(
          await auth.session(
            new Headers({ cookie: "vuzmi.session_token=forged" }),
          ),
          null,
        );
        await sql.query(`UPDATE "${schema}"."user" SET email=$2 WHERE id=$1`, [
          owner.id,
          "renamed@example.test",
        ]);
        const renamed = await auth.session(new Headers({ cookie }));
        assert.equal(renamed?.id, owner.id);
        assert.equal(renamed?.email, "renamed@example.test");
        const other = await reopen();
        assert.equal(
          (await other.session(new Headers({ cookie })))?.id,
          owner.id,
        );
        const state = await other.state(new Headers({ cookie }));
        assert.deepEqual(Object.keys(state).sort(), [
          "mode",
          "setupNeeded",
          "user",
        ]);
        assert.deepEqual(Object.keys(state.user!).sort(), [
          "email",
          "id",
          "name",
          "role",
          "workspaceId",
        ]);
      },
    );

    await t.test(
      "untrusted origins are denied and logout/revocation/expiry invalidate DB sessions",
      async (t) => {
        const { auth, setup, sql, schema } = await fixture(t);
        await auth.setupOwner(setup);
        const untrusted = await auth.handler(
          request(
            "/sign-in/email",
            { email: setup.email, password },
            undefined,
            "https://untrusted.example",
          ),
        );
        assert.equal(untrusted.status, 403);
        const first = await signIn(auth);
        assert.equal(first.status, 200);
        const firstCookie = cookies(first);
        const second = await signIn(auth);
        assert.equal(second.status, 200);
        const secondCookie = cookies(second);
        const revoke = await auth.handler(
          request("/revoke-sessions", {}, firstCookie),
        );
        assert.equal(revoke.status, 200);
        assert.equal(
          await auth.session(new Headers({ cookie: firstCookie })),
          null,
        );
        assert.equal(
          await auth.session(new Headers({ cookie: secondCookie })),
          null,
        );
        const third = await signIn(auth);
        const thirdCookie = cookies(third);
        const logout = await auth.handler(
          request("/sign-out", {}, thirdCookie),
        );
        assert.equal(logout.status, 200);
        assert.equal(
          await auth.session(new Headers({ cookie: thirdCookie })),
          null,
        );
        const fourth = await signIn(auth);
        const fourthCookie = cookies(fourth);
        await sql.query(
          `UPDATE "${schema}"."session" SET "expiresAt"=now()-interval '1 minute'`,
        );
        assert.equal(
          await auth.session(new Headers({ cookie: fourthCookie })),
          null,
        );
      },
    );

    await t.test(
      "database-backed sign-in rate limiting remains enabled for local development",
      async (t) => {
        const { auth, setup } = await fixture(t);
        await auth.setupOwner(setup);
        for (let attempt = 0; attempt < 5; attempt++) {
          assert.equal(
            (await signIn(auth, setup.email, "Incorrect-fixture-password"))
              .status,
            401,
          );
        }
        const limited = await signIn(auth, setup.email, password);
        assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get("x-retry-after")) > 0);
        assert.equal(await auth.session(new Headers()), null);
      },
    );

    await t.test(
      "interrupted binding fails closed and recovery requires key plus original recorded-ID credentials",
      async (t) => {
        const { auth, setup, sql, schema } = await fixture(t);
        await sql.query(`CREATE FUNCTION "${schema}".simulate_binding_gap() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'Fixture interruption before owner binding'; END; $body$;
      CREATE TRIGGER simulate_binding_gap BEFORE INSERT ON "${schema}".vuzmi_owner FOR EACH ROW EXECUTE FUNCTION "${schema}".simulate_binding_gap()`);
        await assert.rejects(
          auth.setupOwner(setup),
          (error: unknown) =>
            error instanceof AuthError &&
            error.code === "OWNER_BINDING_INCOMPLETE",
        );
        const users = await sql.query(`SELECT id FROM "${schema}"."user"`);
        const pending = await sql.query(
          `SELECT intended_user_id FROM "${schema}".vuzmi_bootstrap`,
        );
        assert.equal(users.rowCount, 1);
        assert.equal(users.rows[0].id, pending.rows[0].intended_user_id);
        assert.deepEqual(await auth.state(new Headers()), {
          mode: "owner",
          setupNeeded: true,
          user: null,
        });
        assert.equal((await signIn(auth)).status, 409);
        await sql.query(
          `DROP TRIGGER simulate_binding_gap ON "${schema}".vuzmi_owner`,
        );
        await assert.rejects(
          auth.setupOwner({
            ...setup,
            password: "Not-the-original-owner-password",
          }),
        );
        assert.equal((await auth.state(new Headers())).setupNeeded, true);
        await assert.rejects(
          auth.setupOwner({ ...setup, token: "z".repeat(43) }),
          (error: unknown) =>
            error instanceof AuthError && error.statusCode === 403,
        );
        const owner = await auth.setupOwner(setup);
        assert.equal(owner.id, users.rows[0].id);
        const sessions = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}"."session"`,
        );
        assert.equal(
          sessions.rows[0].count,
          0,
          "recovery must revoke its verification session before granting authority",
        );
        assert.equal((await auth.state(new Headers())).setupNeeded, false);
        const signedIn = await signIn(auth);
        assert.equal(signedIn.status, 200);
        assert.equal(
          (await auth.session(new Headers({ cookie: cookies(signedIn) })))?.id,
          owner.id,
        );
      },
    );

    await t.test("migration checksum drift refuses startup", async (t) => {
      const { auth, options, sql, schema } = await fixture(t);
      await auth.close();
      await sql.query(
        `UPDATE "${schema}".vuzmi_auth_migrations SET checksum='unexpected-fixture-change'`,
      );
      await assert.rejects(
        AuthService.connect(options),
        (error: unknown) =>
          error instanceof AuthError &&
          error.code === "AUTH_MIGRATION_MISMATCH",
      );
    });
  },
);
