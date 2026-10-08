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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootProbe, starvedBoot } from "./lib/live-boot.mjs";
import { dshSpawnScan } from "./lib/dsh-spawn-scan.mjs";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

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

// The live legs must RIDE the probe (issue #595): a bare live leg — any
// spawn/spawnSync/execFile-family call whose command is the dsh literal
// (either quote form or a template) or a dsh-bound alias const —
// re-introduces the under-load starvation red this helper exists for.
// The only bare dsh command a mount suite may carry is the fast
// `["--version"]` presence probe (sub-second, no load exposure) — every
// real leg (boot AND dump-config) goes through bootProbe, whose retry is
// already pinned above. The match is the shared widened scanner
// (tests/lib/dsh-spawn-scan.mjs): the original double-quoted-spawnSync-
// only pin let single-quoted, alias-const, and async forms through with
// the pin green (issue #607), so the allowed shape is enforced in
// symmetric form — the one bare site must BE a --version probe.
test("the live legs ride the probe — no bare dsh command spawn in the mount suites (issue #595)", () => {
  for (const f of ["session-query-mount.test.mjs", "search-compose-mount.test.mjs"]) {
    const src = readFileSync(join(TESTS_DIR, f), "utf8");
    assert.match(src, /import \{ bootProbe \} from "\.\/lib\/live-boot\.mjs"/, `${f} imports the shared probe`);
    const sites = dshSpawnScan(src);
    assert.equal(
      sites.length,
      1,
      `${f}: only the --version presence probe may spawn dsh bare (found ${sites.length} bare dsh command spawns — the live legs go through bootProbe, issue #595)`,
    );
    assert.equal(
      sites[0].versionProbe,
      true,
      `${f}: the one bare dsh spawn must be the ["--version"] presence probe (got: ${sites[0].command} — every real leg rides bootProbe, issue #595)`,
    );
  }
});

// run-dsh-agent's live legs ride the probe too (issue #600): both dump
// shapes (--dump-config, --dump-default-config) and all three
// stamped-overlay boots. The mount suites' exactly-one pin above does
// not transfer as-is — this file skip-gates FOUR tests on the
// `--version` presence probe — so the budget here is SHAPE-based, not
// count-based: every bare dsh command spawn in the file must be a
// ["--version"] probe, and the file must import the shared probe. The
// scan is the shared widened scanner (tests/lib/dsh-spawn-scan.mjs), so
// a future bare-spawnSync live leg reds here, offline, in ANY of the
// spellings the original double-quoted-only pin missed — single-quoted,
// template, alias-const command, async spawn, execFile family (the
// #600 receipt: a multi-line form first slipped one grep; #607's
// receipt: the quote-form/variable/async space slipped the whole pin).
test("the live legs ride the probe — run-dsh-agent's bare dsh spawns are only its --version skip gates (issue #600)", () => {
  const f = "run-dsh-agent.test.mjs";
  const src = readFileSync(join(TESTS_DIR, f), "utf8");
  assert.match(src, /import \{ bootProbe \} from "\.\/lib\/live-boot\.mjs"/, `${f} imports the shared probe`);
  const sites = dshSpawnScan(src);
  const live = sites.filter((s) => !s.versionProbe);
  assert.deepEqual(
    live,
    [],
    `${f}: only the --version presence probes may spawn dsh bare (found ${live.length} live-leg-shaped bare dsh command spawn(s): ${live.map((s) => `${s.command} @ line ${s.line}`).join(", ")} — the live legs go through bootProbe, issue #600)`,
  );
  assert.ok(sites.length > 0, `${f} still skip-gates on the --version presence probe (the gate itself must not vanish)`);
});

// The widened scanner's own negative controls — issue #607's acceptance
// criteria, run offline against text (no fixture file is written, no dsh
// is spawned). Each evasion spelling the original double-quoted-only pin
// missed must scan as a bare NON-probe dsh site, and the sanctioned
// shapes must stay clean. The fixtures ride the `leg()` assembler so no
// source line of THIS file carries the spawn-head-+-dsh-command
// adjacency that the corpus lint (tests-lint rule 3) hunts: the pieces
// are clean; only their runtime join is the defect.
const LIVE_ARGV = '["--profile", "headless", "reply ok"]';
const leg = (head, cmd, argv) => `${head}(${cmd}, ${argv}, { encoding: "utf8" });`;

test("negative controls: every evasion spelling the old pin missed now scans as a live leg (issue #607)", () => {
  const forms = [
    ["single-quoted command (the issue's exact repro form)", leg("spawnSync", "'dsh'", LIVE_ARGV)],
    ["template-literal command", leg("spawnSync", "`dsh`", LIVE_ARGV)],
    ["async spawn (the pr#603 review receipt)", leg("spawn", '"dsh"', LIVE_ARGV)],
    ["execFileSync (the sync execFile family)", leg("execFileSync", '"dsh"', LIVE_ARGV)],
    ["dsh-bound alias const, sync form", 'const DSH = "dsh";\n' + leg("spawnSync", "DSH", LIVE_ARGV)],
    ["dsh-bound alias const, async form", 'const DSH = "dsh";\n' + leg("spawn", "DSH", LIVE_ARGV)],
    ["dsh-bound alias const, execFile form", 'const dshBin = `dsh`;\n' + leg("execFile", "dshBin", LIVE_ARGV)],
  ];
  for (const [name, fixture] of forms) {
    const sites = dshSpawnScan(fixture);
    assert.equal(sites.length, 1, `${name}: exactly one bare dsh site`);
    assert.equal(sites[0].versionProbe, false, `${name}: it is NOT the sanctioned --version probe — the shape invariant reds`);
  }
});

test("negative control on the real source: a single-quoted bare leg appended to run-dsh-agent's text reds the shape pin (issue #607 repro)", () => {
  const f = "run-dsh-agent.test.mjs";
  const src = readFileSync(join(TESTS_DIR, f), "utf8");
  const before = dshSpawnScan(src);
  assert.ok(before.length > 0, "baseline: the file still carries its --version gates");
  assert.ok(before.every((s) => s.versionProbe), "baseline: unmodified, every bare dsh site is a --version probe");
  const after = dshSpawnScan(`${src}\n${leg("spawnSync", "'dsh'", LIVE_ARGV)}`);
  assert.equal(
    after.filter((s) => !s.versionProbe).length,
    1,
    "the appended single-quoted bare leg is a live leg — the shape invariant reds where the old pin stayed green (8/8 on the original)",
  );
});

test("sanctioned shapes stay clean: bootProbe legs, stub paths, non-dsh commands, dead comment text", () => {
  assert.deepEqual(
    dshSpawnScan('const { boot } = bootProbe({ command: "dsh", args: ["--dump-config"] });'),
    [],
    "bootProbe's command option is the sanctioned leg — not a bare spawn",
  );
  assert.deepEqual(
    dshSpawnScan('spawnSync(join(bin, "dsh"), ["--dump-config"]);'),
    [],
    "a transitively computed stub path is out of the matcher's reach (documented) — a stub executable is not a live leg",
  );
  assert.deepEqual(dshSpawnScan('spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });'), [], "non-dsh commands never mint sites");
  assert.deepEqual(dshSpawnScan("// spawnSync('dsh', [\"--dump-config\"]);"), [], "commented text is dead");
  assert.deepEqual(
    dshSpawnScan('const DSH = "dsh";\nconst present = spawnSync(DSH, ["--version"]).status === 0;'),
    [{ line: 2, command: "DSH", versionProbe: true }],
    "an alias-command --version probe is the sanctioned shape, in symmetric form",
  );
});
