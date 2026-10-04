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

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");

test("the tag step takes BASE from the scope step (the guard's input)", () => {
  const wf = read(".github", "workflows", "drift-check.yml");
  assert.ok(wf.includes("BASE: ${{ steps.scope.outputs.base }}"),
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
