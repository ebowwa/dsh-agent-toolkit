// gates-step-staging.test.mjs — contract pin for the gates-step-verbatim-
// repro skill's staging discipline (issue #355).
//
// Contract under test: the skill teaches ONE per-run staging path for the
// extract → syntax-check → run chain, minted through mktemp — never a
// fixed /tmp name. The #355 receipts: two same-box agents reproducing
// DIFFERENT CI steps through the shared `/tmp/step.sh` clobber each
// other mid-flight, so the first agent's `bash -n` validates — or worse,
// its `bash` RUNS — the second agent's step. Silent wrong-run, the exact
// #346/#333 sibling-collision class on the step-repro surface.
//
// The pin keeps the fix honest in three layers (the shape mirrors the
// #346 corpus pins, scoped to this one skill):
//
//   1. CORPUS — no literal `/tmp/<segment>` anywhere in the skill. The
//      detector is the plain substring shape `/tmp/` + ≥1 non-space
//      char, so it cannot match the mktemp template the fixed skill
//      teaches: `${TMPDIR:-/tmp}/dsh-step-XXXXXX` carries `/tmp}` (no
//      trailing slash after `tmp`).
//   2. FIX SHAPE — the mint keeps the X-run TRAILING (BSD mktemp
//      rejects a suffix after the X's — `dsh-step-XXXXXX.sh` fails to
//      mint on mac cells), and the whole chain rides ONE variable
//      (`"$step"`): the python fence writes `sys.argv[1]`, the
//      syntax check and the run both invoke `"$step"`, and the cleanup
//      removes it. A chain that mints a path but checks/runs a
//      different spelling re-opens the window.
//   3. TEETH — the exact OLD fence lines from the #355 receipts are
//      fixtures here: the detector must flag every one (proves the
//      scan is not vacuously green) and must NOT flag the NEW mktemp
//      fence (proves the fix shape is legal).
//
// The corpus-wide scan over ALL skills lives with the #346 fix (three
// racing PRs carry it); this pin is deliberately scoped to the one skill
// #355 names so it holds regardless of which corpus pin lands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(ROOT, ".agents", "skills", "gates-step-verbatim-repro", "SKILL.md");

// `/tmp/` + ≥1 non-space char — a literal fixed staging path. Cannot
// match `${TMPDIR:-/tmp}` (that is `/tmp}` with no trailing slash) nor
// a bare `/tmp` mention.
const FIXED_TMP_PATH = /\/tmp\/\S+/g;

// --- layer 1: corpus — the skill carries no fixed /tmp staging path ------

test("issue #355: the skill teaches no fixed /tmp staging path", () => {
  const skill = readFileSync(SKILL, "utf8");
  const matches = skill.match(FIXED_TMP_PATH) ?? [];
  assert.deepEqual(
    matches,
    [],
    `gates-step-verbatim-repro stages through a FIXED path (the #355 clobber class — mint per-run with mktemp): ${matches.join(", ")}`,
  );
});

// --- layer 2: fix shape — one minted path carries the whole chain ---------

test("issue #355: the mint is mktemp with a TRAILING X-run (BSD mktemp rejects a suffix)", () => {
  const skill = readFileSync(SKILL, "utf8");
  assert.match(
    skill,
    /mktemp "\$\{TMPDIR:-\/tmp\}\/dsh-step-XXXXXX"/,
    "the skill must teach the mktemp mint, X-run trailing (no suffix after the X's)",
  );
  // The EXECUTABLE fences must never regress into the suffixed form BSD
  // rejects (prose may name the anti-pattern to teach it — fences may not
  // teach running it).
  const fences = skill.split("\n").filter((l) => /^ {7,}\S/.test(l));
  const suffixed = fences.filter((l) => /dsh-step-X+\.sh/.test(l));
  assert.deepEqual(
    suffixed,
    [],
    "a fence teaching `dsh-step-XXXXXX.sh` mints nothing on BSD mktemp (mac cells) — keep the X-run trailing",
  );
});

test("issue #355: extract → check → run → cleanup all ride the ONE minted $step", () => {
  const skill = readFileSync(SKILL, "utf8");
  // The python fence writes the path it was handed, not a baked-in name:
  assert.match(skill, /python3 - "\$step"/, "the extractor receives the minted path as argv");
  assert.match(skill, /open\(sys\.argv\[1\],'w'\)/, "the extractor writes sys.argv[1] — the minted path");
  // The check and the run invoke the same variable:
  assert.match(skill, /bash -n "\$step"/, "the syntax check rides the minted path");
  assert.match(skill, /bash "\$step"`,? from the repo root/, "the run rides the minted path");
  // The cleanup disposes of it:
  assert.match(skill, /rm -f "\$step"/, "the skill cleans up its own staging path");
  // And no fixed step-extraction name survives anywhere.
  assert.doesNotMatch(skill, /step\.sh/, "the fixed /tmp/step.sh spelling must not survive, even as prose");
});

// --- layer 3: teeth — the detector is not vacuously green ------------------

test("teeth: the detector flags every OLD #355 fence and passes the NEW mktemp fence", () => {
  // Verbatim old fence lines from the #355 receipts (pristine main @ 3da299e).
  const OLD_FENCES = [
    `open('/tmp/step.sh','w').write(s[i+7:j])`,
    `bash -n /tmp/step.sh`,
    `bash /tmp/step.sh from the repo root`,
  ];
  for (const fence of OLD_FENCES) {
    assert.ok(
      FIXED_TMP_PATH.test(fence),
      `detector must flag the old fence: ${fence}`,
    );
    FIXED_TMP_PATH.lastIndex = 0; // global regexes keep state — reset per leg
  }
  // The NEW fence mints through the TMPDIR-respecting template and must
  // stay legal under the same detector.
  const NEW_FENCE = `step="$(mktemp "\${TMPDIR:-/tmp}/dsh-step-XXXXXX")"`;
  FIXED_TMP_PATH.lastIndex = 0;
  assert.ok(
    !FIXED_TMP_PATH.test(NEW_FENCE),
    "detector must NOT flag the mktemp template (that is the legal per-run form)",
  );
  FIXED_TMP_PATH.lastIndex = 0;
});
