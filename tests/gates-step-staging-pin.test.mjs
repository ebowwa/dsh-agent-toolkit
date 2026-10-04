// tests/gates-step-staging-pin.test.mjs — corpus pin for issue #355.
//
// Contract under test: the gates-step-verbatim-repro recipe never stages
// the extracted CI step through a FIXED scratch name. On a multi-agent
// box (m1mini16gb runs four lane homes), two siblings executing this
// skill for DIFFERENT steps concurrently share one fixed path — the
// second write replaces the first's step mid-flight, so the first agent
// syntax-checks one file and RUNS another (TOCTOU), or simply clobbers
// it. #355's receipts, verified on pristine main @ 3da299e:
//
//   .agents/skills/gates-step-verbatim-repro/SKILL.md:22   open('/tmp/step.sh','w').write(s[i+7:j])
//   .agents/skills/gates-step-verbatim-repro/SKILL.md:25   bash -n /tmp/step.sh
//   .agents/skills/gates-step-verbatim-repro/SKILL.md:29   bash /tmp/step.sh
//
// The fix is per-run staging (mktemp mints a path only this run owns);
// this pin keeps it honest in three layers:
//
//   1. CORPUS — no literal /tmp/<segment> anywhere in the skill. The
//      detector is the same plain substring shape the #346 sibling pins
//      use (`/tmp/` + at least one non-space char), so it cannot match
//      the mktemp template the fixed skill teaches: `${TMPDIR:-/tmp}/…`
//      carries `/tmp}` (no trailing slash). Reintroduce a fixed path —
//      in a fence, in prose, in a comment — and this goes red.
//   2. TEETH — the exact OLD fence lines from the #355 receipts are
//      fixtures here: the detector must flag every one (proves the scan
//      is not vacuously green), and must NOT flag the NEW mktemp fence
//      (proves the fix shape is legal).
//   3. REVERT GUARD — the skill must actively teach the whole per-run
//      chain: a trailing-X mktemp template, the minted path passed as
//      python argv (a quoted heredoc cannot expand the variable), the
//      check/run/cleanup riding that same variable, and the byte-for-
//      byte extraction slice (s[i+7:j]) unchanged. A revert that swaps
//      the fences back goes red on layer 1 AND here.
//
// Scope note: this pin is deliberately skill-scoped, not corpus-wide —
// the corpus-wide scan (with its own grandfather list) rides the #346
// sibling pins; #355's skill drops off that grandfather list when this
// lands. A NEW fixed-/tmp path in a DIFFERENT skill is the corpus pin's
// business, not this file's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(ROOT, ".agents", "skills", "gates-step-verbatim-repro", "SKILL.md");

// `/tmp/` + >=1 non-space char — a literal fixed staging path. Cannot
// match `${TMPDIR:-/tmp}` (that is `/tmp}` with no trailing slash) nor a
// bare `/tmp` or `/tmp/` mention.
const FIXED_TMP_PATH = /\/tmp\/\S+/g;

function fixedTmpHits(text) {
  return [...text.matchAll(FIXED_TMP_PATH)].map((m) => m[0]);
}

test("corpus: the gates-step skill teaches no fixed /tmp scratch path", () => {
  const skill = readFileSync(SKILL, "utf8");
  const hits = fixedTmpHits(skill);
  assert.deepEqual(
    hits,
    [],
    `gates-step-verbatim-repro/SKILL.md carries literal fixed /tmp path(s) ${JSON.stringify(hits)} — the extracted step must stage through a per-run mktemp path (#355), not a name a same-box sibling can predict`
  );
});

test("teeth: the detector flags every #355 receipt line and spares the mktemp form", () => {
  // The exact OLD fence lines from pristine main @ 3da299e.
  const oldExtract = "       open('/tmp/step.sh','w').write(s[i+7:j])";
  const oldSyntaxCheck = "2. **Syntax-check it before running**: `bash -n /tmp/step.sh`.";
  const oldRun = "4. **Run it**: `bash /tmp/step.sh` from the repo root";
  for (const line of [oldExtract, oldSyntaxCheck, oldRun]) {
    assert.ok(
      fixedTmpHits(line).length >= 1,
      `detector must flag the receipt line: ${line}`
    );
  }
  // The NEW fence — the mktemp template must be legal.
  const newMint = 'step="$(mktemp "${TMPDIR:-/tmp}/dsh-step.XXXXXX")"';
  assert.deepEqual(fixedTmpHits(newMint), [], "mktemp template must not read as a fixed /tmp path");
  // Prose describing the class without quoting the old literal must be legal too.
  assert.deepEqual(fixedTmpHits("never a fixed name"), []);
});

test("revert guard: the skill actively teaches the per-run chain", () => {
  const skill = readFileSync(SKILL, "utf8");
  // 1. Trailing-X mktemp template (BSD mktemp rejects a suffix after the X's).
  assert.ok(
    skill.includes('mktemp "${TMPDIR:-/tmp}/dsh-step.XXXXXX"'),
    "the mint step must teach the trailing-X mktemp template"
  );
  // 2. The minted path reaches the extractor as argv — a quoted heredoc
  //    cannot expand the variable, and an unquoted one would corrupt
  //    step text containing `$`.
  assert.ok(
    skill.includes('python3 - "$step"'),
    "the extractor must receive the minted path as python argv"
  );
  assert.ok(
    skill.includes("open(sys.argv[1],'w')"),
    "the extractor must write to sys.argv[1], not a literal path"
  );
  // 3. Check, run, and cleanup ride the same variable.
  assert.ok(skill.includes('bash -n "$step"'), 'syntax check must ride "$step"');
  assert.ok(skill.includes('bash "$step"'), 'the run must ride "$step"');
  assert.ok(skill.includes('rm -f "$step"'), 'the cleanup must ride "$step"');
  // 4. The extraction slice stays byte-for-byte — only the destination changed.
  assert.ok(
    skill.includes("s[i+7:j]"),
    "the byte-for-byte extraction slice s[i+7:j] must survive the staging fix"
  );
});
