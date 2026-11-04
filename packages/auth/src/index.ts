import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { expo } from "@better-auth/expo";
import { ownerSchema, ownerSetupSchema } from "@vuzmi/core";
import type { AuthState, OwnerSetup, SafeOwner } from "@vuzmi/core";

const libraryVersion = "1.7.17";
const basePath = "/api/auth";
const workspaceId = "local-workspace";

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export interface AuthOptions {
  connectionString: string;
  schema?: string;
  baseUrl: string;
  secret: string;
  setupToken: string;
  trustedOrigins?: string[];
}
function schemaIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new AuthError(
      "INVALID_CONFIGURATION",
      "Configure a lowercase PostgreSQL auth schema name.",
    );
  return `"${value}"`;
}
function validateOptions(options: AuthOptions): void {
  const url = new URL(options.baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  ) {
    throw new AuthError(
      "INVALID_CONFIGURATION",
      "Authentication requires HTTPS, or an HTTP loopback URL for local development.",
    );
  }
  if (
    options.secret.length < 32 ||
    options.setupToken.length < 32 ||
    options.setupToken.length > 256
  ) {
    throw new AuthError(
      "INVALID_CONFIGURATION",
      "Authentication needs a strong secret and a private setup key of at least 32 characters.",
    );
  }
  for (const origin of options.trustedOrigins ?? []) {
    if (origin.includes("*"))
      throw new AuthError(
        "INVALID_CONFIGURATION",
        "Configure exact trusted authentication origins without wildcards.",
      );
    const parsed = new URL(origin);
    if (
      !["https:", "http:", "vuzmi:"].includes(parsed.protocol) ||
      (parsed.protocol === "http:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    ) {
      throw new AuthError(
        "INVALID_CONFIGURATION",
        "Trusted origins must be HTTPS, loopback HTTP, or the exact Vuzmi app scheme.",
      );
    }
  }
}
function makeAuth(
  pool: Pool,
  options: AuthOptions,
  allowSignup = false,
  intendedUserId?: string,
) {
  return betterAuth({
    appName: "Vuzmi",
    baseURL: options.baseUrl,
    basePath,
    secret: options.secret,
    database: pool,
    trustedOrigins: [
      ...new Set([
        new URL(options.baseUrl).origin,
        ...(options.trustedOrigins ?? []),
        "vuzmi://",
      ]),
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignup,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    socialProviders: {},
    plugins: [expo()],
    telemetry: { enabled: false },
    logger: { disabled: true },
    session: {
      expiresIn: 24 * 60 * 60,
      updateAge: 30 * 60,
      freshAge: 10 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/get-session": false,
      },
    },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    advanced: {
      useSecureCookies: options.baseUrl.startsWith("https:"),
      cookiePrefix: "vuzmi",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: options.baseUrl.startsWith("https:"),
      },
      // Startup performs the pinned, explicit schema checks below. The library's
      // optional runtime validator introspects unrelated schemas on each private
      // bootstrap instance, which races concurrent maintenance in those schemas.
      database: {
        validateSchema: false,
        generateId: ({ model }: { model: string }) =>
          intendedUserId && model.toLowerCase() === "user"
            ? intendedUserId
            : randomUUID(),
      },
    },
  });
}
type AuthInstance = ReturnType<typeof makeAuth>;

async function migrationPlan(auth: AuthInstance) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getMigrations(auth.options);
    } catch (error) {
      // Kysely first inspects all visible PostgreSQL schemas before Better Auth
      // filters to our dedicated search_path. An unrelated concurrent DROP may
      // invalidate that catalog snapshot; retry only that bounded startup race.
      const code = (error as { code?: string }).code;
      if (attempt >= 2 || (code !== "3F000" && code !== "42P01")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function locked<T>(
  pool: Pool,
  key: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [key]);
    acquired = true;
    return await operation(client);
  } finally {
    if (acquired)
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [key])
        .catch(() => undefined);
    client.release();
  }
}

