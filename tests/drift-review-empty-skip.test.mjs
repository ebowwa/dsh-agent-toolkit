// drift-review-empty-skip.test.mjs — an empty gated range must cost ZERO
// agent passes: the release review and the tag step both skip at the scope
// fence. Code and docs cannot drift apart here.
//
// Regression anchor: issue #385 (residual of the #231 racing shape). Two
// racing drift-check runs: run A tags v1.97.0, run B — whose checkout HEAD
// is still that same merge — adopts the just-pushed tag as its BASE, so its
// gated diff is EMPTY. The #231 fix (tag-step guard) stops the empty
// RELEASE, but the agent review step still ran IN FULL on the empty range:
// a whole API-powered agent pass reviewed a zero-file diff, replied TAG,
// and only then did the guard skip. Issue #385's acceptance: the scope
// step emits an `empty` output, the review step is skipped on it (zero
// agent passes), and a pin fails if the review step runs on an empty range
// again. These tests fail without the fix — delete the `if:` on the review
// step (the exact #385 gap), drop the `empty=` output, point the quiet
// diff at a narrower pathspec than the surface the workflow fires for, or
// remove the tag step's `if:` (which turns the skip into a red run: no
// review → no VERDICT → the verdict case fails closed) and this suite
// goes red.

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

/** The run-block of a workflow step, found by its `name:`, dedented. */
const stepRun = (name) => {
  const lines = stepBlock(name).split("\n");
  let j = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
  assert.ok(j !== -1, `step "${name}" must have a literal run block`);
  let contentIndent = null;
  const body = [];
  for (let k = j + 1; k < lines.length; k++) {
    if (lines[k].trim() === "") { body.push(""); continue; }
    const m = lines[k].match(/^(\s+)\S/);
    if (!m) break;
    if (contentIndent === null) contentIndent = m[1].length;
    if (m[1].length < contentIndent) break;
    body.push(lines[k].slice(contentIndent));
  }
  const script = body.join("\n");
  assert.ok(script.trim().length > 0, `step "${name}" run block must not be empty`);
  return script;
};

const SCOPE_STEP = "What changed since the last tag?";
const AGENT_STEP = "Agent reviews its own diff (release gate)";
const TAG_STEP = "Tag + release + notify (only on TAG verdicts)";

/** Pathspec tokens of the scope step's `git diff --stat` line. */
const statPathspec = () => {
  const m = stepRun(SCOPE_STEP).match(/git diff --stat[^\n|]*?--[ \t]+([^\n|]+)/);
  assert.ok(m, "the scope step must scope its --stat diff with an explicit pathspec");
  return m[1].trim().split(/\s+/).map((t) => t.replace(/^'|'$/g, ""));
};

/** Pathspec tokens of the scope step's `git diff --quiet` line (the fence). */
const quietPathspec = () => {
  const m = stepRun(SCOPE_STEP).match(/git diff --quiet[^\n;]*?--[ \t]+([^\n;]+)/);
  assert.ok(m, "the scope step must fence emptiness with a `git diff --quiet` on an explicit pathspec");
  return m[1].trim().split(/\s+/).map((t) => t.replace(/^'|'$/g, ""));
};

test("the scope step stamps an `empty` output computed from the gated diff", () => {
  const scope = stepRun(SCOPE_STEP);
  // the fence exists and covers EXACTLY the surface the --stat line reviews
  // — a quiet diff narrower than the review surface would stamp empty on a
  // range the review would have found non-empty (and vice versa)
  assert.deepEqual(
    quietPathspec(),
    statPathspec(),
    "the empty-range fence must diff the same pathspec the scope step reviews — anything else skips reviews of ranges that are not empty",
  );
  // quiet is a condition, not a bare line: under `set -e` a bare
  // `git diff --quiet` returning 1 (non-empty range) would kill the step
  assert.match(
    scope,
    /if git diff --quiet "\$BASE\.\.HEAD"/,
    "the quiet diff must ride an `if` — a non-empty range makes it exit 1 and errexit would fail the scope step",
  );
  // the output is emitted through $GITHUB_OUTPUT, from a computed EMPTY
  assert.match(
    scope,
    /echo "empty=\$\{?EMPTY\}?"\s*>>\s*"\$GITHUB_OUTPUT"/,
    "the scope step must emit `empty=` through $GITHUB_OUTPUT for later steps to skip on",
  );
  // a loud line says what happened — a silent skip reads as a glitch
  assert.match(
    scope,
    /zero agent passes/,
    "the empty branch must say loudly that it spent zero agent passes (a silent skip is indistinguishable from a dead gate)",
  );
});

test("the agent review step is skipped on an empty gated range — zero agent passes (issue #385)", () => {
  const agent = stepBlock(AGENT_STEP);
  // exact fail-open shape: `!= 'true'` runs the review when the output is
  // missing (a scope regression costs one agent pass, never a silently
  // skipped release); `== 'false'` would silently stop releasing
  const m = agent.match(/^\s*if:\s*(.+)$/m);
  assert.ok(m, "the review step must carry an `if:` — unconditioned, it burns a full agent pass on an empty range (the exact #385 gap)");
  assert.equal(
    m[1].trim(),
    "steps.scope.outputs.empty != 'true'",
    "the review step must skip only on a stamped empty=true, fail-open otherwise",
  );
});

test("the tag step skips on the same fence — a skipped review leaves no VERDICT to gate on", () => {
  const tag = stepBlock(TAG_STEP);
  const m = tag.match(/^\s*if:\s*(.+)$/m);
  assert.ok(
    m,
    "the tag step must carry the same empty-skip `if:` — with the review skipped there is no VERDICT, and the verdict case's fail-closed exit 1 would turn the empty-range skip into a red run",
  );
  assert.equal(
    m[1].trim(),
    "steps.scope.outputs.empty != 'true'",
    "the tag step must skip on the same stamped empty fence as the review step",
  );
});
