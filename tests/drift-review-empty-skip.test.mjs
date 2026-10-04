// drift-review-empty-skip.test.mjs — an empty gated range must cost ZERO
// agent passes, and the fence that guarantees it must keep its exact shape:
// the quiet diff must cover the SAME surface the scope step reviews, it
// must ride an `if` (errexit), and both the review and tag steps must skip
// only on a stamped empty=true. Code and docs cannot drift apart here.
//
// Regression anchor: issue #385 (residual of the #231 racing shape). Two
// racing drift-check runs: run A tags vX.Y.0, run B — whose checkout HEAD
// is still that same merge — adopts the just-pushed tag as BASE, so its
// gated diff is EMPTY. The #231 guard (PR #344, now on main) stamps
// `empty=` in the scope step and gates the review and tag steps off it, so
// the empty range costs zero agent passes and no release is cut. What was
// NOT pinned is the fence's SHAPE (the redo PR #399 died to a main-move
// conflict; this regenerates its pin at current main, issue #440):
//   - drift-empty-range.test.mjs greps substrings only — narrow the quiet
//     diff's pathspec below the surface the `--stat` line reviews and it
//     stays green while the fence stamps empty=true on ranges the review
//     would have found non-empty: reviews silently skipped forever;
//   - drop the `if` around the quiet diff and under `set -e` a non-empty
//     range (quiet exits 1) kills the scope step on every real run;
//   - swap a fence to `== 'false'` and a scope regression silently stops
//     all releases (fail-closed by accident, releases never cut);
//   - drop the TAG step's fence and the skip becomes a red run: review
//     skipped => no VERDICT => the verdict case's fail-closed `exit 1`.
// Mutate drift-check.yml in any of those ways and this suite goes red.

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
  const j = lines.findIndex((l) => /^\s+run:\s*\|\s*$/.test(l));
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

/** The one step-level `if:` of a step block, exactly. */
const stepIf = (name) => {
  const block = stepBlock(name);
  const hits = [...block.matchAll(/^\s*if:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.equal(hits.length, 1, `step "${name}" must carry exactly one step-level if: (got ${hits.length})`);
  return hits[0];
};

test("the scope step stamps `empty` from a quiet diff over the SAME surface it reviews", () => {
  const scope = stepRun(SCOPE_STEP);
  // Surface agreement (the #399 pin): the fence must diff EXACTLY the
  // pathspec the --stat line reviews — a quiet diff narrower than the
  // review surface stamps empty on ranges the review would have found
  // non-empty, and reviews are silently skipped from then on.
  assert.deepEqual(
    quietPathspec(),
    statPathspec(),
    "the empty-range fence must diff the same pathspec the scope step reviews — anything narrower silently skips reviews of non-empty ranges",
  );
  // The fence reads the same range the stat line prints.
  assert.match(
    scope,
    /git diff --quiet "\$BASE\.\.HEAD" --/,
    "the fence must measure the same $BASE..HEAD range the scope step prints",
  );
  // quiet rides an `if`: as a bare line under `set -e` a NON-empty range
  // (quiet exits 1) would kill the scope step on every real run.
  assert.match(
    scope,
    /if git diff --quiet "\$BASE\.\.HEAD"/,
    "the quiet diff must ride an `if` — a non-empty range makes it exit 1 and errexit would fail the scope step",
  );
  // Both branches emit through $GITHUB_OUTPUT so later steps can skip on
  // the stamped value, never on a re-derived one.
  assert.match(
    scope,
    /echo "empty=true" >> "\$GITHUB_OUTPUT"/,
    "the empty branch must stamp empty=true through $GITHUB_OUTPUT",
  );
  assert.match(
    scope,
    /echo "empty=false" >> "\$GITHUB_OUTPUT"/,
    "the non-empty branch must stamp empty=false through $GITHUB_OUTPUT",
  );
});

test("the empty branch is loud — a silent skip reads as a dead gate", () => {
  const scope = stepRun(SCOPE_STEP);
  // The guard fires a workflow annotation warning that says the range is
  // EMPTY and no release will be cut (the #231 wording on main).
  assert.match(
    scope,
    /::warning::.*EMPTY/i,
    "the empty branch must raise a ::warning:: annotation saying the range is EMPTY",
  );
  assert.match(
    scope,
    /::warning::.*no release will be cut/i,
    "the warning must say no release will be cut",
  );
});

test("the agent review step skips only on a stamped empty=true — zero agent passes (issue #385)", () => {
  // Exact fail-open shape: `!= 'true'` still runs the review when the
  // output is missing (a scope regression costs one agent pass, never a
  // silently skipped release); `== 'false'` would stop all releases.
  assert.equal(
    stepIf(AGENT_STEP),
    "steps.scope.outputs.empty != 'true'",
    "the review step must skip only on a stamped empty=true, fail-open otherwise",
  );
});

test("the tag step skips on the same fence — a skipped review leaves no VERDICT to gate on", () => {
  // With the review skipped there is no VERDICT, and running anyway would
  // hit the verdict case's fail-closed `exit 1` — the empty-range skip
  // would turn into a red run.
  assert.equal(
    stepIf(TAG_STEP),
    "steps.scope.outputs.empty != 'true'",
    "the tag step must carry the exact same empty-skip fence as the review step",
  );
});
