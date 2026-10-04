// drift-empty-range.test.mjs — drift-check must never cut a release whose
// range is empty, and must never move or re-cut an already-published tag.
//
// Regression anchor: issue #231. v1.97.0 and v1.98.0 both pointed at
// 47a4f683 (the consumer's tagsync job re-pointed v1.97.0 forward onto
// v1.98.0's commit when the v1.97.0 bump PR merged AFTER v1.98.0 was cut).
// A drift run computing LATEST=v1.97.0 then sees an EMPTY scoped range and
// would tag v1.98.0 on the same commit — a release whose notes describe a
// range that does not exist. These tests fail without the guard: delete the
// empty-range gate from the scope step, un-gate the review/tag steps, or
// drop the tag-collision fence, and this suite goes red.
//
// Redo note: this regenerates PR #234 (closed stale after its review) at
// current main. The review's one blocking finding — the skip-step name
// `Empty release range - no tag (issue #231 guard)` tripped the gates'
// colon-space/inline-comment plain-scalar sub-check on CI (run 36454589455)
// — is fixed here: the step name carries no `#` or `: `; the anchor lives
// inside the run block where it is literal text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wf = readFileSync(path.join(ROOT, ".github", "workflows", "drift-check.yml"), "utf8");

const runBlock = (name) => {
  const start = wf.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `workflow must contain the "${name}" step`);
  const next = wf.indexOf("- name:", start + 1);
  return wf.slice(start, next === -1 ? wf.length : next);
};

test("scope step detects an empty scoped diff and emits the empty flag (issue #231)", () => {
  const scope = runBlock("What changed since the last tag?");
  assert.ok(
    scope.includes('git diff --quiet "$BASE..HEAD" -- scripts'),
    "scope must gate on a quiet scoped diff (the empty-range condition)",
  );
  assert.ok(scope.includes('echo "empty=true"'), "scope must emit empty=true on an empty range");
  assert.ok(scope.includes("empty=false"), "scope must emit empty=false otherwise");
  assert.ok(scope.includes("issue #231"), "the guard must cite its regression anchor");
});

test("the review and tag steps are both gated off on an empty range", () => {
  const review = runBlock("Agent reviews its own diff (release gate)");
  const tag = runBlock("Tag + release + notify (only on TAG verdicts)");
  assert.ok(
    review.includes("if: steps.scope.outputs.empty != 'true'"),
    "the review step must not run on an empty range",
  );
  assert.ok(
    tag.includes("if: steps.scope.outputs.empty != 'true'"),
    "the tag step must not run on an empty range",
  );
});

test("the loud empty-range skip step exists and fires only when empty", () => {
  const skip = runBlock("Empty release range");
  assert.ok(
    skip.includes("if: steps.scope.outputs.empty == 'true'"),
    "the skip step must fire only on an empty range",
  );
});

test("the tag step refuses to move or re-cut an already-published tag (issue #231)", () => {
  const tag = runBlock("Tag + release + notify (only on TAG verdicts)");
  assert.ok(
    tag.includes('git rev-parse -q --verify "refs/tags/$NEXT"'),
    "tag step must verify $NEXT does not already exist",
  );
  assert.ok(
    tag.includes("refusing to move or re-cut a published tag"),
    "the collision must fail loudly with the reason",
  );
});

test("README documents the tag re-pointing convention", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /### Tag re-pointing/, "README must document the re-point convention");
  assert.match(readme, /drift-empty-range\.test\.mjs/, "the doc must point at this pin suite");
});

test("no step name trips the gates' plain-scalar sub-checks (the PR 234 review finding)", () => {
  // The review on PR #234 blocked on exactly this: a step NAME containing
  // ` #` (inline-comment marker) or `: ` (colon-space) trips the workflow
  // YAML-parse gate's plain-scalar check on CI while passing a local tab
  // check. Mirror the gate's own pattern (`/:[ \t]| #[^\n]*$/` on the
  // name value) across EVERY step name in this workflow, so the class
  // cannot ride in again through any step — not just the new skip step.
  const names = [...wf.matchAll(/^      - name: (.+)$/gm)].map((m) => m[1]);
  assert.ok(names.length > 0, "the workflow must have steps to pin");
  for (const name of names) {
    assert.ok(
      !/:[ \t]| #[^\n]*$/.test(name),
      `step name must carry no colon-space or inline-comment marker (got: "${name}")`,
    );
  }
});
