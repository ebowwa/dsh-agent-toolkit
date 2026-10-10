// live-boot-probe — pins for the shared live-boot helper
// (tests/lib/live-boot.mjs, issue #594).
//
// The composed-tree boot smoke reds under the full suite's parallel file
// execution on a loaded box: the real dsh child starves, terminates with
// EMPTY stdout AND stderr, and the credential-wall match reds — while the
// quiet single-file rerun is green on the same tree (issue #594 receipts:
// two independent full-suite runs, 125s wall, empty output). The helper's
// retry is honest because a real defect PRINTS: the plugin-load drift shape
// the boot proof exists to catch dies loudly, and the credential wall
// itself prints MISSING_CREDENTIAL. These pins hold the three contracts the
// live legs depend on, OFFLINE (stub `node -e` commands — no dsh, no
// profile tree, no live boot):
//   1. an empty-output termination is starvation-shaped → retried once
//      (default budget 2 attempts), and the bookkeeping says so;
//   2. a diagnostic-bearing result returns on attempt 1 — the retry budget
//      is never spent on (and never masks) an honest failure;
//   3. the wiring is real spawnSync: utf8 strings out, caller options
//      (env, cwd, timeout) reach the child per attempt.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProbe, starvedBoot } from "./lib/live-boot.mjs";

// A stub that appends one mark to the counter file EVERY time it runs, so a
// pin can count attempts exactly. `node -e` puts the first trailing arg at
// process.argv[1].
const COUNTER_STUB = 'require("node:fs").appendFileSync(process.argv[1], "x\\n");';

function counterPath(dir) {
  const p = join(dir, "attempts.counter");
  writeFileSync(p, "");
  return p;
}
const count = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l === "x").length;

test("starvedBoot: empty and whitespace-only output is the starvation shape; any diagnostic is not", () => {
  assert.equal(starvedBoot({ stdout: "", stderr: "" }), true, "both streams empty → starved");
  assert.equal(starvedBoot({ stdout: " \n\t", stderr: "" }), true, "whitespace-only carries no verdict either");
  assert.equal(starvedBoot({ stdout: null, stderr: undefined }), true, "unencoded/null streams (a killed child) are the starved shape too");
  assert.equal(starvedBoot({ stdout: "", stderr: "FATAL: boom\n" }), false, "a stderr diagnostic is a verdict — not starved");
  assert.equal(starvedBoot({ stdout: "MISSING_CREDENTIAL: no api key\n", stderr: "" }), false, "the credential wall itself is a verdict — not starved");
});

test("an empty-output termination is retried once (default budget: 2 attempts) and the bookkeeping names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bootprobe-starved-"));
  try {
    const counter = counterPath(dir);
    // exit 3 with NO output every time — the twice-starved shape.
    const { boot, attemptsRan, starvationRetried } = bootProbe({
      command: process.execPath,
      args: ["-e", `${COUNTER_STUB} process.exit(3);`, counter],
    });
    assert.equal(attemptsRan, 2, "default budget is exactly 2 attempts");
    assert.equal(starvationRetried, true, "a starved first attempt must be retried");
    assert.equal(count(counter), 2, "the stub really ran twice — the retry is a fresh spawn, not bookkeeping");
    assert.equal(boot.status, 3, "the LAST attempt's result is what the caller's assertions see");
    assert.equal(`${boot.stdout}${boot.stderr}`, "", "still the empty-output shape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a diagnostic-bearing result returns on attempt 1 — the retry never masks an honest failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bootprobe-diagnostic-"));
  try {
    const counter = counterPath(dir);
    // exit 1 WITH a stderr diagnostic — the real-defect shape (the
    // plugin-load drift dies loudly); one attempt, no retry.
    const { boot, attemptsRan, starvationRetried } = bootProbe({
      command: process.execPath,
      args: ["-e", `${COUNTER_STUB} process.stderr.write("does not provide an export named SessionSeq\\n"); process.exit(1);`, counter],
    });
    assert.equal(attemptsRan, 1, "a diagnostic-bearing attempt is a verdict — no retry");
    assert.equal(starvationRetried, false, "retry bookkeeping stays false");
    assert.equal(count(counter), 1, "exactly one spawn");
    assert.match(boot.stderr, /does not provide an export/, "the diagnostic reaches the caller's assertions intact");
    assert.equal(boot.status, 1, "the honest failure surfaces — nothing is masked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the green path is untouched: one attempt, first result wins (issue #594 must not slow the quiet box)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bootprobe-green-"));
  try {
    const counter = counterPath(dir);
    const { boot, attemptsRan, starvationRetried } = bootProbe({
      command: process.execPath,
      args: ["-e", `${COUNTER_STUB} process.stdout.write("MISSING_CREDENTIAL: no api key\\n");`, counter],
    });
    assert.equal(attemptsRan, 1, "one attempt on a verdict-bearing first spawn");
    assert.equal(starvationRetried, false, "no retry on the green path");
    assert.equal(count(counter), 1, "exactly one spawn");
    assert.equal(boot.status, 0, "exit status passes through");
    assert.match(boot.stdout, /MISSING_CREDENTIAL/, "the credential-wall shape reaches the assertions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wiring is real spawnSync: utf8 strings out, caller options reach the child per attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bootprobe-wiring-"));
  try {
    // env passthrough: the child sees the caller-pinned variable (the live
    // legs pin DSH_HOME and strip credentials through exactly this path);
    // utf8 proof: a non-ASCII byte through the pipe must decode as é, not
    // mojibake — the live legs' /MISSING_CREDENTIAL/ match needs strings,
    // and an undecoded buffer would fail that match confusingly.
    const { boot } = bootProbe({
      command: process.execPath,
      args: ["-e", 'process.stdout.write(`CANARY=${process.env.DSH_BOOTPROBE_CANARY ?? "missing"} CREDé`);'],
      options: { env: { ...process.env, DSH_BOOTPROBE_CANARY: "reached-the-child" }, cwd: dir, timeout: 30_000 },
    });
    assert.equal(typeof boot.stdout, "string", "encoding utf8 is forced — the live legs' combined-output asserts depend on it");
    assert.match(boot.stdout, /CANARY=reached-the-child/, "caller env reaches the child");
    assert.match(boot.stdout, /CREDé$/, "the child's bytes decode as utf8 (not latin1 mojibake or a raw buffer)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The stub itself must be sound: a spawnSync of process.execPath really
// works in this suite's environment (guards the pins above against an
// environment where node cannot spawn — they would red HERE, with a name,
// instead of as confusing retry-count mismatches).
test("sanity: the stub mechanism spawns at all in this environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-bootprobe-sanity-"));
  try {
    const counter = counterPath(dir);
    const r = spawnSync(process.execPath, ["-e", `${COUNTER_STUB}`, counter], { encoding: "utf8" });
    assert.equal(r.status, 0, `stub spawn must succeed: ${r.stderr}`);
    assert.equal(count(counter), 1, "one mark per run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
