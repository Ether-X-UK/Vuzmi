import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  DomainError,
  DraftRevisionError,
  extractDraftBody,
  renderDraftDocument,
} from "@vuzmi/core";
import type { ReviseDraftInput, Run } from "@vuzmi/core";
import { PostgresRunRepository, RunNotFoundError } from "../src/index.js";

const url = process.env.VUZMI_TEST_DATABASE_URL;
const workspace = "local-workspace";
const actor = { id: "fixture-owner", name: "Fixture owner" };
const brief = {
  title: "Correct local release draft",
  brief:
    "Prepare a local release document for human correction before approval.",
  domain: "build" as const,
  mode: "ollama" as const,
};
async function fixture(t: TestContext) {
  const schema = `amend_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    queueSchema = `${schema}_queue`;
  const options = { connectionString: url!, schema, queueSchema };
  const repository = await PostgresRunRepository.connect(options),
    sql = new Pool({ connectionString: url!, max: 2 });
  const repositories = [repository];
  t.after(async () => {
    for (const item of repositories) await item.close();
    await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
    await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
    await sql.end();
  });
  async function reopen() {
    const next = await PostgresRunRepository.connect(options);
    repositories.push(next);
    return next;
  }
  async function waiting() {
    const queued = await repository.create(brief, {
      workspaceId: workspace,
      id: randomUUID(),
      model: "fixture-local-model",
    });
    const running = await repository.claim(workspace, queued.id, {
      attemptId: randomUUID(),
    });
    assert.ok(running);
    const run = await repository.complete(workspace, queued.id, {
      attemptId: running.attemptId!,
      expectedRevision: running.revision,
      content: renderDraftDocument("Original model wording."),
      usage: { inputTokens: 10, outputTokens: 20, durationMs: 30 },
    });
    assert.ok(run);
    return run;
  }
  return { repository, sql, schema, queueSchema, reopen, waiting };
}
function edit(run: Run, body = "Human corrected wording."): ReviseDraftInput {
  return {
    editId: randomUUID(),
    revision: run.revision,
    fingerprint: run.proposal!.fingerprint,
    body,
    reason: "Correct inaccurate wording.",
  };
}
const expectedCode = (code: string) => (error: unknown) =>
  error instanceof DraftRevisionError && error.code === code;

test(
  "draft amendment PostgreSQL durability and serialization",
  { skip: !url },
  async (t) => {
    await t.test(
      "exact corrected bytes and prior proposals survive reopen; replay writes no duplicate events or artifacts",
      async (t) => {
        const { repository, sql, schema, queueSchema, reopen, waiting } =
          await fixture(t);
        const original = await waiting();
        const body =
            "# Corrected café 🚀\r\n\r\n  Preserve exact spaces.  \r\n\n",
          input = edit(original, body);
        const first = await repository.amend(
          workspace,
          original.id,
          input,
          actor,
        );
        assert.equal(first.revision, original.revision + 1);
        assert.equal(
          extractDraftBody(first.proposal!.content, undefined, "human"),
          body,
        );
        assert.deepEqual(
          first.draftRevisions![0]!.previousProposal,
          original.proposal,
        );
        const other = await reopen();
        assert.deepEqual(await other.get(workspace, original.id), first);
        const replay = await other.amend(workspace, original.id, input, actor);
        assert.deepEqual(replay, first);
        const second = await other.amend(
          workspace,
          original.id,
          edit(first, "Another exact correction."),
          actor,
        );
        assert.deepEqual(
          second.draftRevisions![1]!.previousProposal,
          first.proposal,
        );
        assert.deepEqual(
          await repository.amend(workspace, original.id, input, actor),
          second,
          "A first-edit retry must return the current head without overwriting a later edit.",
        );
        const approved = await repository.decide(
          workspace,
          original.id,
          {
            decision: "approve",
            revision: second.revision,
            fingerprint: second.proposal!.fingerprint,
          },
          actor,
        );
        assert.deepEqual(
          await other.amend(workspace, original.id, input, actor),
          approved,
          "Exact replay after approval is still a no-op.",
        );
        assert.equal(approved.artifact!.content, second.proposal!.content);
        assert.equal(approved.draftRevisions!.length, 2);
        const effects = await sql.query(
          `SELECT (SELECT count(*)::integer FROM "${schema}".run_events WHERE run_id=$1 AND event->>'type'='draft.revised') AS edits,(SELECT count(*)::integer FROM "${schema}".artifacts WHERE run_id=$1) AS artifacts,(SELECT count(*)::integer FROM "${queueSchema}".job WHERE data->>'runId'=$1) AS jobs`,
          [original.id],
        );
        assert.deepEqual(
          effects.rows[0],
          { edits: 2, artifacts: 1, jobs: 1 },
          "Human corrections cannot enqueue another model call.",
        );
        const final = await reopen();
        assert.deepEqual(await final.get(workspace, original.id), approved);
      },
    );

    await t.test(
      "simultaneous same-UUID delivery saves once while stale or conflicting requests cannot overwrite",
      async (t) => {
        const { repository, reopen, waiting, sql, schema } = await fixture(t);
        const other = await reopen(),
          initial = await waiting(),
          input = edit(initial);
        const results = await Promise.all([
          repository.amend(workspace, initial.id, input, actor),
          other.amend(workspace, initial.id, input, actor),
        ]);
        assert.deepEqual(results[0], results[1]);
        assert.equal(results[0]!.draftRevisions!.length, 1);
        await assert.rejects(
          repository.amend(
            workspace,
            initial.id,
            { ...input, body: "Conflicting text." },
            actor,
          ),
          expectedCode("EDIT_ID_CONFLICT"),
        );
        await assert.rejects(
          other.amend(
            workspace,
            initial.id,
            { ...input, editId: randomUUID() },
            actor,
          ),
          expectedCode("STALE_DRAFT"),
        );
        await assert.rejects(
          repository.decide(
            workspace,
            initial.id,
            {
              decision: "approve",
              revision: initial.revision,
              fingerprint: initial.proposal!.fingerprint,
            },
            actor,
          ),
          (error) =>
            error instanceof DomainError && error.code === "STALE_APPROVAL",
        );
        await assert.rejects(
          repository.amend("other-workspace", initial.id, input, actor),
          RunNotFoundError,
        );
        const count = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}".run_events WHERE run_id=$1 AND event->>'type'='draft.revised'`,
          [initial.id],
        );
        assert.equal(count.rows[0].count, 1);
      },
    );

    await t.test(
      "amendment and approval on independent pools serialize to one outcome from the displayed revision",
      async (t) => {
        const { repository, reopen, waiting, sql, schema } = await fixture(t);
        const other = await reopen();
        const initial = await waiting();
        const results = await Promise.allSettled([
          repository.amend(workspace, initial.id, edit(initial), actor),
          other.decide(
            workspace,
            initial.id,
            {
              decision: "approve",
              revision: initial.revision,
              fingerprint: initial.proposal!.fingerprint,
            },
            actor,
          ),
        ]);
        assert.equal(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        assert.equal(
          results.filter((result) => result.status === "rejected").length,
          1,
        );
        const saved = await repository.get(workspace, initial.id);
        assert.ok(saved);
        const count = await sql.query(
          `SELECT count(*)::integer count FROM "${schema}".artifacts WHERE run_id=$1`,
          [initial.id],
        );
        if (saved.status === "completed") {
          assert.equal(saved.artifact!.content, initial.proposal!.content);
          assert.equal(saved.draftRevisions, undefined);
          assert.equal(count.rows[0].count, 1);
          await assert.rejects(
            repository.amend(workspace, initial.id, edit(saved), actor),
            expectedCode("DRAFT_NOT_EDITABLE"),
          );
        } else {
          assert.equal(saved.status, "waiting_approval");
          assert.equal(saved.draftRevisions!.length, 1);
          assert.equal(saved.artifact, undefined);
          assert.equal(count.rows[0].count, 0);
          await assert.rejects(
            other.decide(
              workspace,
              initial.id,
              {
                decision: "approve",
                revision: initial.revision,
                fingerprint: initial.proposal!.fingerprint,
              },
              actor,
            ),
            (error) =>
              error instanceof DomainError && error.code === "STALE_APPROVAL",
          );
        }
      },
    );

    await t.test(
      "approval and rejection freeze the exact final proposal and a corrupted retained chain is refused on reads",
      async (t) => {
        const { repository, waiting, sql, schema, reopen } = await fixture(t);
        const original = await waiting(),
          amended = await repository.amend(
            workspace,
            original.id,
            edit(original),
            actor,
          );
        const rejected = await repository.decide(
          workspace,
          original.id,
          {
            decision: "reject",
            revision: amended.revision,
            fingerprint: amended.proposal!.fingerprint,
          },
          actor,
        );
        await assert.rejects(
          repository.amend(workspace, rejected.id, edit(rejected), actor),
          expectedCode("DRAFT_NOT_EDITABLE"),
        );
        assert.equal(rejected.artifact, undefined);
        const invalid = structuredClone(rejected);
        invalid.draftRevisions![0]!.previousProposal.content =
          "Tampered original model output";
        await sql.query(
          `UPDATE "${schema}".runs SET aggregate=$3::jsonb WHERE workspace_id=$1 AND id=$2`,
          [workspace, rejected.id, JSON.stringify(invalid)],
        );
        const other = await reopen();
        await assert.rejects(
          other.get(workspace, rejected.id),
          /fingerprint|retained chain/i,
        );
        await assert.rejects(
          other.amend(workspace, rejected.id, edit(rejected), actor),
          /fingerprint|retained chain/i,
        );
      },
    );
  },
);
