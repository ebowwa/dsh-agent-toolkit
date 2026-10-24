#!/usr/bin/env node
// bounded-gate.mjs — the bounded per-file local test gate (issues #398 + #521).
//
// The docs-taught local gate (`node --test tests/*.test.mjs`) runs every
// suite in ONE process with NO per-suite bound: a single wedged suite —
// issue #398's ambient-hang class, where a suite inside an agent session
// never reaches a verdict — holds the whole gate until the cell's external
// timeout kills it, and the agent sees "timed out" with zero diagnostics.
// A red suite is signal; a HUNG suite is silence, and silence is the worse
// failure mode the gate can produce.
//
// This runner keeps CI's exact per-file grading (same suites, one `node
// --test <file>` child per suite, sequential like CI's default) and adds
// what the bare invocation cannot have:
//
//   1. a hard per-file watchdog — DSH_TEST_GATE_TIMEOUT_S (default 300s,
//      set from the measured load tail documented at DEFAULT_TIMEOUT_S)
//      kills the suite's WHOLE process group and reports HANG, so the gate
//      always degrades loud: every file gets a verdict line (ok / red /
//      HANG) and the loop finishes;
//   2. a typed diagnostic on HANG naming the file, the bound, and the
//      pinpoint recipe (re-run that one file at a tighter bound to catch
//      the wedging seam red-handed);
//   3. the tail of a red/hung suite's TAP output — where it stopped.
//
// The default enumeration IS bare `node --test` discovery (issue #521).
// CI grades with a bare `run: node --test` (gates.yml), whose default
// discovery is RECURSIVE — an earlier draft enumerated only the shell
// parity form (`tests/*.test.mjs` + `plugins/*/test/smoke.mjs`), and the
// two sets coincide only on a tree that has never grown a nested
// `*.test.mjs` or a non-smoke `.mjs` under a `test/` directory: the day
// one lands, CI grades it and the narrow gate stays green. So the gate
// mirrors node's own documented default test-match patterns via node's
// own glob engine (`fs.globSync`, the engine the test runner's discovery
// uses), not a hand-rolled narrower walk:
//
//   **/*.test.?(c|m)js     **/*-test.?(c|m)js    **/*_test.?(c|m)js
//   **/test-*.?(c|m)js     **/test.?(c|m)js      **/test/**/*.?(c|m)js
//
// Empirical receipt (node v24.9.0 probe tree, issue #521): bare `node
// --test` graded 12 files — including `tests/fixtures/two.test.mjs`
// (recursive), `dist/e.test.mjs` (build dirs are NOT skipped),
// `plugins/bar/test/other.mjs` and `plugins/bar/test/helpers/nested.mjs`
// (every `.mjs` under a `test/` dir, recursively) — and skipped
// `node_modules/*` (the test runner's own exclusion, mirrored here
// explicitly), dot-directories, and plural-`tests/` non-matching names
// (`tests/helper.mjs` is invisible; `tests/lib/prose.mjs` stays
// ungraded). `tests/test-gate.test.mjs` pins the enumeration against a
// REAL bare `node --test` run on a fixture tree (ground truth, whatever
// node version executes it) and against the live tree via an independent
// walker.
//
// Usage:
//   node scripts/bounded-gate.mjs                  # the bare-discovery set —
//                                                  #   what CI's `node --test`
//                                                  #   grades (issue #521)
//   node scripts/bounded-gate.mjs tests/foo.test.mjs [more.files...]  # explicit
//   node scripts/bounded-gate.mjs --only run-dsh-agent                # substring pinpoint
//
// Named bounded-gate.mjs — NOT test-gate.mjs — deliberately: the file
// must stay INVISIBLE to the very discovery it mirrors. `test-gate.mjs`
// matches node's `**/test-*.?(c|m)js` default pattern, so CI's bare
// `node --test` would grade the gate AS A SUITE (the runner spawns it,
// the CLI guard below fires, the gate re-enumerates — now including
// itself: unbounded self-spawn recursion). The #521 census pin holds
// the enumeration equal to bare discovery, so the only coherent
// resolution is a script name outside the match set.
//
// Env:
//   DSH_TEST_GATE_TIMEOUT_S  per-suite kill bound (default 300, i.e.
//                            DEFAULT_TIMEOUT_S — unset or blank falls to the
//                            default; a non-numeric or sub-1 value is a
//                            typed bad-knob error, exit 2, before any suite
//                            runs — issue #538)

import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// node's documented default test-match patterns (test-runner docs, node
// v22+; the same strings the bare `node --test` discovery matches against).
// The discovery runs on node >= 22 only — fs.globSync shipped in v22, the
// same lane floor CI's cells already run.
export const DEFAULT_DISCOVERY_PATTERNS = [
  "**/*.test.?(c|m)js",
  "**/*-test.?(c|m)js",
  "**/*_test.?(c|m)js",
  "**/test-*.?(c|m)js",
  "**/test.?(c|m)js",
  "**/test/**/*.?(c|m)js",
];

