// test-gate.test.mjs — contract pins for scripts/bounded-gate.mjs (issues #398 + #521).
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
//
// Issue #521's seam: the gate claims to grade "what CI grades", and CI
// grades with a bare `node --test` whose default discovery is RECURSIVE —
// every `*.test.mjs` in the tree, every `.mjs` under any directory named
// `test/` (not just `smoke.mjs`), the `-test`/`_test`/`test-*`/`test.mjs`
// name shapes, `node_modules` and dot-directories skipped. An earlier
// enumeration listed only the shell parity form, so the claim held only on
// a tree that had never grown one of those shapes. The discovery pins
// below hold the enumeration to the real thing from two independent
// sides: a REAL bare `node --test` run on a planted fixture tree (ground
// truth — whatever node version executes the pin), and an independent
// walker over the LIVE tree (so a regression to the narrow form reds even
// where the two sets happen to coincide).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverSuites } from "../scripts/bounded-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "scripts", "bounded-gate.mjs");
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
    "scripts/bounded-gate.mjs must parse — it is the local gate's degrade-loud path");
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

test("a non-numeric knob is a typed bad-knob error before any suite runs — never a green suite reported HANG (issue #538)", () => {
  const f = fixtureDir();
  try {
    const green = f.suite("green.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("passes", () => assert.equal(1 + 1, 2));
`);
    // the #538 repro: Number("abc") is NaN, Math.max(1, NaN) is NaN, and
    // setTimeout(fn, NaN) fires ~immediately — the pre-guard gate SIGKILLed
    // this green suite at 0.0s and reported it HANG with a diagnostic
    // blaming "an ambient seam"
    const res = runGate([green], "abc");
    assert.equal(res.status, 2, `a bad knob must exit typed-2 before any suite runs, stdout: ${res.stdout}`);
    assert.match(res.stderr, /bad knob/, "the error must be typed (bad knob)");
    assert.match(res.stderr, /DSH_TEST_GATE_TIMEOUT_S/, "the error must name the knob");
    assert.match(res.stderr, /"abc"/, "the error must name the offending value");
    assert.doesNotMatch(res.stdout, /HANG/, "a green suite must NEVER be reported HANG over a malformed knob");
    assert.doesNotMatch(res.stdout, /green\.test\.mjs/, "no suite may run under a bad knob — the failure is the knob, not a suite");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a sub-1 knob is the same bad knob — the 1s insta-kill floor is not a usable bound (issue #538)", () => {
  const f = fixtureDir();
  try {
    const green = f.suite("green.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("passes", () => assert.equal(1 + 1, 2));
`);
    for (const bad of ["0", "-5"]) {
      const res = runGate([green], bad);
      assert.equal(res.status, 2, `knob ${bad} must exit typed-2, stdout: ${res.stdout}`);
      assert.match(res.stderr, /bad knob/, `knob ${bad} must be typed (bad knob)`);
      assert.doesNotMatch(res.stdout, /HANG/, `knob ${bad} must never surface as a suite HANG`);
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a blank knob falls to the 120s default — only a malformed value is a bad knob (issue #538)", () => {
  const f = fixtureDir();
  try {
    const green = f.suite("green.test.mjs", `
import { test } from "node:test";
import assert from "node:assert/strict";
test("passes", () => assert.equal(1 + 1, 2));
`);
    const res = runGate([green], "");
    assert.equal(res.status, 0, `a blank knob must fall to the default bound, stderr: ${res.stderr}`);
    assert.match(res.stdout, /ok +.*green\.test\.mjs/, "the suite must pass under the default bound");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the docs teach the bounded gate as the in-session recipe (issue #398)", () => {
  for (const [doc, mustMatch] of [
    ["README.md", [/node scripts\/bounded-gate\.mjs/, /DSH_TEST_GATE_TIMEOUT_S/]],
    ["CLAUDE.md", [/node scripts\/bounded-gate\.mjs/]],
  ]) {
    const text = read(doc);
    for (const re of mustMatch) {
      assert.match(text, re, `${doc} must teach the bounded gate (${re})`);
    }
  }
});

// --- issue #521: the enumeration IS bare `node --test` discovery ----------

// The planted fixture tree for the discovery pins. Every graded file's
// test name IS its repo-relative path, so the bare run's TAP output names
// exactly which files discovery picked — no reporter-format guessing.
const discoveryFixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-gate-discovery-"));
  const plant = (rel) => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    // one passing test named after the file itself
    writeFileSync(abs, `import test from "node:test";\ntest(${JSON.stringify(rel)}, () => {});\n`);
  };
  return { dir, plant };
};

test("the default enumeration equals a REAL bare node --test discovery on a fixture tree (issue #521)", () => {
  const f = discoveryFixture();
  try {
    // the shapes bare discovery grades (issue #521 receipts)
    f.plant("a.test.mjs");                          // top-level *.test.mjs
    f.plant("sub/deep.test.mjs");                   // recursive *.test.mjs
    f.plant("tests/one.test.mjs");                  // under tests/ (plural)
    f.plant("tests/fixtures/two.test.mjs");         // recursive under tests/ — the finding's example
    f.plant("plugins/foo/test/smoke.mjs");          // the legacy parity form's shape
    f.plant("plugins/bar/test/other.mjs");          // non-smoke .mjs under test/ — the finding's example
    f.plant("plugins/bar/test/helpers/nested.mjs"); // recursive under test/
    f.plant("dist/e.test.mjs");                     // build dirs are NOT skipped
    f.plant("b-test.mjs");                          // the *-test name shape
    f.plant("test-d.mjs");                          // the test-* name shape
    // the shapes bare discovery does NOT grade
    writeFileSync(path.join(f.dir, "tests", "helper.mjs"), "export const h = 1;\n"); // plural dir, plain name
    mkdirSync(path.join(f.dir, "testy"), { recursive: true });
    writeFileSync(path.join(f.dir, "testy", "straight.mjs"), "export const s = 1;\n"); // dir `testy` is not `test`
    f.plant("node_modules/pkg/x.test.mjs");         // the runner skips node_modules
    f.plant("node_modules/pkg/test/y.mjs");         // node_modules skip beats the test-dir rule
    f.plant(".hidden/test/z.mjs");                  // dot-directories are invisible to the glob

    // REAL bare discovery: the exact invocation CI's Unit tests step runs.
    // NODE_TEST_CONTEXT is stripped (the #398 false-green seam — the pin
    // itself may execute under `node --test`, and the marker handed down
    // verbatim makes runner children skip awaiting their tests).
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], {
      cwd: f.dir,
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `every planted suite must pass, stderr: ${res.stderr}`);

    // top-level TAP entries only (nested subtests are indented)
    const graded = [...res.stdout.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
    assert.ok(graded.length >= 10, `the TAP parse must find the graded files, got ${graded.length}: ${res.stdout.slice(0, 500)}`);

    const relGraded = graded.map((p) => path.relative(f.dir, path.resolve(f.dir, p))).sort();
    const enumerated = discoverSuites(f.dir);
    assert.deepEqual(
      enumerated,
      relGraded,
      "the gate's enumeration must equal bare `node --test` discovery — set-for-set (issue #521)",
    );

    // the shapes that motivated the finding — loud legs, so a TAP-parse
    // decay reds instead of passing vacuously
    for (const must of [
      "tests/fixtures/two.test.mjs",
      "plugins/bar/test/other.mjs",
      "plugins/bar/test/helpers/nested.mjs",
      "dist/e.test.mjs",
    ]) {
      assert.ok(relGraded.includes(must), `bare discovery must grade ${must} (issue #521)`);
      assert.ok(enumerated.includes(must), `the gate must enumerate ${must} (issue #521)`);
    }
    for (const never of ["tests/helper.mjs", ".hidden/test/z.mjs", "testy/straight.mjs"]) {
      assert.ok(!relGraded.includes(never), `bare discovery must NOT grade ${never}`);
      assert.ok(!enumerated.includes(never), `the gate must NOT enumerate ${never}`);
    }
    assert.ok(!enumerated.some((p) => p.includes("node_modules")), "node_modules is never enumerated (issue #521 receipt)");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// An INDEPENDENT expression of bare discovery (recursive walk + the six
// documented match rules) — the live-tree census. It shares no code with
// the gate's glob-based enumeration, so a regression to the narrow form
// reds here even on a tree where the narrow and wide sets coincide.
const bareDiscoveryWalk = (root) => {
  const hits = [];
  const visit = (relDir) => {
    for (const d of readdirSync(path.join(root, relDir), { withFileTypes: true })) {
      // dot-entries are invisible to the glob engine's default (dot:false);
      // node_modules is the test runner's own exclusion (issue #521 receipts)
      if (d.name.startsWith(".") || d.name === "node_modules") continue;
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isDirectory()) {
        visit(rel);
        continue;
      }
      if (!d.isFile() || !/\.[cm]?js$/.test(d.name)) continue;
      const name = d.name;
      const inTestDir = rel.split("/").slice(0, -1).includes("test");
      if (
        inTestDir ||
        name.endsWith(".test.js") || name.endsWith(".test.cjs") || name.endsWith(".test.mjs") ||
        /-test\.[cm]?js$/.test(name) || /_test\.[cm]?js$/.test(name) ||
        /^test-.+\.[cm]?js$/.test(name) || /^test\.[cm]?js$/.test(name)
      ) {
        hits.push(rel);
      }
    }
  };
  visit("");
  return hits.sort();
};

test("live-tree census: the enumerated set equals an independent bare-discovery walk (issue #521 AC 2)", () => {
  const enumerated = discoverSuites(ROOT);
  const walked = bareDiscoveryWalk(ROOT);
  assert.deepEqual(
    enumerated,
    walked,
    "the gate's enumeration must equal bare discovery ON THE LIVE TREE — " +
    "a file CI would grade that the gate misses is the #521 drift seam red-handed",
  );
  // the legacy floor: everything the narrow parity form covered is still in
  for (const d of readdirSync(path.join(ROOT, "tests"), { withFileTypes: true })) {
    if (d.isFile() && d.name.endsWith(".test.mjs")) {
      assert.ok(enumerated.includes(`tests/${d.name}`), `top-level suite tests/${d.name} must stay enumerated`);
    }
  }
  for (const d of readdirSync(path.join(ROOT, "plugins"), { withFileTypes: true })) {
    if (d.isDirectory()) {
      const smoke = `plugins/${d.name}/test/smoke.mjs`;
      if (existsSync(path.join(ROOT, smoke))) {
        assert.ok(enumerated.includes(smoke), `plugin smoke ${smoke} must stay enumerated`);
      }
    }
  }
  assert.ok(enumerated.length >= 1, "the enumeration must never be empty on the live tree");
});

test("the gate script's own name stays outside node's test-match set — CI never grades the gate as a suite (issue #521)", () => {
  // `test-gate.mjs` matched node's `**/test-*.?(c|m)js` default pattern:
  // CI's bare `node --test` would grade the gate AS A SUITE (the runner
  // spawns it, the CLI guard fires, and the wide enumeration — which now
  // includes the file — self-spawns without bound). The census pin above
  // already holds enumeration == discovery, so a rename back to a matched
  // name reds there too; this pin names the reason at the file itself.
  assert.ok(!discoverSuites(ROOT).includes("scripts/bounded-gate.mjs"), "the gate must never enumerate itself");
  for (const re of [/\.test\.[cm]?js$/, /-test\.[cm]?js$/, /_test\.[cm]?js$/, /^test-/, /^test\.[cm]?js$/]) {
    assert.doesNotMatch("bounded-gate.mjs", re, `the gate script name must stay outside node's default test patterns (${re}) — the #521 self-grading seam`);
  }
});

test("the mirror keeps the narrow form's files while grading the shapes it missed (issue #521 shape guards)", () => {
  const f = discoveryFixture();
  try {
    f.plant("tests/a.test.mjs");               // narrow form: graded
    f.plant("tests/fixtures/b.test.mjs");      // narrow form MISSED this
    f.plant("plugins/p/test/smoke.mjs");       // narrow form: graded
    f.plant("plugins/p/test/other.mjs");       // narrow form MISSED this
    writeFileSync(path.join(f.dir, "tests", "helper.mjs"), "export const h = 1;\n");
    mkdirSync(path.join(f.dir, "plugins", "p", "lib"), { recursive: true });
    writeFileSync(path.join(f.dir, "plugins", "p", "lib", "x.mjs"), "export const x = 1;\n");

    const got = discoverSuites(f.dir);
    for (const must of ["tests/a.test.mjs", "tests/fixtures/b.test.mjs", "plugins/p/test/smoke.mjs", "plugins/p/test/other.mjs"]) {
      assert.ok(got.includes(must), `must enumerate ${must}, got: ${JSON.stringify(got)}`);
    }
    for (const never of ["tests/helper.mjs", "plugins/p/lib/x.mjs"]) {
      assert.ok(!got.includes(never), `must NOT enumerate ${never}`);
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
