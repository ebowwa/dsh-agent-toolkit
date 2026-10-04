// gauge-release-staging.test.mjs — pin for the gauge-plugin-release
// install recipe's staging discipline (issue #351).
//
// Regression anchor: #351, discovered during the #333 workdir-hygiene
// claim (2026-10-04). The recipe staged downloaded artifacts at FIXED
// shared paths (/tmp/app.zip → /tmp/app, /tmp/plug.zip → /tmp/plug) with
// no session identity: two same-box agents running the recipe
// concurrently overwrite each other's staging trees mid-install — agent
// A's `cp -R /tmp/app/...` copies whatever half-written or wrong-version
// bundle agent B's `unzip -oq ... -d /tmp/app` left behind, then xattr
// and launch proceed on it. Same silent-loss class as #333 (fixed
// predictable path, destructive overlap), different surface: install
// staging, not a clone worktree.
//
// These tests fail without the fix: revert the recipe to any fixed
// /tmp/<name> staging destination and the no-fixed-staging leg reds;
// drop the mktemp mint or the trailing cleanup and their legs red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(
  path.join(ROOT, ".agents", "skills", "gauge-plugin-release", "SKILL.md"), "utf8");

// The install block only — the skill may legitimately MENTION /tmp in
// prose (e.g. the TMPDIR default inside the mktemp template itself).
const block = (() => {
  const start = SKILL.indexOf("Install BOTH every time:");
  assert.ok(start !== -1, "the install block must exist in the skill");
  const fence = SKILL.indexOf("```bash", start);
  assert.ok(fence !== -1, "the install block must be a fenced bash block");
  const end = SKILL.indexOf("```", fence + "```bash".length);
  assert.ok(end !== -1, "the install block's fence must close");
  return SKILL.slice(start, end);
})();

test("the install block stages through a per-run mktemp dir (no fixed /tmp staging)", () => {
  assert.match(block, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/gauge-install-XXXXXX"/,
    "the recipe must mint its staging dir per run — a fixed dir is shared with every same-box sibling");
  assert.doesNotMatch(block, /(?:-o|-d|--output|--dir)\s+"?\/tmp\//,
    "a fixed /tmp/<name> staging destination remains — two concurrent installs on one box can read each other's half-written bundles (#351)");
  assert.doesNotMatch(block, /cp -R \/tmp\//,
    "the install copies still read from a fixed /tmp staging tree");
});

test("the staged dir is this run's alone and is cleaned up", () => {
  // Every CODE line reaching /tmp must ride the mktemp template — a bare
  // /tmp/... path would be a second, un-minted staging surface. (Comment
  // lines may mention /tmp in prose; the mktemp template itself is the
  // one sanctioned literal, as TMPDIR's fallback.)
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!/\/tmp\//.test(trimmed) || trimmed.startsWith("#")) continue;
    assert.match(line, /\$\{TMPDIR:-\/tmp\}/,
      `line reaches /tmp outside the mktemp template (no session identity): ${trimmed}`);
  }
  assert.match(block, /rm -rf "\$stage"/,
    "staging is throwaway — the recipe must remove the dir it minted");
});