async function migrate(
  pool: Pool,
  schemaName: string,
  options: AuthOptions,
): Promise<AuthInstance> {
  const schema = schemaIdentifier(schemaName);
  return locked(pool, `vuzmi:auth:migrate:${schemaName}`, async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.vuzmi_auth_migrations(version integer PRIMARY KEY,checksum text NOT NULL,library_version text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const wrapperSql = `
      CREATE UNIQUE INDEX vuzmi_single_owner_user ON ${schema}."user" ((true));
      CREATE TABLE ${schema}.vuzmi_owner (
        workspace_id text PRIMARY KEY CHECK(workspace_id='local-workspace'),
        user_id text NOT NULL UNIQUE REFERENCES ${schema}."user"(id),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schema}.vuzmi_bootstrap (
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
        intended_user_id text NOT NULL UNIQUE,
        state text NOT NULL CHECK(state IN ('pending','complete')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION ${schema}.protect_owner_binding() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'The owner binding is immutable'; END;
      $body$;
      CREATE TRIGGER immutable_owner_binding BEFORE UPDATE OR DELETE ON ${schema}.vuzmi_owner FOR EACH ROW EXECUTE FUNCTION ${schema}.protect_owner_binding();
    `;
    const checksum = createHash("sha256")
      .update(
        JSON.stringify({
          libraryVersion,
          expoVersion: libraryVersion,
          wrapperSql,
          databaseRateLimit: true,
        }),
      )
      .digest("hex");
    const existing = await client.query<{
      checksum: string;
      library_version: string;
    }>(
      `SELECT checksum,library_version FROM ${schema}.vuzmi_auth_migrations WHERE version=1`,
    );
    if (
      existing.rows[0] &&
      (existing.rows[0].checksum !== checksum ||
        existing.rows[0].library_version !== libraryVersion)
    )
      throw new AuthError(
        "AUTH_MIGRATION_MISMATCH",
        "Authentication migration metadata differs from this pinned release. Apply an explicit reviewed upgrade.",
        503,
      );
    const auth = makeAuth(pool, options);
    const plan = await migrationPlan(auth);
    if (existing.rows[0]) {
      if (
        plan.toBeCreated.length ||
        plan.toBeAdded.length ||
        plan.toBeAddedIndexes.length ||
        plan.schemaProblems.length ||
        plan.unsafeChanges.length
      )
        throw new AuthError(
          "AUTH_SCHEMA_DRIFT",
          "Authentication tables differ from the recorded migration. Repair or migrate before starting.",
          503,
        );
      const wrapper = await client.query<{
        owner_table: string | null;
        bootstrap_table: string | null;
        guard_index: string | null;
      }>(
        "SELECT to_regclass($1)::text AS owner_table,to_regclass($2)::text AS bootstrap_table,to_regclass($3)::text AS guard_index",
        [
          `${schemaName}.vuzmi_owner`,
          `${schemaName}.vuzmi_bootstrap`,
          `${schemaName}.vuzmi_single_owner_user`,
        ],
      );
      if (
        !wrapper.rows[0]?.owner_table ||
        !wrapper.rows[0]?.bootstrap_table ||
        !wrapper.rows[0]?.guard_index
      )
        throw new AuthError(
          "AUTH_SCHEMA_DRIFT",
          "The recorded owner binding or single-owner constraint is missing. Local repair is required.",
          503,
        );
      return auth;
    }
    await plan.runMigrations();
    await client.query("BEGIN");
    try {
      await client.query(wrapperSql);
      await client.query(
        `INSERT INTO ${schema}.vuzmi_auth_migrations(version,checksum,library_version) VALUES(1,$1,$2)`,
        [checksum, libraryVersion],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return auth;
  });
}

const routes: Record<string, ReadonlySet<string>> = {
  "/sign-in/email": new Set(["POST"]),
  "/sign-out": new Set(["POST"]),
  "/get-session": new Set(["GET"]),
  "/revoke-session": new Set(["POST"]),
  "/revoke-sessions": new Set(["POST"]),
  "/revoke-other-sessions": new Set(["POST"]),
};
function errorResponse(error: AuthError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.statusCode, headers: { "Cache-Control": "no-store" } },
  );
}
function cookieHeader(response: Response): Headers {
  const cookies = response.headers.getSetCookie();
  return new Headers({
    cookie: cookies.map((cookie) => cookie.split(";")[0]!).join("; "),
  });
}

/** Private single-owner service, not hosted membership or public account registration. */
export class AuthService {
  private closed = false;
  private constructor(
    private readonly pool: Pool,
    private readonly auth: AuthInstance,
    private readonly options: AuthOptions,
    private readonly schema: string,
    private readonly schemaName: string,
  ) {}

