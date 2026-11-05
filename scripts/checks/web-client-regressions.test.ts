import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// Sealed adapter: keep the original fixture files in separate Node test
// processes, preserving their hook/global isolation and relative imports.
const files = [
  "apps/web/test/api-session-expiry.test.ts",
  "apps/web/test/draft-session.test.ts",
  "apps/web/test/proposal-review.test.ts",
];
const manifest = JSON.parse(
  readFileSync("/opt/vuzmi/checks/regressions-manifest.json", "utf8"),
) as { names: string[] };
assert.ok(
  Array.isArray(manifest.names) &&
    manifest.names.length === 19 &&
    new Set(manifest.names).size === 19 &&
    manifest.names.every(
      (name) =>
        typeof name === "string" && name.length <= 200 && !/[\r\n]/.test(name),
    ),
  "The sealed regression manifest must contain exactly nineteen names.",
);
const observed = spawnSync(
  "/usr/local/bin/node",
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    ...files.map((path) => `/opt/vuzmi/repository/${path}`),
  ],
  {
    cwd: "/opt/vuzmi/repository",
    // In particular, do not inherit the outer runner's NODE_TEST_CONTEXT/IPC
    // mode into a fresh test controller. Its stdout must be its own TAP stream.
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGKILL",
    maxBuffer: 128 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
// Node's outer test reporter marks these captured child bytes as diagnostics.
// A candidate's printed TAP cannot become an outer acceptance test result.
if (observed.stdout) console.log(observed.stdout);
if (observed.stderr) console.error(observed.stderr);
if (observed.error)
  console.error("The bounded sealed fixture subprocess did not complete.");
const lines = (observed.stdout ?? "").split(/\r?\n/);
const results = lines.flatMap((line) => {
  const match = /^(not ok|ok) ([1-9][0-9]*) - (.+)$/.exec(line);
  return match
    ? [{ index: Number(match[2]), name: match[3], passed: match[1] === "ok" }]
    : [];
});
const pass = results.filter((result) => result.passed).length;
const sound =
  !observed.error &&
  !observed.signal &&
  (observed.status === 0 || (observed.status === 1 && pass < 19)) &&
  lines.includes("TAP version 13") &&
  lines.filter((line) => /^1\.\./.test(line)).length === 1 &&
  lines.includes("1..19") &&
  results.length === 19 &&
  results.every(
    (result, index) =>
      result.index === index + 1 && result.name === manifest.names[index],
  ) &&
  Object.entries({
    tests: 19,
    pass,
    fail: 19 - pass,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  }).every(
    ([key, value]) =>
      lines.filter((line) => line.startsWith(`# ${key} `)).length === 1 &&
      lines.includes(`# ${key} ${value}`),
  );
for (const [index, name] of manifest.names.entries()) {
  test(name, () => {
    assert.equal(
      sound && results[index]?.passed,
      true,
      "The immutable fixture did not produce the required complete passing evidence; inspect the captured subprocess diagnostics.",
    );
  });
}
