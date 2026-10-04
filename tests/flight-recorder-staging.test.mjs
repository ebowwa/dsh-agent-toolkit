// flight-recorder-staging.test.mjs — per-skill pin for the fixed-/tmp
// staging defect in the flight-recorder-audit recipe (issues #364/#356,
// the #346 clobber class found in this skill's corpus scan).
//
// Contract under test: the flight-recorder decode fence never stages
// through a FIXED /tmp name. /tmp is host-global across every agent on a
// lane box, and the recipe's whole point is re-decoding tower flight
// state — two same-box siblings auditing different sessions share the
// fixed pair (/tmp/s.zst, /tmp/s.jsonl), and the second sibling's
// `git show > /tmp/s.zst` swaps the archive under the first's `zstd -dc`
// mid-flight: the decode either fails or, worse, silently produces the
// WRONG session's events as evidence. Silent wrong-evidence, the #346
// class; same-box collision family as #333 (workdir hygiene, pinned in
// tests/workdir-hygiene-contract.test.mjs).
//
// Receipts (issue #364, pristine main 2026-10-04, this claim's worktree):
//   .agents/skills/flight-recorder-audit/SKILL.md:16 —
//     `git show "origin/tower-state:$F" > /tmp/s.zst`
//   .agents/skills/flight-recorder-audit/SKILL.md:17 —
//     `zstd -dc /tmp/s.zst > /tmp/s.jsonl`
//
// Fix shape (the #346/#363 recipe): per-run staging —
//   `stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flight-recorder-audit-XXXXXX")"`
// with both artifacts riding "$stage/..." and cleanup of only the minted
// path (`rm -rf "$stage"`). The "${TMPDIR:-/tmp}" mktemp default never
// trips the negative shapes: its /tmp sits inside the parameter
// expansion, not behind a staging operator.
//
// Per-skill pin by design (mirrors tests/tmp-staging-hygiene.test.mjs,
// PR #363, for the other three skills): the corpus-wide scan is
// deliberately left to the widening step #364's acceptance reserves for
// after #353/#355's surfaces land — a corpus scan today would go red on
// gates-step-verbatim-repro (/tmp/step.sh) by design.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = ".agents/skills/flight-recorder-audit/SKILL.md";
const skill = () => readFileSync(path.join(ROOT, SKILL), "utf8");

// The observed defect shapes — a fixed /tmp name used as the decode
// fence's write target or read source. Line-based by design (the house
// lint doctrine: catch the observed defect class, not the universe).
// Each alternative is the EXACT shape from an issue-#364 receipt, so a
// revert of either fence line goes red on the matching arm.
const FIXED_TMP_STAGING_SHAPES = [
  /> \/tmp\//, // git show ... > /tmp/s.zst   (write side)
  /zstd -dc \/tmp\//, // zstd -dc /tmp/s.zst (read side — the swap victim)
];

/** All fixed-/tmp staging violations in the skill's text, with line numbers. */
function violations(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const shape of FIXED_TMP_STAGING_SHAPES) {
      if (shape.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

// --- negative pin: the decode fence teaches no fixed /tmp scratch name --

test("issue #364: flight-recorder-audit teaches no fixed /tmp staging path", () => {
  const hits = violations(skill());
  assert.deepEqual(hits, [], `fixed /tmp staging shapes remain:\n${hits.join("\n")}`);
});

// --- positive pins: the fence is per-run and cleans up after itself ---

test("issue #364: the decode fence stages through a per-run mktemp dir", () => {
  assert.match(
    skill(),
    /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-flight-recorder-audit-/,
    "the fence must mint a per-run staging dir (mktemp -d .../dsh-flight-recorder-audit-XXXXXX)",
  );
});

test("issue #364: the decode artifacts ride the minted stage, and cleanup reaps only it", () => {
  const text = skill();
  assert.match(text, /git show [^\n]*> "\$stage\/s\.zst"/, 'archive lands on "$stage/s.zst"');
  assert.match(text, /zstd -dc "\$stage\/s\.zst" > "\$stage\/s\.jsonl"/, 'decode reads and writes the minted pair');
  assert.match(text, /rm -rf "\$stage"/, 'cleanup reaps only the minted path');
});
