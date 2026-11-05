import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const loader = createRequire(import.meta.url).resolve("tsx");

test("development model configuration preserves founder defaults and explicit operator choices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vuzmi-model-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages/runtime/src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await copyFile(
    fileURLToPath(new URL("../src/config.ts", import.meta.url)),
    join(root, "packages/runtime/src/config.ts"),
  );
  await writeFile(
    join(root, "inspect.mjs"),
    `import {loadServerConfig} from './packages/runtime/src/config.ts';
    const config=loadServerConfig();
    console.log(JSON.stringify({founder:config.ollamaModel,development:config.ollamaDevelopmentModel}));`,
  );
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(VUZMI_|OLLAMA_|BETTER_AUTH_|DATABASE_URL$|NODE_OPTIONS$|NODE_PATH$)/.test(
        key,
      )
    )
      delete environment[key];
  }
  const inspect = (extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(
      process.execPath,
      ["--import", loader, "inspect.mjs"],
      {
        cwd: root,
        env: { ...environment, ...extra },
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 16_384,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as {
      founder: string;
      development: string;
    };
  };
  assert.deepEqual(inspect(), {
    founder: "qwen3.5:4b",
    development: "qwen3.5:4b",
  });
  assert.deepEqual(inspect({ OLLAMA_MODEL: "fixture-founder" }), {
    founder: "fixture-founder",
    development: "fixture-founder",
  });
  assert.deepEqual(inspect({ OLLAMA_DEVELOPMENT_MODEL: "fixture-local-35b" }), {
    founder: "qwen3.5:4b",
    development: "fixture-local-35b",
  });
  assert.deepEqual(
    inspect({
      OLLAMA_MODEL: "fixture-founder",
      OLLAMA_DEVELOPMENT_MODEL: "fixture-local-35b",
    }),
    { founder: "fixture-founder", development: "fixture-local-35b" },
  );
  assert.deepEqual(
    inspect({ OLLAMA_MODEL: "fixture-founder", OLLAMA_DEVELOPMENT_MODEL: "" }),
    { founder: "fixture-founder", development: "" },
    "An explicit unsupported empty value is not a request for a silent fallback.",
  );
  await writeFile(
    join(root, ".env"),
    "OLLAMA_MODEL=fixture-dotenv-founder\nOLLAMA_DEVELOPMENT_MODEL=fixture-dotenv-development\n",
    { mode: 0o600 },
  );
  assert.deepEqual(
    inspect({ OLLAMA_DEVELOPMENT_MODEL: "fixture-exported-development" }),
    {
      founder: "fixture-dotenv-founder",
      development: "fixture-exported-development",
    },
    "Explicit process configuration takes precedence over the isolated dotenv fixture.",
  );
});