// The test runner skips node_modules by itself (issue #521 receipt:
// `node_modules/pkg/x.test.mjs` and `node_modules/pkg/test/y.mjs` were the
// only planted shapes bare discovery did NOT grade); the mirror states the
// exclusion explicitly so the gate does not depend on the glob engine
// sharing that policy. Dot-directories are already invisible to the glob
// engine's default (dot:false) — `.hidden/test/z.mjs` did not grade.
const DISCOVERY_EXCLUDE = /(^|\/)(node_modules|\.git)(\/|$)/;

// The bare-discovery set for a repo root: node's six default patterns via
// node's own glob engine, deduped (a file may match two patterns — e.g.
// `test/test.mjs`), sorted. Relative paths, for display and for the
// per-suite spawn (which runs with cwd = repo root, like CI).
export const discoverSuites = (root = ROOT) => {
  const hits = new Set();
  for (const pattern of DEFAULT_DISCOVERY_PATTERNS) {
    for (const hit of globSync(pattern, { cwd: root, exclude: (p) => DISCOVERY_EXCLUDE.test(String(p)) })) {
      hits.add(String(hit));
    }
  }
  return [...hits].sort();
};

// --- the bound, and the MEASUREMENT that sets it (issue #680's class) -----
// A timeout here is a LOAD signal, not a test signal. Both suites below are
// large integration suites — plugin-smoke-deps drives real npm child processes
// through its retry/backoff legs, run-dsh-agent spawns the agent launcher and
// its live probes — and on a busy 2-core box (seed-node-prod-1, the shape this
// gate is used on: `nproc` = 2) they legitimately outrun a tight bound:
//
//   tests/run-dsh-agent.test.mjs       139.4s   measured on the busy 2-core box
//   tests/plugin-smoke-deps.test.mjs   115.0s   measured on the busy 2-core box
//
// At the former 120s default BOTH were killed at 120.2s / 120.1s and reported
// HANG, so a full gate printed "72/74 suites ok — HANG: <those two>" for suites
// that are green. Every lane that reads that HANG as a red then spends a round
// proving its own diff innocent. A hang verdict on a load tail is a FALSE RED,
// and manufacturing false reds is the one failure mode this gate may not have:
// the gate exists to turn silence into signal, not signal into noise.
//
// Hence 300s = 2.15x the measured worst case (139.4s): whole-suite headroom for
// a box that is merely busy rather than wedged. This is NOT slack to hide a real
// wedge — a genuinely wedged suite still never reaches a verdict, so the gate
// still kills it and still says HANG; the bound only lets a load tail prove
// itself innocent first. tests/test-gate.test.mjs holds the floor (>= the
// documented measured facts and >= MIN_HEADROOM_FACTOR x MEASURED_WORST_CASE_S),
// so a future "tighten the timeouts" change has to argue with this measurement
// instead of quietly editing a number.
export const MEASURED_SLOWEST_SUITES = Object.freeze([
  Object.freeze({ rel: "tests/run-dsh-agent.test.mjs", seconds: 139.4 }),
  Object.freeze({ rel: "tests/plugin-smoke-deps.test.mjs", seconds: 115.0 }),
]);
// the box the measurement was taken on — the reason the tail is this long
export const MEASURED_BOX_CORES = 2;
// the worst measured wall time; the bound's floor is derived from this one
export const MEASURED_WORST_CASE_S = 139.4;
// headroom multiplier the default must clear over the measured worst case
export const MIN_HEADROOM_FACTOR = 2;
// The per-suite kill bound default: whole-suite headroom over the measured load
// tail (see the block above — 300s against a 139.4s worst case).
export const DEFAULT_TIMEOUT_S = 300;

// The per-suite kill bound. Resolved inside main() (not at module load):
// the module is importable (the contract pins import discoverSuites), and
// an import must never process.exit over an AMBIENT malformed knob — the
// exit-2-first contract belongs to a gate INVOCATION, whose pins set the
// knob explicitly per spawn. `env` is injectable so the pins grade the
// unset/blank resolution to DEFAULT_TIMEOUT_S without spawning a 300s gate.
export const timeoutS = (env = process.env) => {
  const raw = env.DSH_TEST_GATE_TIMEOUT_S;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_S;
  const n = Number(raw);
  // A non-numeric value Number()s to NaN and Math.max(1, NaN) is NaN —
  // setTimeout(fn, NaN) fires ~immediately and every suite is SIGKILLed at
  // ~0.0s: a fully GREEN suite reported HANG, the exact false alarm the
  // bounded gate exists to prevent (issue #538). A sub-1 value floors to a
  // 1s bound that insta-kills any real suite. Both are operator typos, not
  // suite facts — fail typed BEFORE any suite runs, naming the knob.
  if (!Number.isFinite(n) || n < 1) {
    console.error(
      `test-gate: bad knob — DSH_TEST_GATE_TIMEOUT_S=${JSON.stringify(raw)} is not a positive number of seconds ` +
      `(issue #538: a non-numeric value NaNs the bound and reports green suites HANG at 0.0s; a sub-1 value ` +
      `insta-kills). Unset it for the ${DEFAULT_TIMEOUT_S}s default, or set a bound >= 1.`,
    );
    process.exit(2);
  }
  return n;
};

