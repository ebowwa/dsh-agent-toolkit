#!/usr/bin/env node
// test-gate.mjs — the bounded per-file local test gate (issue #398).
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
//   1. a hard per-file watchdog — DSH_TEST_GATE_TIMEOUT_S (default 120s)
//      kills the suite's WHOLE process group and reports HANG, so the gate
//      always degrades loud: every file gets a verdict line (ok / red /
//      HANG) and the loop finishes;
//   2. a typed diagnostic on HANG naming the file, the bound, and the
//      pinpoint recipe (re-run that one file at a tighter bound to catch
//      the wedging seam red-handed);
//   3. the tail of a red/hung suite's TAP output — where it stopped.
//
// Usage:
//   node scripts/test-gate.mjs                  # the CI-graded set:
//                                               #   tests/*.test.mjs
//                                               #   + plugins/*/test/smoke.mjs
//                                               #     (when present — the
//                                               #     parity form, issue #301)
//   node scripts/test-gate.mjs tests/foo.test.mjs [more.files...]  # explicit
//   node scripts/test-gate.mjs --only run-dsh-agent                # substring pinpoint
//
// Env:
//   DSH_TEST_GATE_TIMEOUT_S  per-suite kill bound (default 120; unset or
//                            blank falls to the default — a non-numeric or
//                            sub-1 value is a typed bad-knob error, exit 2,
//                            before any suite runs — issue #538)

import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TIMEOUT_S = (() => {
  const raw = process.env.DSH_TEST_GATE_TIMEOUT_S;
  if (raw === undefined || raw.trim() === "") return 120;
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
      `insta-kills). Unset it for the 120s default, or set a bound >= 1.`,
    );
    process.exit(2);
  }
  return n;
})();

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
  const suites = readdirSync(path.join(ROOT, "tests"), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".test.mjs"))
    .map((d) => path.join("tests", d.name));
  const pluginsDir = path.join(ROOT, "plugins");
  if (existsSync(pluginsDir)) {
    for (const d of readdirSync(pluginsDir, { withFileTypes: true })) {
      const smoke = path.join("plugins", d.name, "test", "smoke.mjs");
      if (d.isDirectory() && existsSync(path.join(ROOT, smoke))) suites.push(smoke);
    }
  }
  return suites.sort();
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
      `DSH_TEST_GATE_TIMEOUT_S=30 node scripts/test-gate.mjs --only ${path.basename(r.rel)} — ` +
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
