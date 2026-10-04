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

// --- Zero-agent-pass hardening (issue #385, regenerating PR #396) ---
//
// The pins above prove the gates EXIST. The pins below prove they sit in
// the shape that makes an empty range cost ZERO agent passes — the three
// regression modes the existence pins do not catch:
//   a. the emptiness probe moved out of its `if` — `git diff --quiet`
//      exits 1 on a NON-empty diff, so a bare probe fails the scope step
//      under `set -euo pipefail` and every NORMAL release reds before
//      review;
//   b. the review gate demoted from a step-level `if:` to an in-script
//      early exit — the step boots (doppler probe, bash, the agent
//      invocation itself) before discovering the range is empty: a
//      cheaper pass, not zero passes;
//   c. the loud line dropped — a silent green skip is unattributable.

test("the emptiness probe rides the if — bare, its exit 1 reds every normal release", () => {
  const scope = runBlock("What changed since the last tag?");
  const probeLines = scope.split("\n").filter((l) => l.includes("git diff --quiet"));
  assert.equal(probeLines.length, 1,
    "exactly one emptiness probe — more is drift between the flag and the diff it describes");
  assert.match(
    probeLines[0],
    /^\s*if git diff --quiet/,
    "the probe must be the if-condition: `git diff --quiet` exits 1 on a NON-empty diff, so a bare probe fails the scope step under set -euo pipefail and every normal release reds before review",
  );
});

test("the empty-range skip is loud — a ::warning:: annotation, not a silent green", () => {
  const scope = runBlock("What changed since the last tag?");
  const afterMark = scope.split("::warning::")[1] ?? "";
  assert.ok(
    scope.includes("::warning::") && /[Ee]mpty/.test(afterMark),
    "the empty-range skip must announce itself as a ::warning:: annotation naming the emptiness — a silent skip is an unattributable green",
  );
});

test("the review gate is a step-level if: — an empty range costs ZERO agent passes (issue #385)", () => {
  const review = runBlock("Agent reviews its own diff (release gate)");
  const ifPos = review.indexOf("if: steps.scope.outputs.empty != 'true'");
  assert.ok(ifPos >= 0, "the review step must carry the empty-range gate");
  const runPos = review.indexOf("run: |");
  assert.ok(runPos > ifPos,
    "the if must gate the STEP (before the run block): an in-script early exit still boots the step — doppler probe, bash, and the agent invocation — and pays for a pass the range never needed; the acceptance is ZERO agent passes, not a cheaper pass");
  assert.ok(review.includes("run-dsh-agent.sh"),
    "the agent invocation must survive for the non-empty case — the gate skips, it does not remove");
});

test("ordering: the flag exists before the review gate, and the agent runs only past it", () => {
  const scopeId = wf.indexOf("id: scope");
  const emptyOut = wf.indexOf('echo "empty=true" >> "$GITHUB_OUTPUT"');
  const reviewIf = wf.indexOf("if: steps.scope.outputs.empty != 'true'");
  const agent = wf.indexOf("run-dsh-agent.sh");
  assert.ok(scopeId >= 0 && emptyOut > scopeId,
    "the empty flag must be computed inside the scope step (id: scope) — before any agent pass");
  assert.ok(reviewIf > emptyOut && agent > reviewIf,
    "the gate must reference a flag that already exists, and the agent must boot only past that gate");
});

test("the tag step keys off the same flag, and the verdict gate itself survives (issue #385)", () => {
  const tag = runBlock("Tag + release + notify (only on TAG verdicts)");
  assert.ok(tag.includes('case "$VERDICT" in'),
    "the verdict case gate must stay: empty!=true and an approved verdict are independent conditions — dropping the case would tag on a BLOCK or on a skipped review");
});
