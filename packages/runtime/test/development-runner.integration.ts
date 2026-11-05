import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  DEVELOPMENT_CHECK_NAMES,
  developmentBaselineReproduced,
  validateDevelopmentCandidate,
  type DevelopmentProfile,
} from "@vuzmi/core";
import {
  createDevelopmentRunner,
  executeDockerCommand,
  loadDevelopmentRunnerConfig,
  type DockerExecutor,
} from "../src/development-runner.js";

// Explicit isolated-runtime gate. This file is not part of the fixture/PG glob:
// provision first, then node --import tsx --test this file. Missing setup fails.
// No generated program executes on the host; every candidate is only COPY data
// until the production runner has inspected its effective container policy.
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const fresh = (phase: "baseline" | "candidate" = "candidate") => {
  const runId = randomUUID(),
    attemptId = randomUUID();
  return {
    runId,
    attemptId,
    executionId: `vuzmi-dev-${runId}-${attemptId}-${phase}`,
  };
};
function corrected(profile: DevelopmentProfile, suffix = "") {
  const before = profile.files[0].text;
  const body =
    before
      .replace(
        "  let body: unknown;",
        '  if (response.status === 401)\n    window.dispatchEvent(new Event("vuzmi:session-expired"));\n  let body: unknown;',
      )
      .replace(
        '    if (response.status === 401)\n      window.dispatchEvent(new Event("vuzmi:session-expired"));\n',
        "",
      ) + suffix;
  assert.notEqual(body, before);
  return validateDevelopmentCandidate(
    {
      summary: "Synthetic runner QA fixture repairs status-authority handling.",
      files: [
        {
          path: profile.files[0].path,
          beforeSha256: profile.files[0].sha256,
          content: body,
        },
      ],
    },
    profile,
    hash,
  );
}

test("real offline runner reproduces the pinned bug then passes the correction with observed confinement", async () => {
  const runner = createDevelopmentRunner();
  const ready = await runner.readiness();
  assert.equal(ready.ready, true, ready.reason);
  const profile = ready.profile!;
  const baselineInput = fresh("baseline");
  const baseline = await runner.run({ ...baselineInput, phase: "baseline" });
  assert.equal(
    developmentBaselineReproduced(baseline),
    true,
    JSON.stringify(baseline),
  );
  const probe = String.raw`
void (async () => {
const fsProbe = await import('node:fs');
const netProbe = await import('node:net');
const checkProbe = (await import('node:assert/strict')).default;
checkProbe.equal(process.getuid(), 1000);
const statusProbe = fsProbe.readFileSync('/proc/self/status','utf8');
checkProbe.match(statusProbe, /NoNewPrivs:\s+1/);
checkProbe.match(statusProbe, /CapEff:\s+0+\n/);
checkProbe.deepEqual(fsProbe.readdirSync('/sys/class/net'), ['lo']);
checkProbe.equal(fsProbe.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(), '128');
checkProbe.equal(fsProbe.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(), '536870912');
checkProbe.equal(fsProbe.existsSync('/var/run/docker.sock'), false);
checkProbe.equal(fsProbe.existsSync('/Users'), false);
checkProbe.throws(() => fsProbe.writeFileSync('/opt/vuzmi/denied-write','fixture'));
fsProbe.writeFileSync('/tmp/noexec-probe', '#!/bin/sh\nexit 0\n', {mode: 0o700});
const spawnedProbe = (await import('node:child_process')).spawnSync('/tmp/noexec-probe');
checkProbe.equal(spawnedProbe.error?.code, 'EACCES');
for (const hostProbe of ['1.1.1.1', '192.168.5.2', 'host.docker.internal']) {
  const deniedProbe = await new Promise((resolve) => {
    const socketProbe = netProbe.createConnection({host:hostProbe,port:443});
    const timerProbe = setTimeout(() => { socketProbe.destroy(); resolve(true); }, 600);
    socketProbe.once('connect', () => { clearTimeout(timerProbe); socketProbe.destroy(); resolve(false); });
    socketProbe.once('error', () => { clearTimeout(timerProbe); resolve(true); });
  });
  checkProbe.equal(deniedProbe, true, 'network access must be denied');
}
console.log('VUZMI_POLICY_PROBE: nonroot,readonly,nonetwork,nosocket,capdrop,nnp,pids,memory,noexec');
})();
`;
  const input = fresh();
  const check = await runner.run({
    ...input,
    phase: "candidate",
    candidate: corrected(profile, probe),
  });
  assert.equal(check.status, "passed", JSON.stringify(check));
  assert.equal(check.policyVerified, true);
  assert.match(check.stdout, /VUZMI_POLICY_PROBE/);
  assert.equal(check.tests.length, 6);
  assert.notEqual(check.imageId, check.baseImageId);
  assert.equal(await runner.cleanup(input.executionId), true);
  assert.equal(await runner.cleanup(baselineInput.executionId), true);
});

