import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("PostgreSQL harness stops a partially started cluster before removing its directory", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "vuzmi-postgres-harness-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = join(fixture, "bin");
  const temporary = join(fixture, "temporary");
  const log = join(fixture, "commands.jsonl");
  await mkdir(bin, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  await symlink(process.execPath, join(bin, "node"));

  // The child gets only these fixture commands on PATH. It cannot start an
  // installed PostgreSQL server or inherit operator database configuration.
  const command = `#!/usr/bin/env node
const {appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync} = require('node:fs');
const {basename, join} = require('node:path');
const args = process.argv.slice(2);
const name = basename(process.argv[1]);
const dataDir = args.includes('-D') ? args[args.indexOf('-D') + 1] : undefined;
const record = (action, extra = {}) => appendFileSync(process.env.VUZMI_HARNESS_LOG, JSON.stringify({action, ...extra}) + '\\n', {mode: 0o600});
if (name === 'initdb') {
  mkdirSync(dataDir, {recursive: true, mode: 0o700});
  writeFileSync(join(dataDir, 'PG_VERSION'), '16');
  record('init', {dataDir});
} else if (name === 'pg_ctl') {
  if (args.includes('status')) process.exit(3);
  if (args.includes('start')) {
    writeFileSync(join(dataDir, 'postmaster.pid'), 'synthetic fixture; no process');
    record('start');
  } else if (args.includes('stop')) {
    record('stop', {dataDirectoryPresent: existsSync(dataDir), pidPresent: existsSync(join(dataDir, 'postmaster.pid'))});
    rmSync(join(dataDir, 'postmaster.pid'));
  } else process.exit(99);
} else if (name === 'psql') {
  if (args.some((value) => value.includes('CREATE EXTENSION'))) {
    record('vector-failed');
    process.exit(1);
  }
  process.stdout.write('1\\n');
} else process.exit(98);
`;
  for (const name of ["initdb", "pg_ctl", "psql", "createdb"])
    await writeFile(join(bin, name), command, { mode: 0o700 });

  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/test-postgres.mjs")],
    {
      cwd: repositoryRoot,
      env: { PATH: bin, TMPDIR: temporary, VUZMI_HARNESS_LOG: log },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs pgvector installed/);
  const commands = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          action: string;
          dataDir?: string;
          dataDirectoryPresent?: boolean;
          pidPresent?: boolean;
        },
    );
  assert.deepEqual(
    commands.map((entry) => entry.action),
    ["init", "start", "vector-failed", "stop"],
  );
  assert.deepEqual(commands.at(-1), {
    action: "stop",
    dataDirectoryPresent: true,
    pidPresent: true,
  });
  await assert.rejects(access(commands[0]!.dataDir!), { code: "ENOENT" });
});
