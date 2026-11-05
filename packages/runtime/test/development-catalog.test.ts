import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  DEVELOPMENT_REGRESSION_PATHS,
  DEVELOPMENT_REGRESSION_COMMAND,
  DEVELOPMENT_REGRESSION_CHECK_FILES,
  DEVELOPMENT_REGRESSION_CHECK_NAMES,
  developmentAcceptanceFingerprintInput,
  developmentProfileFingerprintInput,
} from "@vuzmi/core";
import type { DevelopmentProfile } from "@vuzmi/core";
import { PostgresRunRepository } from "../src/index.js";
import {
  developmentFixtureProfile,
  developmentFixtureInput,
  digest,
} from "./development-fixtures.js";
const url = process.env.VUZMI_TEST_DATABASE_URL;
test(
  "retained immutable catalog admits and claims exact selected hashes across default changes and v4 upgrade",
  { skip: !url },
  async (t) => {
    const suffix = randomUUID().replaceAll("-", ""),
      schema = `catalog_test_${suffix}`,
      queueSchema = `catalog_queue_${suffix}`,
      options = { connectionString: url!, schema, queueSchema };
    let repository = await PostgresRunRepository.connect(options);
    const sql = new Pool({ connectionString: url! });
    t.after(async () => {
      await repository.close();
      await sql.query(`DROP SCHEMA "${queueSchema}" CASCADE`);
      await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
      await sql.end();
    });
    const before = (
      await sql.query(
        `SELECT version,checksum FROM "${schema}".schema_migrations WHERE version<5 ORDER BY version`,
      )
    ).rows;
    const legacy = developmentFixtureProfile,
      workerId = randomUUID();
    await repository.development.heartbeat(workerId, {
      ready: true,
      reason: "Synthetic legacy catalog",
      profile: legacy,
    });
    const run = (
      await repository.development.create(developmentFixtureInput(), {
        id: randomUUID(),
        actor: "fixture-owner",
        profile: legacy,
      })
    ).run;
    await repository.close();
    await sql.query(
      `DROP TABLE "${schema}".development_application_events,"${schema}".development_applications,"${schema}".development_application_runtime,"${schema}".development_profiles`,
    );
    await sql.query(
      `ALTER TABLE "${schema}".development_runtime DROP COLUMN profiles`,
    );
    await sql.query(
      `DELETE FROM "${schema}".schema_migrations WHERE version=5`,
    );
    repository = await PostgresRunRepository.connect(options);
    assert.deepEqual(
      (
        await sql.query(
          `SELECT version,checksum FROM "${schema}".schema_migrations WHERE version<5 ORDER BY version`,
        )
      ).rows,
      before,
    );
    assert.deepEqual(
      await repository.development.get("local-workspace", run.id),
      run,
    );
    const unsigned = {
      ...legacy,
      id: "web-client-regressions" as const,
      files: DEVELOPMENT_REGRESSION_PATHS.map((path) => {
        const text = `export const fixture = ${JSON.stringify(path)};\n`;
        return { path, text, sha256: digest(text) };
      }),
      command: [
        ...DEVELOPMENT_REGRESSION_COMMAND,
      ] as DevelopmentProfile["command"],
      sourceTree: "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64),
      checkHarnessSha256: "c".repeat(64),
      checkFiles: DEVELOPMENT_REGRESSION_CHECK_FILES.map((path) => ({
        path,
        sha256: "d".repeat(64),
      })),
      checkNames: [...DEVELOPMENT_REGRESSION_CHECK_NAMES],
      baselineExpectation: "green" as const,
    };
    const greenBase = {
        ...unsigned,
        acceptanceHash: digest(developmentAcceptanceFingerprintInput(unsigned)),
      },
      green = {
        ...greenBase,
        profileHash: digest(developmentProfileFingerprintInput(greenBase)),
      };
    await repository.development.heartbeat(workerId, {
      ready: true,
      reason: "Synthetic verified catalog",
      profile: green,
      profiles: [green, legacy],
    });
    const selected = {
        ...developmentFixtureInput(),
        profileHash: legacy.profileHash,
      },
      created = (
        await repository.development.create(selected, {
          id: randomUUID(),
          actor: "fixture-owner",
          profile: legacy,
        })
      ).run;
    assert.equal(created.profile.profileHash, legacy.profileHash);
    assert.equal((await repository.development.runtime()).profiles!.length, 2);
    await repository.development.heartbeat(workerId, {
      ready: true,
      reason: "Legacy remains available without a default",
      profiles: [legacy],
    });
    assert.equal((await repository.development.runtime()).profile, null);
    assert.ok(
      await repository.development.claim(
        "local-workspace",
        created.id,
        workerId,
        randomUUID(),
      ),
    );
    await repository.development.heartbeat(workerId, {
      ready: true,
      reason: "Only green remains",
      profile: green,
      profiles: [green],
    });
    await assert.rejects(
      repository.development.create(
        { ...selected, requestId: randomUUID() },
        { id: randomUUID(), actor: "fixture-owner", profile: legacy },
      ),
      { code: "DEVELOPMENT_UNAVAILABLE" },
    );
    assert.equal(
      (
        await sql.query(
          `SELECT count(*)::int count FROM "${schema}".development_profiles`,
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (await repository.development.findRequest(
        "local-workspace",
        selected,
        "fixture-owner",
      ))!.id,
      created.id,
    );
  },
);
