// drift-review-skip.test.mjs — an EMPTY release range costs ZERO agent
// passes: the review step must be gated on the scope step's emptiness
// flag, and so must the tag step. Code and workflow cannot drift apart
// here.
//
// Regression anchor: issue #385 (the #231 residual). The #231 incident
// shape: two racing drift-check runs, one adopting the just-pushed
// v1.97.0 tag as its BASE while its checkout HEAD was still that same
// merge — the agent reviewed an EMPTY diff and minted v1.98.0 on a tree
// v1.97.0 already named. The tag-boundary guard (PR #384, pinned by
// tests/drift-empty-range.test.mjs) made the TAG step skip green when
// HEAD peels to the commit BASE already names — but the "Agent reviews
// its own diff (release gate)" step still executed IN FULL on that same
// empty range: a whole agent pass read a zero-file diff, replied TAG,
// and only then did the tag step skip. These tests fail without the
// fix — delete the review step's `if:` (or the scope step's `empty`
// output) and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

const wf = () => read(".github", "workflows", "drift-check.yml");

/** Slice the workflow from a step's `- name:` line to another marker. */
const stepBlock = (text, fromMarker, toMarker) => {
  const from = text.indexOf(fromMarker);
  assert.ok(from >= 0, `step not found: ${fromMarker}`);
  const to = toMarker === undefined ? text.length : text.indexOf(toMarker, from);
  assert.ok(to > from, `block end not found after ${fromMarker}: ${toMarker}`);
  return text.slice(from, to);
};

test("the scope step emits an `empty` output over the watched-path diff (issue #385)", () => {
  const text = wf();
  const scope = stepBlock(text, "- name: What changed since the last tag?", "- name: Agent reviews its own diff");
  // emptiness is `git diff --quiet` over the SAME paths the review reviews
  assert.match(scope, /if git diff --quiet "\$BASE\.\.HEAD" -- scripts '\.github\/workflows\/agent-\*\.yml' config; then/,
    "the scope step must compute emptiness with git diff --quiet over scripts, agent-*.yml and config — the exact diff the agent would review");
  assert.ok(scope.includes('echo "empty=true" >> "$GITHUB_OUTPUT"'),
    "an empty range must publish empty=true to $GITHUB_OUTPUT");
  assert.ok(scope.includes('echo "empty=false" >> "$GITHUB_OUTPUT"'),
    "a non-empty range must publish empty=false — a missing output is an unrun gate");
  // loud: an empty range announces itself in the run log, not silently
  assert.ok(scope.includes("empty range:"),
    "the empty-range skip must carry a loud log line — a silent skip is an unattributable green");
});

test("`git diff --quiet` rides the if — its exit 1 on a real diff must not red the scope step", () => {
  const scope = stepBlock(wf(), "- name: What changed since the last tag?", "- name: Agent reviews its own diff");
  // the quiet probe appears exactly once and only as the if-condition
  const probeLines = scope.split("\n").filter((l) => l.includes("git diff --quiet"));
  assert.equal(probeLines.length, 1, "exactly one emptiness probe — more is drift");
  assert.match(probeLines[0], /^\s*if git diff --quiet/,
    "the probe exits 1 on a NON-empty diff; bare (outside the if) it fails the step under set -euo pipefail and every normal release reds before review");
});

test("the review step is skipped on empty=true — zero agent passes (issue #385)", () => {
  const text = wf();
  const review = stepBlock(text, "- name: Agent reviews its own diff (release gate)", "- name: Tag + release + notify");
  const ifLine = review.indexOf("if: steps.scope.outputs.empty != 'true'");
  assert.ok(ifLine >= 0,
    "the review step must carry `if: steps.scope.outputs.empty != 'true'` — without it an empty range burns a full agent pass to conclude TAG on nothing");
  // the gate sits on the STEP (before the run block), not inside it: a
  // step-level if boots zero agent processes; an in-script early exit
  // still pays the doppler probe + bash boot
  const runBlock = review.indexOf("run: |");
  assert.ok(runBlock > ifLine,
    "the if must gate the step itself, before the run block — the acceptance is ZERO agent passes, not a cheaper pass");
  // and the agent invocation survives for the non-empty case
  assert.ok(review.includes("run-dsh-agent.sh"),
    "the review step must still run the agent when the range is non-empty");
});

test("the tag step is gated on the same empty flag — a skipped review leaves VERDICT unset", () => {
  const text = wf();
  const tag = stepBlock(text, "- name: Tag + release + notify (only on TAG verdicts)");
  assert.ok(tag.includes("if: steps.scope.outputs.empty != 'true'"),
    "the tag step must key off the same empty flag: a skipped review sets no VERDICT, and the case's *) arm would exit 1 — an empty range must skip green, not red");
  // the non-empty path still tags on the verdict
  assert.ok(tag.includes('case "$VERDICT" in'),
    "the verdict gate itself must stay — empty≠true plus TAG-verdict are independent conditions");
});

test("ordering: emptiness is computed in the scope step, before any agent pass", () => {
  const text = wf();
  const scopeId = text.indexOf("id: scope");
  const emptyOut = text.indexOf('echo "empty=true" >> "$GITHUB_OUTPUT"');
  const reviewIf = text.indexOf("if: steps.scope.outputs.empty != 'true'");
  const agent = text.indexOf("run-dsh-agent.sh");
  assert.ok(scopeId >= 0 && emptyOut > scopeId,
    "the empty output must be computed inside the scope step (id: scope)");
  assert.ok(reviewIf > emptyOut && agent > reviewIf,
    "the flag must exist before the review step's gate, and the agent runs only past that gate");
});
