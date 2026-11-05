import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { AuthService } from "@vuzmi/auth";
import { PostgresRunRepository, processDevelopmentJob } from "@vuzmi/runtime";
import {
  developmentFixtureInput,
  developmentFixtureProfile,
  developmentFixturePatch,
  developmentFixtureRunner,
  digest,
} from "../../../packages/runtime/test/development-fixtures.js";
import { buildApp } from "../src/app.js";

const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL;
const owner = {
  id: "development-http-owner",
  name: "Fixture owner",
  email: "fixture@example.invalid",
  workspaceId: "local-workspace" as const,
};
const headers = { cookie: "fixture=owner", origin: "http://127.0.0.1:4310" };
async function fixture(t: TestContext) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
  const schema = `development_http_${suffix}`,
    queueSchema = `development_hqueue_${suffix}`,
    workerId = randomUUID();
  const repository = await PostgresRunRepository.connect({
    connectionString: databaseUrl!,
    schema,
    queueSchema,
  });
  await repository.development.heartbeat(workerId, {
    ready: true,
    reason: "Synthetic isolated fixture.",
    profile: developmentFixtureProfile,
  });
  const sql = new Pool({ connectionString: databaseUrl! }),
    calls: string[] = [];
  let issue: unknown = {
    id: 1234,
    number: 1,
    title: "Improve session expiry",
    body: "Handle an unreadable401 response using its status before parsing JSON.",
    html_url: "https://github.com/Ether-X-UK/Vuzmi/issues/1",
    updated_at: new Date().toISOString(),
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const value = String(url);
    calls.push(value);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (value === "https://api.github.com/repos/Ether-X-UK/Vuzmi")
      return Response.json({
        id: 123,
        name: "Vuzmi",
        owner: { login: "Ether-X-UK" },
        private: false,
        visibility: "public",
      });
    assert.equal(
      value,
      "https://api.github.com/repos/Ether-X-UK/Vuzmi/issues/1",
    );
    return Response.json(issue);
  };
  const auth = {
    session: async (value: Headers) =>
      value.get("cookie") === "fixture=owner" ? owner : null,
    close: async () => {},
  } as unknown as AuthService;
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const createApp = async () => {
    const app = await buildApp({
      databaseUrl,
      databaseSchema: schema,
      queueSchema,
      auth,
      githubFetch: fetch,
      discoverModels: async () => [
        {
          name: "qwen3.5:4b",
          digest: "fixture-digest",
          sizeBytes: 1,
          parameterSize: null,
          quantization: null,
          capabilities: ["completion"],
          contextLength: 8192,
        },
      ],
    });
    apps.push(app);
    return app;
  };
  const app = await createApp();
  t.after(async () => {
    for (const app of apps) await app.close();
    await repository.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  const execute = async (runId: string) =>
    processDevelopmentJob({
      repository,
      workerId,
      runner: developmentFixtureRunner(),
      generate: async () => ({
        patch: developmentFixturePatch,
        usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
        modelDigest: "fixture-local-digest",
      }),
      job: { data: { workspaceId: "local-workspace", runId } },
    });
  return {
    app,
    createApp,
    repository,
    workerId,
    execute,
    calls,
    sql,
    schema,
    setIssue: (value: unknown) => {
      issue = value;
    },
  };
}
test(
  "owner-only development HTTP workflow on isolated PostgreSQL",
  { skip: !databaseUrl },
  async (t) => {
    await t.test(
      "owner and origin checks protect even encoded paths, and development bypass grants no access",
      async (t) => {
        const { app, calls } = await fixture(t);
        for (const url of [
          "/v1/development",
          "/v1/development/runtime",
          "/%76%31/development",
        ]) {
          assert.equal(
            (await app.inject({ method: "GET", url })).statusCode,
            401,
          );
        }
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/development",
              headers: { cookie: headers.cookie },
              payload: developmentFixtureInput(),
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/development",
              headers: { ...headers, origin: "http://host.invalid" },
              payload: developmentFixtureInput(),
            })
          ).statusCode,
          403,
        );
        assert.equal(calls.length, 0);
        const directory = await mkdtemp(
          join(tmpdir(), "vuzmi-development-bypass-"),
        );
        const bypass = await buildApp({ dataDir: directory });
        try {
          for (const url of [
            "/v1/development",
            "/v1/development/runtime",
            `/v1/development/${randomUUID()}`,
          ])
            assert.equal(
              (await bypass.inject({ method: "GET", url })).statusCode,
              401,
            );
          assert.equal(
            (
              await bypass.inject({
                method: "POST",
                url: "/v1/development",
                payload: developmentFixtureInput(),
              })
            ).statusCode,
            401,
          );
        } finally {
          await bypass.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
    await t.test(
      "strict admission retains an optional public issue; exact request replay precedes readiness and network",
      async (t) => {
        const { app, createApp, calls, repository, workerId, setIssue } =
          await fixture(t);
        const runtime = await app.inject({
          method: "GET",
          url: "/v1/development/runtime",
          headers,
        });
        assert.equal(runtime.statusCode, 200);
        assert.equal(runtime.json().ready, true);
        assert.equal(
          runtime.json().profile.profileHash,
          developmentFixtureProfile.profileHash,
        );
        const input = { ...developmentFixtureInput(), issueNumber: 1 };
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/development",
              headers,
              payload: { ...input, commands: ["sh"] },
            })
          ).statusCode,
          400,
        );
        assert.equal(calls.length, 0);
        const created = await app.inject({
          method: "POST",
          url: "/v1/development",
          headers,
          payload: input,
        });
        assert.equal(created.statusCode, 201);
        assert.equal(created.json().run.issue.number, 1);
        assert.equal(calls.length, 2);
        await repository.development.removeHeartbeat(workerId);
        const restarted = await createApp();
        const replay = await restarted.inject({
          method: "POST",
          url: "/v1/development",
          headers,
          payload: input,
        });
        assert.equal(replay.statusCode, 200);
        assert.equal(replay.json().replayed, true);
        assert.equal(replay.json().run.id, created.json().run.id);
        assert.equal(calls.length, 2);
        assert.equal(
          (
            await restarted.inject({
              method: "POST",
              url: "/v1/development",
              headers,
              payload: {
                ...input,
                brief:
                  "Conflicting input must not trigger another public issue fetch.",
              },
            })
          ).statusCode,
          409,
        );
        assert.equal(calls.length, 2);
        await repository.development.heartbeat(workerId, {
          ready: true,
          reason: "Synthetic isolated fixture.",
          profile: developmentFixtureProfile,
        });
        setIssue({
          id: 1234,
          number: 1,
          title: "A pull request",
          body: "Not supported",
          html_url: "https://github.com/Ether-X-UK/Vuzmi/issues/1",
          updated_at: new Date().toISOString(),
          pull_request: {},
        });
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/development",
              headers,
              payload: { ...input, requestId: randomUUID() },
            })
          ).statusCode,
          422,
        );
        assert.equal((await repository.development.list()).length, 1);
      },
    );
    await t.test(
      "captured approval saves an exact stable package and rejection leaves no export or native run",
      async (t) => {
        const { app, execute, sql, schema } = await fixture(t);
        const created = await app.inject({
          method: "POST",
          url: "/v1/development",
          headers,
          payload: developmentFixtureInput(),
        });
        assert.equal(created.statusCode, 201);
        const id = created.json().run.id as string;
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/v1/development/${id}/package`,
              headers,
            })
          ).statusCode,
          409,
        );
        await execute(id);
        const waiting = (
          await app.inject({
            method: "GET",
            url: `/v1/development/${id}`,
            headers,
          })
        ).json().run;
        assert.equal(waiting.status, "waiting_approval");
        assert.equal(
          (await app.inject({ method: "GET", url: `/v1/runs/${id}`, headers }))
            .statusCode,
          404,
        );
        const decision = {
          decision: "approve",
          revision: waiting.revision,
          fingerprint: waiting.reviewFingerprint,
        };
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `/v1/development/${id}/decisions`,
              headers,
              payload: { ...decision, revision: waiting.revision - 1 },
            })
          ).statusCode,
          409,
        );
        const approved = await app.inject({
          method: "POST",
          url: `/v1/development/${id}/decisions`,
          headers,
          payload: decision,
        });
        assert.equal(approved.statusCode, 200);
        assert.equal(approved.json().run.decision.actor, owner.id);
        const events = (
          await sql.query(
            `SELECT count(*)::integer count FROM "${schema}".development_run_events WHERE run_id=$1`,
            [id],
          )
        ).rows[0].count;
        const first = await app.inject({
          method: "GET",
          url: `/v1/development/${id}/package`,
          headers,
        });
        const second = await app.inject({
          method: "GET",
          url: `/v1/development/${id}/package`,
          headers,
        });
        assert.equal(first.statusCode, 200);
        assert.equal(first.body, approved.json().run.artifact.content);
        assert.equal(first.body, second.body);
        assert.equal(first.headers["x-content-sha256"], digest(first.body));
        assert.match(
          first.headers["content-disposition"] as string,
          /^attachment; filename="vuzmi-development-/,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `/v1/development/${id}/decisions`,
              headers,
              payload: decision,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await sql.query(
              `SELECT count(*)::integer count FROM "${schema}".development_run_events WHERE run_id=$1`,
              [id],
            )
          ).rows[0].count,
          events,
        );
        const next = (
          await app.inject({
            method: "POST",
            url: "/v1/development",
            headers,
            payload: developmentFixtureInput(),
          })
        ).json().run;
        await execute(next.id);
        const reject = (
          await app.inject({
            method: "GET",
            url: `/v1/development/${next.id}`,
            headers,
          })
        ).json().run;
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `/v1/development/${next.id}/decisions`,
              headers,
              payload: {
                decision: "reject",
                revision: reject.revision,
                fingerprint: reject.reviewFingerprint,
              },
            })
          ).json().run.status,
          "cancelled",
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/v1/development/${next.id}/package`,
              headers,
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: "/v1/development/invalid-id/package",
              headers,
            })
          ).statusCode,
          404,
        );
      },
    );
  },
);