  static async connect(options: AuthOptions): Promise<AuthService> {
    validateOptions(options);
    const schemaName = options.schema ?? "vuzmi_auth";
    const schema = schemaIdentifier(schemaName);
    const pool = new Pool({
      connectionString: options.connectionString,
      options: `-c search_path=${schemaName}`,
      max: 5,
      application_name: "vuzmi-auth",
    });
    try {
      return new AuthService(
        pool,
        await migrate(pool, schemaName, options),
        options,
        schema,
        schemaName,
      );
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${basePath}/`)
      ? url.pathname.slice(basePath.length)
      : "";
    if (!routes[path]?.has(request.method))
      return errorResponse(
        new AuthError(
          "AUTH_ROUTE_NOT_AVAILABLE",
          "This authentication route is not enabled.",
          404,
        ),
      );
    try {
      if (path === "/sign-in/email" && !(await this.binding()))
        return errorResponse(
          new AuthError(
            "OWNER_SETUP_REQUIRED",
            "Complete private owner setup before signing in.",
            409,
          ),
        );
      const response = await this.auth.handler(request);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      return errorResponse(
        new AuthError(
          "AUTH_UNAVAILABLE",
          "Authentication could not complete. Check the local database and try again.",
          503,
        ),
      );
    }
  }

  async session(headers: Headers): Promise<SafeOwner | null> {
    const ownerId = await this.binding();
    if (!ownerId) return null;
    const session = await this.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    if (!session || session.user.id !== ownerId) return null;
    return ownerSchema.parse({
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: "owner",
      workspaceId,
    });
  }
  async state(headers: Headers): Promise<AuthState> {
    const binding = await this.binding();
    return {
      mode: "owner",
      setupNeeded: !binding,
      user: binding ? await this.session(headers) : null,
    };
  }

  async setupOwner(input: OwnerSetup): Promise<SafeOwner> {
    const parsed = ownerSetupSchema.safeParse(input);
    if (!parsed.success)
      throw new AuthError(
        "INVALID_SETUP",
        "Provide the private setup key, name, email, and a password of 12–128 characters.",
      );
    const value = parsed.data;
    const expected = createHash("sha256")
      .update(this.options.setupToken)
      .digest();
    const supplied = createHash("sha256").update(value.token).digest();
    if (!timingSafeEqual(expected, supplied))
      throw new AuthError(
        "SETUP_KEY_INVALID",
        "The private setup key is invalid.",
        403,
      );
    return locked(
      this.pool,
      `vuzmi:auth:bootstrap:${this.schemaName}`,
      async (client) => {
        if (await this.binding(client))
          throw new AuthError(
            "OWNER_ALREADY_CONFIGURED",
            "The owner is already configured. Sign in instead.",
            409,
          );
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM ${this.schema}."user" LIMIT 2`,
        );
        const pending = await client.query<{
          intended_user_id: string;
          state: string;
        }>(
          `SELECT intended_user_id,state FROM ${this.schema}.vuzmi_bootstrap WHERE singleton=true`,
        );
        let intendedId = pending.rows[0]?.intended_user_id;
        if (
          existing.rows.length &&
          (!intendedId ||
            existing.rows.length !== 1 ||
            existing.rows[0]!.id !== intendedId)
        ) {
          throw new AuthError(
            "OWNER_REPAIR_REQUIRED",
            "The database contains an unbound account without its matching bootstrap record. Local operator repair is required.",
            409,
          );
        }
        if (!intendedId) {
          intendedId = randomUUID();
          await client.query(
            `INSERT INTO ${this.schema}.vuzmi_bootstrap(singleton,intended_user_id,state) VALUES(true,$1,'pending')`,
            [intendedId],
          );
        }
        const bootstrap = makeAuth(this.pool, this.options, true, intendedId);
        let owner: SafeOwner;
        if (existing.rows.length) {
          const response = await bootstrap.api.signInEmail({
            body: { email: value.email, password: value.password },
            asResponse: true,
          });
          if (!response.ok)
            throw new AuthError(
              "OWNER_CREDENTIALS_INVALID",
              "Recovery needs the original owner credentials as well as the private setup key.",
              401,
            );
          const signedIn = (await response.json()) as {
            user?: { id: string; name: string; email: string };
          };
          if (signedIn.user?.id !== intendedId)
            throw new AuthError(
              "OWNER_REPAIR_REQUIRED",
              "The recovered account does not match the recorded bootstrap identity.",
              409,
            );
          await bootstrap.api.revokeSessions({
            headers: cookieHeader(response),
          });
          owner = ownerSchema.parse({
            ...signedIn.user,
            role: "owner",
            workspaceId,
          });
        } else {
          try {
            const created = await bootstrap.api.signUpEmail({
              body: {
                name: value.name,
                email: value.email,
                password: value.password,
              },
            });
            if (created.user.id !== intendedId)
              throw new AuthError(
                "OWNER_REPAIR_REQUIRED",
                "The created account does not match the recorded bootstrap identity.",
                409,
              );
            owner = ownerSchema.parse({
              id: created.user.id,
              name: created.user.name,
              email: created.user.email,
              role: "owner",
              workspaceId,
            });
          } catch (error) {
            if (error instanceof AuthError) throw error;
            throw new AuthError(
              "OWNER_SETUP_FAILED",
              "Owner creation could not complete. Retry with the same original credentials and setup key.",
            );
          }
        }
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO ${this.schema}.vuzmi_owner(workspace_id,user_id) VALUES($1,$2)`,
            [workspaceId, owner.id],
          );
          await client.query(
            `UPDATE ${this.schema}.vuzmi_bootstrap SET state='complete' WHERE singleton=true`,
          );
          await client.query("COMMIT");
        } catch {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new AuthError(
            "OWNER_BINDING_INCOMPLETE",
            "Owner creation is incomplete. Retry with the original credentials and private setup key, or request local operator repair.",
            503,
          );
        }
        return owner;
      },
    );
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.pool.end();
    }
  }
  private async binding(client?: PoolClient): Promise<string | undefined> {
    const result = await (client ?? this.pool).query<{ user_id: string }>(
      `SELECT user_id FROM ${this.schema}.vuzmi_owner WHERE workspace_id=$1`,
      [workspaceId],
    );
    return result.rows[0]?.user_id;
  }
}
