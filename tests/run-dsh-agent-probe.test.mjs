// run-dsh-agent-probe.test.mjs — structural pins for the dsh presence
// probe in tests/run-dsh-agent.test.mjs (issue #601).
//
// The four live-leg `skip:` gates in run-dsh-agent.test.mjs carried four
// inline `spawnSync("dsh", ["--version"])` probes — one per gated test,
// each evaluated at file load, none budgeted: a bare spawnSync waits
// indefinitely, so a wedged dsh install (a broken shell shim, a hung
// first-run path) wedged the FILE at load — no assertion reds, no
// file-level result — until the outer budget killed it unnamed (the #423
// wedge class; the same class #598 fixed in the two mount suites, whose
// tests-lint rule is deliberately scoped to those suites only — PR #602 —
// so this file's pin is free-standing). The pins hold the fix's shape:
//
//   1. exactly ONE `spawnSync("dsh", ["--version"])` in the file — the
//      shared module-top const, budgeted at 30s — so the four per-gate
//      probes cannot come back;
//   2. every `spawnSync("dsh", …)` call in the file carries a `timeout:`
//      (the shared probe and the four live boot legs alike);
//   3. no `skip:` option spawns anything inline — the gates read the
//      shared const, and that const's wedge branch (status null + signal)
//      NAMES the signal in the skip reason: the skip reason is the
//      diagnostic, not a silent absent.
//
// Offline: reads the file's source, spawns nothing. Line-based with a
// balanced-window walk for the multi-line call sites — the same discipline
// scripts/tests-lint.mjs documents (comment lines are dead text).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "tests", "run-dsh-agent.test.mjs");

const isCommentLine = (raw) => /^(\/\/|\*|#)/.test(raw.trimStart());

/** The text from `open` (which sits at `from`) to its matching closer,
 * with quoted strings skipped so string parens never count. */
const balancedFrom = (text, from, open, close) => {
  let depth = 0;
  let q = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === "\\") i++;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
};

const lines = readFileSync(SOURCE, "utf8").split("\n");

test("run-dsh-agent.test.mjs probes dsh presence with exactly ONE shared budgeted const (issue #601)", () => {
  const probeLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    if (/spawnSync\("dsh",\s*\["--version"\]/.test(lines[i])) probeLines.push(i + 1);
  }
  assert.equal(
    probeLines.length,
    1,
    `expected exactly one spawnSync("dsh", ["--version"]) — the shared module-top const — found ${probeLines.length} at lines ${probeLines.join(", ")}; the four inline per-gate probes of issue #601 must not come back`,
  );
  assert.match(
    lines[probeLines[0] - 1],
    /timeout:\s*30_000/,
    "the shared presence probe must carry the 30s budget (a bare spawnSync waits indefinitely — the #423 wedge class)",
  );
});

test("every spawnSync(\"dsh\", …) in run-dsh-agent.test.mjs carries a timeout (issue #601)", () => {
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    const at = lines[i].indexOf('spawnSync("dsh"');
    if (at === -1) continue;
    const window = balancedFrom(lines.slice(i).join("\n"), at + "spawnSync".length, "(", ")");
    assert.ok(window, `line ${i + 1}: unbalanced spawnSync("dsh", …) window — a syntax error the test run owns`);
    assert.match(
      window,
      /\btimeout\s*:/,
      `line ${i + 1}: spawnSync("dsh", …) has no timeout — a wedged dsh install would wedge the file past any outer budget (issue #601, the #423 wedge class)`,
    );
  }
});

test("the live-leg skip gates read the shared const; no skip option spawns inline (issue #601)", () => {
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    if (/\bskip\s*:/.test(lines[i])) {
      assert.doesNotMatch(
        lines[i],
        /spawnSync\(/,
        `line ${i + 1}: a skip option spawns inline — each gated test would evaluate its own probe at file load; the gates must read the shared DSH_SKIP const (issue #601)`,
      );
    }
  }
  const gateCount = lines.filter((l) => !isCommentLine(l) && /\{ skip: DSH_SKIP \}/.test(l)).length;
  assert.ok(
    gateCount >= 4,
    `expected the live-leg gates to read { skip: DSH_SKIP }, found ${gateCount} — the shared-const wiring of issue #601 came apart`,
  );
  const source = lines.join("\n");
  assert.match(
    source,
    /DSH_PROBE\.status === null && DSH_PROBE\.signal/,
    "the shared const must treat a wedged probe (status null + signal) as ABSENT with a NAMED skip reason — the skip reason is the diagnostic (issue #601, the #598 shape)",
  );
});