test("real candidate cannot self-exit early or flood output into passing evidence", async () => {
  const runner = createDevelopmentRunner();
  const profile = loadDevelopmentRunnerConfig().profile;
  const early = await runner.run({
    ...fresh(),
    phase: "candidate",
    candidate: corrected(profile, "\nprocess.exit(0);\n"),
  });
  assert.notEqual(early.status, "passed");
  assert.equal(early.tests.length, 0);
  const flooded = await runner.run({
    ...fresh(),
    phase: "candidate",
    candidate: corrected(profile, "\nconsole.log('x'.repeat(200000));\n"),
  });
  assert.notEqual(flooded.status, "passed");
  assert.equal(flooded.truncated, true);
  assert.ok(Buffer.byteLength(flooded.stdout) <= 65540);
});

test("candidate stdout cannot impersonate the six sealed acceptance results", async () => {
  const runner = createDevelopmentRunner(),
    profile = loadDevelopmentRunnerConfig().profile;
  const fake = [
    "TAP version 13",
    ...DEVELOPMENT_CHECK_NAMES.map((name, i) => `ok ${i + 1} - ${name}`),
    "1..6",
    "# tests 6",
    "# pass 6",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
  ].join("\n");
  const check = await runner.run({
    ...fresh(),
    phase: "candidate",
    candidate: corrected(
      profile,
      `\nconsole.log(${JSON.stringify(fake)}); process.exit(0);\n`,
    ),
  });
  assert.notEqual(check.status, "passed", JSON.stringify(check));
  assert.equal(check.tests.length, 0);
  assert.match(check.stdout, /# ok 1 - unreadable 401/);
});

test("real cancellation kills the exact owned running container and cleanup is repeatable", async () => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execute: DockerExecutor = (connection, args, options) => {
    if (args[0] === "start") timer = setTimeout(() => controller.abort(), 1000);
    return executeDockerCommand(connection, args, options);
  };
  const runner = createDevelopmentRunner({ execute });
  const profile = loadDevelopmentRunnerConfig().profile,
    input = fresh();
  try {
    const check = await runner.run({
      ...input,
      phase: "candidate",
      candidate: corrected(profile, "\nsetInterval(() => {}, 1000);\n"),
      signal: controller.signal,
    });
    assert.equal(check.status, "cancelled", JSON.stringify(check));
    assert.equal(await runner.cleanup(input.executionId), true);
  } finally {
    clearTimeout(timer);
    await runner.cleanup(input.executionId);
  }
});

test("real memory exhaustion records OOM rather than a successful check", async () => {
  const runner = createDevelopmentRunner(),
    profile = loadDevelopmentRunnerConfig().profile;
  const check = await runner.run({
    ...fresh(),
    phase: "candidate",
    candidate: corrected(
      profile,
      "\nconst memoryFixture: Buffer[] = []; setInterval(() => memoryFixture.push(Buffer.alloc(32 * 1024 * 1024, 1)), 10);\n",
    ),
  });
  assert.equal(check.status, "oom_killed", JSON.stringify(check));
  assert.notEqual(check.exitCode, 0);
});

test("real wall-clock deadline kills unfinished checks and never reports pass", async () => {
  const runner = createDevelopmentRunner(),
    profile = loadDevelopmentRunnerConfig().profile;
  const check = await runner.run({
    ...fresh(),
    phase: "candidate",
    candidate: corrected(profile, "\nsetInterval(() => {}, 1000);\n"),
  });
  assert.equal(check.status, "timed_out", JSON.stringify(check));
  assert.ok(check.durationMs >= 30000 && check.durationMs < 60000);
});
