// gates-plugin-deps.test.mjs — pins the gates.yml "Install plugin
// smoke-test deps" peer-union reconciliation to CONVERGE, not to a fixed
// round count.
//
// Regression anchor: PR 203 review, receipts 2026-09-28. The loop was
// `for _ in 1 2 3 4 5`; on a clean replicate it hit the cap in a PRUNED
// state (npm's reconcile order churns peers across rounds — the step's
// own comment anticipated oscillation) and the unit-test step went
// flaky-red: 2 of 352 plugin smokes failed ERR_MODULE_NOT_FOUND on
// @deepseek-ai/dsh-timeout. These tests fail without the fix: restore
// the fixed 5-round cap or drop the fail-closed resolvability check and
// this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gates = readFileSync(path.join(ROOT, ".github", "workflows", "gates.yml"), "utf8");

const step = (() => {
  const start = gates.indexOf("Install plugin smoke-test deps");
  assert.ok(start > 0, "gates.yml carries the plugin smoke-test deps step");
  const next = gates.indexOf("- name:", start + 1);
  return gates.slice(start, next > 0 ? next : gates.length);
})();

test("the peer-union loop is convergence-driven, not a fixed round count", () => {
  assert.ok(!/for _ in \d/.test(step), "fixed iteration cap removed — it settles pruned");
  assert.match(step, /while :;/, "loop runs until the peer set is satisfied");
  assert.match(step, /\[ -n "\$extra" \] \|\| break/, "loop exits only when no peer is missing");
});

test("a non-converging loop fails the step loudly, never silently pruned", () => {
  assert.match(step, /-gt \d+/, "a round cap still guards against an infinite loop");
  assert.match(step, /did not converge/, "cap hit reports the missing set");
  assert.match(step, /exit 1/, "cap hit fails the step (set -e alone does not fire here)");
});

test("the step ends fail-closed: every peer of every installed package resolves", () => {
  // The final assertion is a standalone node block AFTER the loop and the
  // @local re-link, scanning peerDependencies against node_modules and
  // exiting 1 on any gap.
  const relink = step.lastIndexOf("re-link");
  assert.ok(relink > 0, "the @local re-link block is present");
  const after = step.slice(relink);
  assert.match(after, /peerDependencies/, "final check reads peerDependencies");
  assert.match(after, /unresolved peers after install/, "it names the gap");
  assert.match(after, /process\.exit\(1\)/, "it is fail-closed, not advisory");
});
