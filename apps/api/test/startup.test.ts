import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const fakeDatabase = "postgresql://fixture:fixture@127.0.0.1:1/unused_fixture";

function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const value = { ...process.env };
  // Neither copied configuration nor child imports may inherit operator secrets
  // or an external database. Only explicit, inert fixture settings are supplied.
  for (const key of Object.keys(value)) {
    if (
      /^(VUZMI_|OLLAMA_|BETTER_AUTH_|DATABASE_URL$|PORT$|NODE_OPTIONS$|NODE_PATH$)/.test(
        key,
      )
    )
      delete value[key];
  }
  return { ...value, NODE_ENV: "test", ...extra };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vuzmi-startup-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "apps/web/dist"), { recursive: true });
  await mkdir(join(root, "apps/api/src"), { recursive: true });
  await mkdir(join(root, "packages/runtime/src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(root, "apps/web/dist/index.html"),
    "<title>Isolated fixture</title>",
  );
  await copyFile(
    join(repositoryRoot, "scripts/start-local.mjs"),
    join(root, "scripts/start-local.mjs"),
  );
  await copyFile(
    join(repositoryRoot, "packages/runtime/src/config.ts"),
    join(root, "packages/runtime/src/config.ts"),
  );
  let source = await readFile(
    join(repositoryRoot, "apps/api/src/index.ts"),
    "utf8",
  );
  for (const [original, replacement] of [
    ['from "./app.js"', 'from "./app.fixture.js"'],
    [
      'from "@vuzmi/runtime/config"',
      'from "../../../packages/runtime/src/config.ts"',
    ],
    ['from "@vuzmi/auth"', 'from "./auth.fixture.js"'],
  ]) {
    assert.ok(
      source.includes(original),
      "Fixture isolation must match each real startup import before executing it.",
    );
    source = source.replace(original!, replacement!);
  }
  await writeFile(join(root, "apps/api/src/index.ts"), source);
  await writeFile(
    join(root, "apps/api/src/app.fixture.js"),
    `import {writeFileSync} from 'node:fs';
    export async function buildApp(){writeFileSync(new URL('../../../app-entered',import.meta.url),'fixture');throw new Error('Fixture stops before any listen');}`,
  );
  await writeFile(
    join(root, "apps/api/src/auth.fixture.js"),
    `import {writeFileSync} from 'node:fs';
    export class AuthService{static async connect(){writeFileSync(new URL('../../../auth-entered',import.meta.url),'fixture');throw new Error('Fixture stops before any database connection');}}`,
  );
  const launch = (path: string, extra?: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--import", tsxLoader, path], {
      cwd: root,
      env: environment(extra),
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 64 * 1024,
    });
  const entered = async (name: string) => {
    try {
      await access(join(root, name));
      return true;
    } catch {
      return false;
    }
  };
  return { root, launch, entered };
}

test("self-host launcher rejects bypasses loaded from root dotenv before spawning services", async (t) => {
  for (const setting of ["VUZMI_DEV_NO_AUTH=1", "VUZMI_SIMULATION_ONLY=1"]) {
    await t.test(setting, async (t) => {
      const { root, launch, entered } = await fixture(t);
      await writeFile(join(root, ".env"), setting + "\n", { mode: 0o600 });
      const result = launch("scripts/start-local.mjs");
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /self-host command requires owner authentication and PostgreSQL/,
      );
      assert.doesNotMatch(result.stdout, /processes started/);
      assert.equal(await entered("app-entered"), false);
      assert.equal(await entered("auth-entered"), false);
    });
  }
});

test("built API independently refuses effective dotenv auth bypass before auth/database/listen", async (t) => {
  for (const relative of [".env", ".data/dev/database.env"]) {
    await t.test(relative, async (t) => {
      const { root, launch, entered } = await fixture(t);
      await mkdir(join(root, ".data/dev"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, relative),
        `VUZMI_DEV_NO_AUTH=1\nDATABASE_URL=${fakeDatabase}\n`,
        { mode: 0o600 },
      );
      const result = launch("apps/api/src/index.ts", { VUZMI_SERVE_WEB: "1" });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Vuzmi local API could not start/);
      assert.equal(
        await entered("app-entered"),
        false,
        "A built self-host must reject effective no-auth configuration before building routes.",
      );
      assert.equal(
        await entered("auth-entered"),
        false,
        "This test must never connect an auth database.",
      );
    });
  }
});

test("explicit simulation development remains possible without opening real services", async (t) => {
  const { root, launch, entered } = await fixture(t);
  await writeFile(
    join(root, ".env"),
    "VUZMI_DEV_NO_AUTH=1\nVUZMI_SIMULATION_ONLY=1\n",
    { mode: 0o600 },
  );
  const result = launch("apps/api/src/index.ts");
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    1,
    "The inert build stub deliberately stops the subprocess.",
  );
  assert.equal(
    await entered("app-entered"),
    true,
    "The private development path remains explicit rather than globally removing simulation support.",
  );
  assert.equal(await entered("auth-entered"), false);
});
