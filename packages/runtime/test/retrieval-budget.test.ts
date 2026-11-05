import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresRunRepository, processIndexJob } from "../src/index.js";
import type { KnowledgeEmbedder } from "../src/index.js";

const databaseUrl = process.env.VUZMI_TEST_DATABASE_URL;
const workspace = "local-workspace";
const embed: KnowledgeEmbedder = async ({ texts }) => ({
  profile: {
    provider: "ollama",
    model: "fixture-local",
    digest: "fixture-digest",
    dimensions: 3,
    normalization: "l2",
    version: 1,
    promptVersion: "embeddinggemma-retrieval-v1",
  },
  vectors: texts.map(() => [1, 0, 0]),
});
const textAtBytes = (bytes: number) => {
  const prefix = "Reviewed café context. ";
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix, "utf8"));
};

test(
  "retrieval omits a one-byte tail but preserves complete short source and memory facts",
  { skip: !databaseUrl },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `budget_test_${suffix}`,
      queueSchema = `budget_queue_${suffix}`;
    const repository = await PostgresRunRepository.connect({
      connectionString: databaseUrl!,
      schema,
      queueSchema,
    });
    const sql = new Pool({ connectionString: databaseUrl! });
    t.after(async () => {
      await repository.close();
      await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
      await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
      await sql.end();
    });
    const sources = (
      await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.knowledge.createSource(workspace, {
            title: "Reviewed source context",
            format: "text",
            text: "Initial bounded source context.",
          }),
        ),
      )
    ).sort((left, right) => left.id.localeCompare(right.id));
    // Equal semantic scores and no lexical matches make production's stable ID
    // ordering deterministic; every fixture still traverses parsing and indexing.
    async function setBytes(index: number, bytes: number) {
      const source = sources[index]!;
      sources[index] = await repository.knowledge.updateSource(
        workspace,
        source.id,
        {
          title: source.title,
          format: source.format,
          revision: source.revision,
          text: textAtBytes(bytes),
        },
      );
      await processIndexJob({
        repository,
        embed,
        job: {
          data: {
            workspaceId: workspace,
            sourceId: source.id,
            revision: sources[index]!.revision,
          },
          retryCount: 0,
        },
      });
    }
    const selection = {
      sourceIds: sources.map((source) => source.id),
      memoryIds: [] as string[],
    };
    const checkBudgetAndHashes = (
      items: Array<{ text: string; contentHash: string }>,
    ) => {
      assert.ok(
        items.reduce(
          (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
          0,
        ) <= 2400,
      );
      for (const item of items)
        assert.equal(
          item.contentHash,
          createHash("sha256").update(item.text).digest("hex"),
        );
    };
    for (const [index, bytes] of [800, 800, 799, 200].entries())
      await setBytes(index, bytes);
    const bounded = await repository.knowledge.search(
      selection,
      "quasar",
      embed,
    );
    assert.deepEqual(
      bounded.items.map((item) => Buffer.byteLength(item.text, "utf8")),
      [800, 800, 799],
    );
    assert.ok(bounded.items.every((item) => item.ownerId !== sources[3]!.id));
    checkBudgetAndHashes(bounded.items);

    await setBytes(2, 760);
    await setBytes(3, 40);
    const shortSource = await repository.knowledge.search(
      selection,
      "quasar",
      embed,
    );
    assert.deepEqual(
      shortSource.items.map((item) => Buffer.byteLength(item.text, "utf8")),
      [800, 800, 760, 40],
    );
    assert.equal(
      shortSource.items[3]!.text,
      textAtBytes(40),
      "a complete fact shorter than eighty bytes remains useful",
    );
    checkBudgetAndHashes(shortSource.items);

    const memoryText = "quasar needs review.".padEnd(40, ".");
    const memory = await repository.knowledge.createMemory(workspace, {
      title: "Short curated fact",
      content: memoryText,
      provenance: { kind: "operator" },
      expiresAt: null,
    });
    const shortMemory = await repository.knowledge.search(
      { sourceIds: selection.sourceIds.slice(0, 3), memoryIds: [memory.id] },
      "quasar",
      embed,
    );
    assert.deepEqual(
      shortMemory.items.map((item) => Buffer.byteLength(item.text, "utf8")),
      [800, 800, 760, 40],
    );
    assert.equal(shortMemory.items[3]!.kind, "memory");
    assert.equal(shortMemory.items[3]!.text, memoryText);
    checkBudgetAndHashes(shortMemory.items);
  },
);
