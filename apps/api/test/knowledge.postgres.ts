import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresRunRepository, startWorker } from "@vuzmi/runtime";
import type { KnowledgeEmbedder } from "@vuzmi/runtime";
import type { EmbeddingProfile, Run, Source } from "@vuzmi/core";
import { buildApp } from "../src/app.js";

const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL;
const profile: EmbeddingProfile = {
  provider: "ollama",
  model: "fixture-embedding",
  digest: "fixture-digest",
  dimensions: 3,
  normalization: "l2",
  version: 1,
  promptVersion: "embeddinggemma-retrieval-v1",
};
const embed: KnowledgeEmbedder = async ({ texts }) => ({
  profile,
  vectors: texts.map((text) => (/banana/i.test(text) ? [0, 1, 0] : [1, 0, 0])),
});

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 8000;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        "The durable API workflow did not reach its expected state.",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test(
  "knowledge HTTP workflow on real PostgreSQL and pg-boss",
  { skip: !databaseUrl },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `api_knowledge_${suffix}`;
    const queueSchema = `api_queue_${suffix}`;
    const repository = await PostgresRunRepository.connect({
      connectionString: databaseUrl!,
      schema,
      queueSchema,
    });
    let generationCalls = 0;
    const worker = await startWorker({
      repository,
      embed,
      generate: async (input) => {
        generationCalls += 1;
        assert.equal(input.evidence?.status, "matched");
        return {
          content:
            "# Proposed release\n\nThe local alpha produces reviewed artifacts [S1].",
          usage: { inputTokens: 10, outputTokens: 10, durationMs: 1 },
        };
      },
    });
    const app = await buildApp({
      databaseUrl,
      databaseSchema: schema,
      queueSchema,
      embedKnowledge: embed,
      discoverProfile: async () => profile,
      discoverModels: async () => [
        {
          name: "fixture-local",
          digest: "fixture-model",
          sizeBytes: 1,
          parameterSize: null,
          quantization: null,
          capabilities: ["completion"],
          contextLength: 8192,
        },
      ],
    });
    t.after(async () => {
      await worker.stop();
      await repository.close();
      await app.close();
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
      } finally {
        await pool.end();
      }
    });
    const sourceResponse = await app.inject({
      method: "POST",
      url: "/v1/knowledge/sources",
      payload: {
        title: "Alpha product scope",
        format: "markdown",
        text: "# Vuzmi alpha\n\nVuzmi alpha release preparation produces local reviewed Markdown artifacts. Deployment and publication require separate implementation and authorization.",
      },
    });
    assert.equal(sourceResponse.statusCode, 202);
    const sourceId = sourceResponse.json().source.id as string;
    const source = await until(
      async () =>
        (
          await app.inject({
            method: "GET",
            url: `/v1/knowledge/sources/${sourceId}`,
          })
        ).json<{ source: Source }>().source,
      (value) => value.status === "ready" || value.status === "failed",
    );
    assert.equal(source.status, "ready");
    const catalogue = await app.inject({ method: "GET", url: "/v1/knowledge" });
    assert.equal(catalogue.statusCode, 200);
    assert.equal(catalogue.json().embedding.available, true);
    const selection = { sourceIds: [sourceId], memoryIds: [] };
    const search = await app.inject({
      method: "POST",
      url: "/v1/knowledge/search",
      payload: {
        query: "What does the Vuzmi alpha release produce?",
        selection,
      },
    });
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().result.status, "matched");
    assert.equal(search.json().result.items[0].ownerId, sourceId);
    const created = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        title: "Prepare alpha release",
        brief: "Describe the Vuzmi alpha local reviewed artifact scope.",
        domain: "build",
        mode: "ollama",
        model: "fixture-local",
        knowledge: selection,
      },
    });
    assert.equal(created.statusCode, 202);
    const runId = created.json().run.id as string;
    const draft = await until(
      async () =>
        (await app.inject({ method: "GET", url: `/v1/runs/${runId}` })).json<{
          run: Run;
        }>().run,
      (value) => ["waiting_approval", "failed"].includes(value.status),
    );
    assert.equal(draft.status, "waiting_approval");
    assert.equal(draft.evidence?.items[0]?.ownerId, sourceId);
    assert.ok(draft.proposal);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/decisions`,
      payload: {
        decision: "approve",
        revision: draft.revision,
        fingerprint: draft.proposal.fingerprint,
      },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().run.artifact.content, draft.proposal.content);
    const irrelevant = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        title: "Banana smoothie recipe",
        brief: "Describe bananas and smoothie ingredients only.",
        domain: "build",
        mode: "ollama",
        model: "fixture-local",
        knowledge: selection,
      },
    });
    assert.equal(irrelevant.statusCode, 202);
    const failed = await until(
      async () =>
        (
          await app.inject({
            method: "GET",
            url: `/v1/runs/${irrelevant.json().run.id}`,
          })
        ).json<{ run: Run }>().run,
      (value) => ["waiting_approval", "failed"].includes(value.status),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.evidence?.status, "insufficient");
    assert.equal(failed.proposal, null);
    assert.equal(generationCalls, 1);
    const memory = await app.inject({
      method: "POST",
      url: "/v1/knowledge/memories",
      payload: {
        title: "Alpha local boundary",
        content: "The alpha retains approved artifacts locally.",
        provenance: {
          kind: "source",
          sourceId,
          sourceRevision: source.revision,
        },
        expiresAt: null,
      },
    });
    assert.equal(memory.statusCode, 201);
    const memoryId = memory.json().memory.id as string;
    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/knowledge/memories/${memoryId}`,
      payload: {
        title: "Changed boundary",
        content: "Operator-reviewed local work.",
        provenance: { kind: "operator" },
        expiresAt: null,
        revision: 99,
      },
    });
    assert.equal(stale.statusCode, 409);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/knowledge/sources/${sourceId}`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/v1/knowledge/sources/${sourceId}`,
        })
      ).statusCode,
      404,
    );
    const after = await app.inject({ method: "GET", url: "/v1/knowledge" });
    assert.equal(after.json().sources.length, 0);
    assert.equal(after.json().memories.length, 0);
    const history = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
    });
    assert.equal(history.json().run.artifact.content, draft.proposal.content);
    assert.deepEqual(history.json().run.evidence, draft.evidence);
    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        title: "Use deleted source",
        brief: "Prepare another alpha release from the same selected source.",
        domain: "build",
        mode: "ollama",
        model: "fixture-local",
        knowledge: selection,
      },
    });
    assert.equal(unavailable.statusCode, 409);
  },
);
