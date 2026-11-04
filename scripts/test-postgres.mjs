import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { startPostgres, stopPostgres, root } from "./dev-services.mjs";

const stateDir = await mkdtemp(join(tmpdir(), "vuzmi-postgres-test-"));
let started = false;
try {
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const connectionString = startPostgres(stateDir, port);
  started = true;
  const testDir = join(root, "packages/runtime/test");
  const tests = (await readdir(testDir))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => join(testDir, name));
  const apiTestDir = join(root, "apps/api/test");
  tests.push(
    ...(await readdir(apiTestDir))
      .filter((name) => name.endsWith(".postgres.ts"))
      .map((name) => join(apiTestDir, name)),
  );
  const authTestDir = join(root, "packages/auth/test");
  tests.push(
    ...(await readdir(authTestDir))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => join(authTestDir, name)),
  );
  if (!tests.length)
    throw new Error("No PostgreSQL integration tests were found.");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", ...tests],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, VUZMI_TEST_DATABASE_URL: connectionString },
    },
  );
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", (code) => resolve(code ?? 1)),
  );
} finally {
  if (started) stopPostgres(stateDir);
  await rm(stateDir, { recursive: true, force: true });
}