test(
  "local branch application HTTP authorization is separate, owner/origin-bound, strict and idempotent",
  { skip: !databaseUrl },
  async (t) => {
    const { app, repository, execute, workerId } = await fixture(t);
    const created = await app.inject({
      method: "POST",
      url: "/v1/development",
      headers,
      payload: developmentFixtureInput(),
    });
    const runId = created.json().run.id as string;
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/development/${runId}/application-plan`,
          headers,
        })
      ).statusCode,
      503,
    );
    await repository.applications.heartbeat(workerId, {
      ready: true,
      reason: "Synthetic registered Git fixture; HTTP tests create no refs.",
      repositoryIdentity: "1".repeat(64),
    });
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/development/${runId}/application-plan`,
          headers,
        })
      ).statusCode,
      409,
    );
    await execute(runId);
    const waiting = (await repository.development.get(
      "local-workspace",
      runId,
    ))!;
    await repository.development.decide(
      "local-workspace",
      runId,
      {
        decision: "approve",
        revision: waiting.revision,
        fingerprint: waiting.reviewFingerprint!,
      },
      owner,
    );
    const before = (
      await repository.development.package("local-workspace", runId)
    ).content;
    assert.deepEqual(
      (
        await app.inject({
          method: "GET",
          url: `/v1/development/${runId}/application`,
          headers,
        })
      ).json(),
      { operation: null },
    );
    const planResponse = await app.inject({
      method: "GET",
      url: `/v1/development/${runId}/application-plan`,
      headers,
    });
    assert.equal(planResponse.statusCode, 200);
    const { plan, available } = planResponse.json();
    assert.equal(available, true);
    assert.equal(plan.packageSha256, digest(before));
    const payload = {
        requestId: randomUUID(),
        packageSha256: plan.packageSha256,
        planFingerprint: plan.fingerprint,
      },
      url = `/v1/development/${runId}/application`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { origin: headers.origin },
          payload,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie: headers.cookie },
          payload,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, destinationRef: "refs/heads/main" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, packageSha256: "0".repeat(64) },
        })
      ).statusCode,
      409,
    );
    const authorized = await app.inject({
      method: "POST",
      url,
      headers,
      payload,
    });
    assert.equal(authorized.statusCode, 201);
    assert.equal(authorized.json().operation.actor, owner.id);
    assert.equal(authorized.json().operation.status, "queued");
    await repository.applications.removeHeartbeat(workerId);
    const replay = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().replayed, true);
    assert.deepEqual(replay.json().operation, authorized.json().operation);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/development/${runId}/application-plan`,
          headers,
        })
      ).json().available,
      false,
    );
    assert.equal(
      (await app.inject({ method: "GET", url, headers: {} })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, requestId: randomUUID() },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await repository.development.package("local-workspace", runId)).content,
      before,
    );
  },
);
