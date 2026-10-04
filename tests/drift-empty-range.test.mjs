// drift-empty-range.test.mjs — the release flow must never mint a tag
// whose commit an existing release tag already names.
//
// Regression anchor: issue #231. v1.97.0 and v1.98.0 both name 47a4f68 —
// drift-check minted the next minor on a tree a release tag already
// named (both release objects carry createdAt 15:03:49Z, one second off
// the #220 merge), leaving the range v1.97.0..v1.98.0 EMPTY while its
// release notes described real content (+31/-2 on scripts/git-scrub-shim,
// +60 on tests/scrub-shims.test.mjs), and consumers pinning v1.97.0 saw
// zero delta to v1.98.0. These tests fail without the guard — delete the
// already_tagged gate in drift-check.yml and this suite goes red.
//
// The law these pins enforce: numbered release tags are immutable. The
// flow refuses to mint vX.Y.0 at a commit any existing release tag
// names (empty range), and only the moving major tag (@v1) is ever
// force-moved — always onto the new release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wf = readFileSync(path.join(ROOT, ".github", "workflows", "drift-check.yml"), "utf8");
const line = (needle) => wf.split("\n").find((l) => l.includes(needle));

test("scope refuses an empty-range mint: a numbered tag already naming HEAD skips the release", () => {
  // the guard itself: ask which tags name the commit about to be tagged
  const guard = line("git tag --points-at HEAD");
  assert.ok(guard, "scope must run 'git tag --points-at HEAD' before minting");
  // the filter keeps only NUMBERED release tags — the moving major also
  // points at HEAD after every release and must never trip the guard
  assert.match(guard, /\^v\[0-9\]\+\\\./,
    "the points-at filter must anchor a numbered vX.Y.Z release shape");
  assert.ok(guard.includes("head -1"),
    "the guard collapses to one tag name for the output + warning");
  // the refusal is LOUD (a run annotation, not a silent green)
  const warn = line("::warning::");
  assert.ok(warn, "the skip must emit a ::warning:: annotation — the #231 class was silence");
  assert.match(warn, /already names|names \$(GH|HEAD)/,
    "the warning must say the existing tag already names this commit");
  assert.match(warn, /refusing to mint \$\{NEXT\}/,
    "the warning must name the empty-range tag it refuses to mint");
});

test("the skip is output-plumbed: downstream steps gate on already_tagged, not on step order", () => {
  assert.ok(line('echo "already_tagged='),
    "scope must emit already_tagged to $GITHUB_OUTPUT");
  const gated = wf.match(/^ +if: steps\.scope\.outputs\.already_tagged == ''$/gm) ?? [];
  assert.equal(gated.length, 2,
    "BOTH the release-gate review and the tag+release+notify steps must skip when HEAD is already tagged (exit-0 alone would run them on)");
});

test("numbered release tags stay immutable: only the moving major tag is ever force-moved", () => {
  assert.ok(wf.includes('git tag -f "$MOVING" "$NEXT"'),
    "the only force-tag anchors the MOVING major at the new release");
  assert.doesNotMatch(wf, /git tag -f "\$NEXT"|git tag -f v[0-9]/,
    "a numbered release tag must never be force-moved — re-pointing v1.97.0 forward is the other half of the #231 receipt");
  assert.doesNotMatch(wf, /push[^\n]*-f[^\n]*"\$NEXT"/,
    "the numbered release tag is pushed once, never force-pushed");
});
