# Private owner authentication

`AuthService` wraps pinned Better Auth 1.7.17 and its matching Expo integration. It owns a dedicated PostgreSQL schema and pool. It does not provide public registration, social authentication, external mail, account deletion, or hosted membership.

The API adapter owns HTTP request conversion, forwarding every `Set-Cookie` header, protecting business routes, and CSRF/origin checks for those routes. Better Auth's CSRF protection applies to its own endpoints. Never log owner-setup bodies, passwords, setup keys, cookies, session tokens, or query parameters containing credentials.

## Contract

```ts
const auth = await AuthService.connect({
  connectionString,
  schema: "vuzmi_auth",
  baseUrl,
  secret,
  setupToken,
  trustedOrigins: ["http://127.0.0.1:5173", "vuzmi://"],
});
await auth.handler(webRequest); // Better Auth's normal cookie/Expo protocol
await auth.session(headers); // SafeOwner | null
await auth.state(headers); // { mode: 'owner', setupNeeded, user }
await auth.setupOwner({ token, name, email, password }); // SafeOwner; then sign in
await auth.close();
```

Setup credentials are chosen by the operator. The setup key and signing secret must come from private local configuration; the parent configuration loader enforces private file permissions. A setup key is not a login credential and cannot replace the owner's password. Passwords are 12–128 characters, validated and hashed by Better Auth. Setup does not verify ownership of the supplied email address or send mail.

## Identity and interrupted setup

Before library signup, the service records the intended immutable user ID. A schema-scoped advisory lock serializes setup across API processes, and a unique database index permits one user. After signup, an immutable `vuzmi_owner` record binds that user ID to `local-workspace`. Neither an email match nor the first visitor grants workspace authority.

Signup and binding use separate framework/database transactions. An interruption between them deliberately leaves operational access disabled. Recovery through the same setup method requires the private key plus successful Better Auth authentication using the original account's credentials. The authenticated ID must equal the recorded intended ID. Temporary recovery sessions are revoked before binding. An unrelated existing account or missing identity record requires explicit local database repair; the service never adopts it automatically.

## Sessions and clients

Sessions are PostgreSQL-backed, expire after 24 hours, and use HttpOnly, SameSite=Lax cookies. HTTPS enables Secure cookies. HTTP is accepted only for loopback development. Cookie caching is disabled, so revocation is checked against the database. State/session helpers expose only safe owner fields.

The public handler allows email sign-in, get-session, sign-out, and session revocation only. Public signup and account-management routes return 404. Database-backed rate limiting remains enabled in development; email sign-in permits five attempts per minute per client bucket. Better Auth logging and telemetry are disabled. The API adapter must forward only trustworthy client-IP information when a proxy is introduced.

Web clients use same-origin cookies. Expo uses `@better-auth/expo/client` and `expo-secure-store`; authenticated API requests use `authClient.getCookie()` as the `Cookie` header with `credentials: 'omit'`. Only exact configured origins and the Vuzmi app scheme are trusted. Signing secrets and setup keys never belong in clients.

Migrations run under a dedicated advisory lock using Better Auth's programmatic migration API. The wrapper records the pinned library version and checksum. Unexpected library schema drift or wrapper-version mismatch prevents startup; upgrades need an explicit reviewed migration. Runtime migration and operational authentication roles are not yet separated, so this remains a private alpha boundary.

Explicit startup checks replace the library's redundant runtime schema validation. Better Auth/Kysely first introspects all visible schemas before selecting the configured auth schema; startup retries at most twice for a missing-schema/table catalog race caused by unrelated concurrent schema deletion. Other migration errors fail immediately.

## Verification

`npm run test:postgres` creates an isolated native PostgreSQL cluster and runs integration tests with fixture credentials. They must never create a known owner/password in the operator's development database. Coverage includes bootstrap concurrency, public-signup denial, login/cookies, session expiry/revocation, local rate limiting, wrong setup keys, immutable identity binding, and crash-gap recovery.

References: [Fastify](https://better-auth.com/docs/integrations/fastify), [PostgreSQL](https://better-auth.com/docs/adapters/postgresql), [programmatic migrations](https://better-auth.com/docs/concepts/database), [Expo](https://better-auth.com/docs/integrations/expo), [sessions](https://better-auth.com/docs/concepts/session-management).