// Sanitize the runner-parentage marker (issue #398 class, found by the
// gate's own pins): a gate run from INSIDE `node --test` — which is how
// tests/test-gate.test.mjs grades this runner — inherits
// NODE_TEST_CONTEXT=<child-*>. Handed down verbatim, each suite child
// believes it is already a runner child: its test() registrations are
// never awaited and the suite "passes" green in a fraction of a second —
// a silent false-green, worse than a hang. Strip the marker so every
// suite child runs as a fresh top-level `node --test`, whatever ambient
// the gate itself was launched from.
const SUITE_ENV = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
})();

async function main() {
  // the knob check is the FIRST thing an invocation does — a malformed
  // bound exits typed-2 before any suite runs (issue #538)
  const TIMEOUT_S = timeoutS();
  const argv = process.argv.slice(2);

  // --only <substring>: run just the suites whose path carries the substring
  // (the pinpoint step of the #398 recipe: bound the whole gate low, chase
  // one file, name the seam).
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
  // every argv except the --only flag itself and its value (index math must
  // hold when --only is absent: onlyIdx -1 must not drop positional index 0)
  const positional = argv.filter((_a, i) =>
    !(onlyIdx !== -1 && (i === onlyIdx || i === onlyIdx + 1)),
  );

  const listSuites = () => {
    if (positional.length > 0) return positional;
    return discoverSuites();
  };

  const suites = listSuites().filter((f) => (only ? f.includes(only) : true));
  if (suites.length === 0) {
    console.error(`test-gate: no suites matched${only ? ` --only ${only}` : ""}`);
    process.exit(2);
  }

  // Run one suite with a hard watchdog. The child is its own process-group
  // leader (detached) so the kill takes the whole tree — a suite that wedged
  // by spawning a stuck grandchild dies with its offspring, not alone.
  const runSuite = (rel) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, ["--test", "--test-reporter=tap", rel], {
        cwd: ROOT,
        detached: true,
        env: SUITE_ENV,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, TIMEOUT_S * 1000);

      child.on("exit", (code) => {
        clearTimeout(timer);
        const secs = (Date.now() - started) / 1000;
        resolve({
          rel,
          secs: secs.toFixed(1),
          verdict: timedOut ? "HANG" : code === 0 ? "ok" : "red",
          tail: out.split("\n").filter(Boolean).slice(-15).join("\n"),
        });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ rel, secs: "0.0", verdict: "red", tail: `spawn error: ${err.message}` });
      });
    });

  const results = [];
  for (const rel of suites) {
    const r = await runSuite(rel);
    results.push(r);
    // verdict lines stream as each suite finishes — a long gate must show
    // progress, not go silent for its whole run (the #398 silence class)
    console.log(`test-gate: ${r.verdict.padEnd(4)} ${r.rel} (${r.secs}s)`);
    if (r.verdict === "HANG") {
      console.log(
        `::error::test-gate: ${r.rel} HANG>${TIMEOUT_S}s — killed at the DSH_TEST_GATE_TIMEOUT_S bound with no verdict ` +
        `(issue #398 class: an ambient seam wedged the suite). Pinpoint: ` +
        `DSH_TEST_GATE_TIMEOUT_S=30 node scripts/bounded-gate.mjs --only ${path.basename(r.rel)} — ` +
        `a suite that cannot run hermetically must fail loud naming the seam, never hang the gate.`,
      );
      console.log(`--- ${r.rel} output tail (where it stopped) ---\n${r.tail}\n--- end tail ---`);
    } else if (r.verdict === "red") {
      console.log(`--- ${r.rel} output tail ---\n${r.tail}\n--- end tail ---`);
    }
  }

  // --- verdict report -------------------------------------------------------
  const reds = results.filter((r) => r.verdict !== "ok").length;

  const hung = results.filter((r) => r.verdict === "HANG").map((r) => r.rel);
  console.log(
    `test-gate: ${results.length - reds}/${results.length} suites ok` +
    (hung.length ? ` — HANG: ${hung.join(", ")}` : ""),
  );
  process.exit(reds > 0 ? 1 : 0);
}

// CLI guard: module imports (the contract pins import discoverSuites) must
// not RUN the gate — only a direct `node scripts/bounded-gate.mjs` invocation
// executes the loop.
const invokedAsMain = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsMain) await main();
