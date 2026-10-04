// flight-recorder-audit-staging.test.mjs — per-skill pin for the
// fixed-/tmp staging defect class in the flight-recorder-audit recipe
// (issues #364 / #356; the #346 class, flight-recorder flavor).
//
// Contract under test: a taught recipe never stages through a FIXED
// /tmp path. /tmp is host-global across every agent on a lane box, and
// a fixed name carries no session/claim identity — two same-box agents
// auditing flight logs concurrently (this recipe's whole purpose) share
// the scratch pair: the second sibling's `git show > /tmp/s.zst`
// replaces the first's archive mid-flight, and the first's `zstd -dc`
// then either fails or decodes the WRONG session's bytes. Silent
// wrong-evidence, the #346 clobber class.
//
// Receipts (issue #364, pristine main @ 3da299e, 2026-10-04):
//   .agents/skills/flight-recorder-audit/SKILL.md:16 —
//     `git show "origin/tower-state:$F" > /tmp/s.zst`
//   .agents/skills/flight-recorder-audit/SKILL.md:17 —
//     `zstd -dc /tmp/s.zst > /tmp/s.jsonl`
//   (#356 filed the same two lines independently 18 min earlier —
//   duplicate tickets, one defect, one pin.)
//
// Fix shape (mirrors the #346 campaign, PR #363's landed form): per-run
// staging — `stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flight-recorder-
// audit-XXXXXX")"` with every artifact riding "$stage/...", and cleanup
// of only the minted path.
//
// Per-skill by design, same as tests/tmp-staging-hygiene.test.mjs
// (PR #363): the corpus-wide scan stays reserved until every filed
// surface lands — gates-step-verbatim-repro /tmp/step.sh (#355) and
// the three #346 skills (in-flight PRs #359/#362/#363) would go red
// by design. This file is named distinctly (not folded into
// tmp-staging-hygiene.test.mjs) because #363 was still open when this
// pin was written — fold at review if #363 lands first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = () =>
  readFileSync(path.join(ROOT, ".agents", "skills", "flight-recorder-audit", "SKILL.md"), "utf8");

// The observed defect shapes — identical operator-prefixed forms as the
// #346 scanner (tests/tmp-staging-hygiene.test.mjs): line-based by
// design (the house lint doctrine: catch the observed defect class, not
// the universe). The "${TMPDIR:-/tmp}" mktemp default never matches:
// its /tmp is preceded by ':' inside the parameter expansion, not by a
// staging operator.
const FIXED_TMP_STAGING_SHAPES = [
  /-o \/tmp\//, // curl ... -o /tmp/app.zip
  /-d \/tmp\//, // unzip ... -d /tmp/app
  /> \/tmp\//, // git show ... > /tmp/s.zst
  /- \/tmp\//, // diff - /tmp/<repo>-wip-baseline.txt
  /attach \/tmp\//, // hdiutil attach /tmp/g.dmg
  /cp -R \/tmp\//, // cp -R /tmp/app/<App>.app
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

// --- negative pin: the skill teaches no fixed /tmp path ---------------------

test("issue #364: flight-recorder-audit stages through no fixed /tmp path", () => {
  const hits = violations(skill());
  assert.deepEqual(hits, [], `fixed /tmp staging shapes remain:\n${hits.join("\n")}`);
});

// --- positive pins: the per-run mktemp staging form is actually taught ------

test("issue #364: flight-recorder-audit decodes through a per-run mktemp dir", () => {
  const text = skill();
  assert.match(text, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-flight-recorder-audit-XXXXXX"/);
  assert.match(text, /> "\$stage\/s\.zst"/); // archive lands inside the minted dir
  assert.match(text, /zstd -dc "\$stage\/s\.zst" > "\$stage\/s\.jsonl"/); // decode rides the same dir
  assert.match(text, /rm -rf "\$stage"/); // cleanup: only the minted path
});

// --- scanner self-test: the pre-fix receipt lines ARE violations ------------
//
// Proves the negative pin bites: both exact lines quoted in the #364
// receipts (pristine main) trip at least one shape. A scanner that
// cannot see the defect class it exists to catch is decoration.

test("issue #364 scanner self-test: every pre-fix receipt line is a violation", () => {
  const receipts = [
    'git show "origin/tower-state:$F" > /tmp/s.zst',
    "zstd -dc /tmp/s.zst > /tmp/s.jsonl                     # one JSON event per line",
  ];
  for (const line of receipts) {
    assert.ok(
      violations(line).length > 0,
      `receipt line no longer trips the scanner — the pin is blind to it:\n  ${line}`,
    );
  }
});

// --- scanner false-positive guard -------------------------------------------
//
// The legal forms must stay legal: the mktemp default expansion and the
// prose mention inside the fixed skill's own explanatory comment.

test("issue #364 scanner self-test: mktemp TMPDIR defaults and prose mentions are not violations", () => {
  const legal = [
    'stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flight-recorder-audit-XXXXXX")"',
    "# per-run staging (issue #364) — a fixed /tmp/s.zst is swapped by a same-box sibling",
  ];
  for (const line of legal) {
    assert.deepEqual(
      violations(line),
      [],
      `legal line trips the scanner — false positive:\n  ${line}`,
    );
  }
});
