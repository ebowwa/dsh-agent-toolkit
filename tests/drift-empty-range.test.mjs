// drift-empty-range.test.mjs — a release tag always names a NEW commit;
// an empty BASE..HEAD range must skip the release green, and a published
// release tag is never re-pointed. Code and docs cannot drift apart here.
//
// Regression anchor: issue #231. v1.97.0 and v1.98.0 both named 47a4f683
// (Merge PR #220) — `git ls-remote` showed both tags on the same commit
// and both GitHub releases were minted the same second. A racing
// drift-check run adopted the just-pushed v1.97.0 as its BASE while its
// checkout HEAD was still that same merge: the agent reviewed an EMPTY
// diff, said TAG, and the tag step minted v1.98.0 on a tree v1.97.0
// already named — per-tag diffs and release notes went unreliable, and
// consumers pinning v1.97.0 saw zero delta to v1.98.0. These tests fail
// without the fix — delete the empty-range guard block and this suite
// goes red.
//
// Extended for issue #385 (the #231 residual): the #384 guard fired only
// AFTER a full agent pass had reviewed the empty diff and replied TAG.
// The scope step now emits an `empty` output and BOTH downstream steps
// gate on it — an empty range costs ZERO agent passes. Delete the
// `empty=` output or drop either downstream `if:` and the #385 tests
// below go red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

// stepBlock(name) — the text of ONE workflow step, from its `- name:`
// line to the next step at the same indent. Pins must scope their
// string matches to the step that OWNS the contract, never the whole
// file: a whole-file includes is satisfied by any step's env (issue
// #393 — the tag-step BASE pin went green on trees where only the
// REVIEW step carried that env line).
const stepBlock = (name) => {
  const lines = read(".github", "workflows", "drift-check.yml").split("\n");
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

test("the tag step takes BASE from the scope step (the guard's input)", () => {
  // SCOPED to the tag step block (issue #393): the whole-file includes
  // this replaces was a false green — main satisfies the bare string
  // through the REVIEW step's env (drift-check.yml:94) while the tag
  // step receives nothing, so it never pinned the tag step at all.
  const tag = stepBlock("Tag + release + notify (only on TAG verdicts)");
  assert.ok(tag.includes("BASE: ${{ steps.scope.outputs.base }}"),
    "the tagging step must receive the scope step's BASE — the commit the previous release tag already names");
});

test("drift-check skips an empty release range green, before tagging (issue #231 revert guard)", () => {
  const wf = read(".github", "workflows", "drift-check.yml");
  // the guard peels both sides to commits — HEAD vs the commit BASE names
  assert.ok(wf.includes('git rev-parse "HEAD^{commit}"'),
    "the guard must resolve HEAD to a commit");
  assert.ok(wf.includes('git rev-parse "${BASE}^{commit}"'),
    "the guard must resolve BASE (the previous release tag) to a commit");
  const guard = wf.indexOf('HEAD_C="$(git rev-parse "HEAD^{commit}")"');
  const equality = wf.indexOf('if [ "$HEAD_C" = "$BASE_C" ]; then');
  const skip = wf.indexOf("empty release range:");
  const exit0 = wf.indexOf("exit 0", equality);
  const tag = wf.indexOf('git tag "$NEXT"');
  assert.ok(guard >= 0 && equality > guard && skip > equality && exit0 > skip,
    "an empty range must announce itself loudly and exit green — a nothing-to-release is not a failure");
  assert.ok(tag > exit0,
    "the empty-range guard must run BEFORE the tag is minted — a guard after the push is a post-mortem");
});

test("published release tags are never re-pointed (only the moving major is forced)", () => {
  const wf = read(".github", "workflows", "drift-check.yml");
  assert.ok(wf.includes('git push origin "$NEXT"'),
    "the release tag push must stay unforced");
  assert.doesNotMatch(wf, /git tag -f "\$NEXT"/,
    "re-pointing a published release tag is the #231 defect class — it must not come back");
  assert.doesNotMatch(wf, /git push\s+(?:-q\s+)?-f origin "\$NEXT"/,
    "force-pushing a published release tag must not come back");
  // the moving major tag is the ONE forced pin — pinned separately by
  // tests/drift-moving-tag.test.mjs (issue #38)
  assert.ok(wf.includes('git tag -f "$MOVING" "$NEXT"'),
    "the moving major tag remains the only tag drift-check ever forces");
});

test("README documents the distinct-commit release rule", () => {
  const readme = read("README.md");
  assert.match(readme, /release\s+tag\s+names\s+a\s+distinct\s+commit/,
    "README's Versioning section must state the distinct-commit rule (issue #231)");
  assert.match(readme, /never re-pointed/,
    "README's Versioning section must state published release tags are never re-pointed");
});

// --- issue #385: an empty range costs ZERO agent passes -------------------
// (the #385 tests below pin through the shared stepBlock helper above)

test("scope emits an empty-range flag over the full propagation surface (issue #385)", () => {
  const block = stepBlock("What changed since the last tag?");
  // the emptiness probe covers the SAME three pathspec families the
  // review propagates — a narrower probe would skip a range the review
  // never got to see (skip surface == review surface)
  assert.ok(
    block.includes(
      `git diff --quiet "$BASE..HEAD" -- scripts '.github/workflows/agent-*.yml' config`,
    ),
    "scope must probe emptiness with git diff --quiet over scripts, agent-*.yml workflows and config",
  );
  // the probe rides an if — under set -e a bare --quiet with changes
  // would kill the scope step (exit 1) instead of setting the flag
  assert.match(block, /if git diff --quiet "\$BASE\.\.HEAD"/,
    "the --quiet probe must sit in an if condition, not run bare under set -e");
  assert.ok(block.includes('echo "empty=true" >> "$GITHUB_OUTPUT"'),
    "scope must emit empty=true on an empty range");
  assert.ok(block.includes('echo "empty=false" >> "$GITHUB_OUTPUT"'),
    "scope must emit empty=false on a real range — never leave the output unset");
  assert.match(block, /EMPTY release range .* skipping agent review and publish/,
    "the empty skip must be loud in the run log, not a silent green");
});

test("the agent review step never runs on an empty range — zero agent passes (issue #385)", () => {
  const block = stepBlock("Agent reviews its own diff (release gate)");
  assert.ok(block.includes(`if: steps.scope.outputs.empty != 'true'`),
    "the review step must be gated on the scope step's empty flag — an empty range burns ZERO agent passes");
  assert.equal((block.match(/if: steps\.scope\.outputs\.empty/g) || []).length, 1,
    "the review gate must be exactly the empty flag — no compound condition that could skip a real review");
});

test("the tag step skips green on empty — a skipped review leaves VERDICT unset (issue #385)", () => {
  const block = stepBlock("Tag + release + notify (only on TAG verdicts)");
  assert.ok(block.includes(`if: steps.scope.outputs.empty != 'true'`),
    "the tag step must be gated on the empty flag — a skipped review leaves VERDICT unset and the verdict case would exit 1 red");
  // the #384 race-day belt stays inside the step: scope-time non-empty
  // can still be tag-time empty (BASE adopted between the two steps)
  assert.ok(block.includes('HEAD_C="$(git rev-parse "HEAD^{commit}")"'),
    "the HEAD==BASE belt (PR #384) must remain in the tag step");
  // and the belt complements, never replaces, the fail-closed verdict
  assert.ok(block.includes("TAG|TAG-WITH-FINDINGS)"),
    "the verdict case must still gate a real range's tag");
  assert.match(block, /verdict '\$\{VERDICT:-none\}' — NOT tagging/,
    "a non-TAG verdict on a real range must still exit red");
});
