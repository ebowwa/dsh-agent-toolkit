// gates-disk-floor-selfheal.test.mjs — pins the disk floor check's
// self-heal-before-red contract (issue #633). The floor check ran BEFORE
// checkout and failed the job the moment the self-hosted cell drifted
// under 2048 MiB — PR #632's only CI run (37915961301) died pre-test on a
// 1551 MiB trough while its diff was green locally, and the same-morning
// precedent (37901471044 red 07:51, green re-run 08:02) proved the trough
// transient. The step now attempts a BOUNDED inline prune first (age-
// expired _diag files + diag-archive dirs only — it cannot call
// scripts/cell-disk-guard.sh, which does not exist until checkout) and
// re-measures; fail-loud stays for a real trough (issue #474's mid-test
// disk-death reason is unchanged). Pins:
//   - the floor default (2048) and the env override survive;
//   - the step carries the self-heal: the notice, the bounded prune
//     (-mtime +14, _diag + diag-archive only), and a RE-MEASURE before
//     any red;
//   - the red is unchanged in shape: ::error with both numbers, exit 1 —
//     this is NOT continue-on-error and must never become one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gates = readFileSync(path.join(ROOT, ".github/workflows/gates.yml"), "utf8");
const step = gates.slice(gates.indexOf("Disk free-space floor check"), gates.indexOf("actions/checkout"));

test("issue #633: the floor default and env override survive the self-heal rewrite", () => {
  assert.match(step, /GATES_DISK_FLOOR_MB: \$\{\{ vars\.GATES_DISK_FLOOR_MB \|\| '2048' \}\}/);
  assert.match(step, /floor_mb="\$\{GATES_DISK_FLOOR_MB:-2048\}"/);
});

test("issue #633: under floor the step self-heals BEFORE any red — prune, then re-measure", () => {
  const heal = step.indexOf("bounded inline self-heal prune");
  const remeasure = step.indexOf("after self-heal prune");
  const red = step.indexOf("::error::");
  assert.ok(heal > -1, "the ::notice self-heal marker must be present");
  assert.ok(remeasure > heal, "the step must re-measure after the prune");
  assert.ok(red > remeasure, "the red must come only after the re-measure");
});

test("issue #633: the inline prune is BOUNDED — age-expired runner-owned entries only", () => {
  // the step runs before checkout, so it cannot call cell-disk-guard.sh;
  // the inline prune must stay inside the runner's own _diag + diag
  // archive and never touch the workspace or live runner bodies.
  assert.match(step, /prune_home="\$\{RUNNER_HOME:-\$HOME\}"/);
  assert.match(step, /find "\$prune_home\/_diag" -type f -mtime \+14 -delete/);
  assert.match(step, /find "\$prune_home\/lane-burst\/_diag-archive" -mindepth 1 -maxdepth 1 -type d -mtime \+14 -exec rm -rf \{\} \+/);
  assert.ok(!/rm -rf(?![ {}])/m.test(step.replace(/-exec rm -rf \{\} \+/g, "")), "no unbounded rm outside the two -exec sites");
});

test("issue #633: fail-loud is unchanged — ::error with both numbers and exit 1", () => {
  assert.match(step, /::error::Runner cell disk under floor — \$\{avail_mb\} MiB free < \$\{floor_mb\} MiB floor/);
  assert.match(step, /exit 1/);
  // the self-heal must never degrade into a waived check (REVIEW.md:
  // fail-closed stays fail-closed)
  assert.ok(!/^\s*continue-on-error:/m.test(step), "the floor check must not become continue-on-error");
});
