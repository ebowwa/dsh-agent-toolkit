// test-gate.test.mjs — contract pins for scripts/test-gate.mjs (issue #398).
//
// Issue #398's failure mode: the local gate (`node --test tests/*.test.mjs`)
// has NO per-suite bound, so one wedged suite holds the whole gate until the
// cell's external timeout kills it — the agent sees "timed out" with zero
// diagnostics. A suite that cannot run hermetically must FAIL LOUD naming
// the seam, never hang the gate. These pins grade the runner's three
// contracts: a hung suite is killed at the bound and reported as HANG with
// a typed diagnostic (the kill-vs-hang differential, the #450 posture), a
// green suite passes through with exit 0, a red suite propagates exit 1
// with its name. The fixtures live in a per-test tmpdir — NEVER in tests/
// (bare CI discovery grades every tests/*.test.mjs; a planted sleeper would
// hang CI exactly like the wedge these pins close).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "scripts", "test-gate.mjs");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const runGate = (args, timeoutS) =>
  spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DSH_TEST_GATE_TIMEOUT_S: String(timeoutS) },
  });

// A per-test scratch dir holding fixture suites. Returned paths are passed
// to the gate explicitly (positional), so the gate never enumerates the
// real tree from inside these pins.
const fixtureDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-gate-pin-"));
  return { dir, suite: (name, body) => {
    writeFileSync(path.join(dir, name), body);
    return path.join(dir, name);
  } };
};

test("the gate runner exists and parses (node --check)", () => {
  assert.equal(spawnSync(process.execPath, ["--check", GATE]).status, 0,
    "scripts/test-gate.mjs must parse — it is the local gate's degrade-loud path");
});

test("a wedged suite is killed at the bound and reported HANG with a typed diagnostic — never a silent gate wedge (issue #398)", () => {
  const f = fixtureDir();
  try {
    // a suite that never reaches a verdict: a pending timer keeps the
    // event loop alive; node --test would wait forever without the bound
    const wedged = f.suite("wedged.test.mjs", `
import { test } from "node:test";
test("never finishes", () => new Promise(() => { setTimeout(() => {}, 120_000); }));
`);
    const started = Date.now();
    const res = runGate([wedged], 2);
    const elapsed = (Date.now() - started) / 1000;
    assert.equal(res.status, 1, `the gate must exit red on a wedged suite, stderr: ${res.stderr}`);
    assert.ok(elapsed < 30, `the kill must land at the bound (~2s), not wedge: took ${elapsed.toFixed(1)}s`);
    assert.match(res.stdout, /HANG/, "the verdict line must say HANG");
    assert.match(res.stdout, /wedged\.test\.mjs/, "the diagnostic must name the wedged suite");
    assert.match(res.stdout, /::error::/, "the diagnostic must be typed (::error::) so it surfaces in CI logs");
    assert.match(res.stdout, /DSH_TEST_GATE_TIMEOUT_S/, "the diagnostic must name the bound knob");
    assert.match(res.stdout, /--only wedged\.test\.mjs/, "the diagnostic must carry the pinpoint recipe");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a green suite passes through with exit 0", () => {
  const f = fixtureDir();
  try {
    const green = f.suite("green.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("passes", () => assert.equal(1 + 1, 2));
`);
    const res = runGate([green], 30);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /ok +.*green\.test\.mjs/, "the verdict line must say ok (the verdict prints the suite path)");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a red suite propagates exit 1 and is named", () => {
  const f = fixtureDir();
  try {
    const red = f.suite("red.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("fails", () => assert.equal(1 + 1, 3));
`);
    const res = runGate([red], 30);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /red +.*red\.test\.mjs/, "the verdict line must say red and name the suite (the verdict prints the suite path)");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the docs teach the bounded gate as the in-session recipe (issue #398)", () => {
  for (const [doc, mustMatch] of [
    ["README.md", [/node scripts\/test-gate\.mjs/, /DSH_TEST_GATE_TIMEOUT_S/]],
    ["CLAUDE.md", [/node scripts\/test-gate\.mjs/]],
  ]) {
    const text = read(doc);
    for (const re of mustMatch) {
      assert.match(text, re, `${doc} must teach the bounded gate (${re})`);
    }
  }
});
