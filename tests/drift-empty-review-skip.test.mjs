// drift-empty-review-skip.test.mjs — an empty diff range costs drift-check
// ZERO agent passes.
//
// Regression anchor: issues #231/#385. In the #231 racing shape (two
// drift runs overlap; one adopts the just-pushed tag as BASE), the scoped
// diff BASE..HEAD is EMPTY, yet the "Agent reviews its own diff (release
// gate)" step still executed IN FULL: a whole agent pass reviewed a
// zero-file diff, replied TAG, and only then did the tag step decide.
// One agent pass per racing merge, spent concluding "safe" about nothing.
// Sibling of the #231 tag-guard pin (PR #384 ships tests/drift-empty-range
// .test.mjs for the tag-side property; this file pins the review-side
// zero-pass property) — issue #385 allows a sibling precisely so the two
// pins stay independent.
// These tests fail without the fix — delete the `empty` output from the
// scope step, or drop either `if: steps.scope.outputs.empty != 'true'`
// guard, and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const wf = read(".github", "workflows", "drift-check.yml");

/** The full YAML block of a workflow step, found by its `name:`. */
const stepBlock = (name) => {
  const lines = wf.split("\n");
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(i, -1, `step "${name}" must exist in drift-check.yml`);
  const indent = lines[i].match(/^(\s*)-/)[1].length;
  const out = [];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === "") { out.push(l); continue; }
    const m = l.match(/^(\s*)-/);
    if (m && m[1].length <= indent) break; // next step / dedent out of steps:
    out.push(l);
  }
  return out.join("\n");
};

const REVIEW_STEP = "Agent reviews its own diff (release gate)";
const TAG_STEP = "Tag + release + notify (only on TAG verdicts)";
const EMPTY_GUARD = /if:\s*steps\.scope\.outputs\.empty\s*!=\s*['"]true['"]/;

test("the scope step emits an `empty` output probed with git diff --quiet", () => {
  const scope = stepBlock("What changed since the last tag?");
  assert.ok(scope.includes("git diff --quiet"),
    "scope must probe emptiness with `git diff --quiet` (exit 0 ⇔ empty)");
  assert.ok(scope.includes('echo "empty=true"'),
    "scope must emit empty=true on an empty range");
  assert.ok(scope.includes('echo "empty=false"'),
    "scope must emit empty=false on a non-empty range (explicit beats missing)");
});

test("the empty probe covers exactly the surfaces the review propagates (pathspec parity)", () => {
  const scope = stepBlock("What changed since the last tag?");
  const probe = scope.match(/git diff --quiet [^\n]+/)?.[0] ?? "";
  const stat = scope.match(/git diff --stat [^\n]+/)?.[0] ?? "";
  for (const surface of ["scripts", "'.github/workflows/agent-*.yml'", "config"]) {
    assert.ok(probe.includes(surface),
      `the empty probe must cover ${surface} — a surface only the stat line sees drifts unreviewed`);
    assert.ok(stat.includes(surface),
      `the stat line must keep covering ${surface} (the human-visible scope)`);
  }
});

test("the agent review step is skipped on an empty range (zero agent passes — issue #385)", () => {
  const review = stepBlock(REVIEW_STEP);
  assert.match(review, EMPTY_GUARD,
    "the review step must key off steps.scope.outputs.empty — an empty diff burns no agent pass");
  assert.ok(review.includes("run-dsh-agent.sh"),
    "sanity: the review step is still the one that boots the agent");
});

test("the tag step is skipped on an empty range too (skipped review ⇒ unset VERDICT)", () => {
  const tag = stepBlock(TAG_STEP);
  assert.match(tag, EMPTY_GUARD,
    "the tag step must key off steps.scope.outputs.empty — the review it depends on never ran, VERDICT is unset, and the verdict case would red the run instead of skipping green");
});

test("the guard survives an absent output: missing `empty` runs the review (fail toward review, not silence)", () => {
  // `!= 'true'` treats an unset output as non-empty: a hand-edited scope
  // step that loses the probe fails OPEN toward the (cheap, safe) review
  // path, never toward silent no-op releases.
  assert.ok(EMPTY_GUARD.test("if: steps.scope.outputs.empty != 'true'"));
  assert.ok(!EMPTY_GUARD.test("if: steps.scope.outputs.empty == 'false'"),
    "an == 'false' form would silent-skip whenever the output goes missing");
});
