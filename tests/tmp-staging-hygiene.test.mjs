// tmp-staging-hygiene.test.mjs — corpus fixtures for the fixed-/tmp
// staging defect class (issue #346).
//
// Contract under test: a taught recipe never stages through a FIXED
// /tmp path. /tmp is host-global across every agent on a lane box, and
// a fixed name carries no session/claim identity — two same-box agents
// running the SAME skill fence concurrently collide: the second sibling's
// curl/unzip/mkfile overwrites the first's staging (or proof file)
// mid-flight, silently. Same silent-loss class as the workdir-hygiene
// protocol (issue #333 — clone recipes; pinned separately in
// tests/workdir-hygiene-contract.test.mjs), release/baseline flavor.
//
// Receipts (issue #346, pristine main 2026-10-04):
//   .agents/skills/gauge-plugin-release/SKILL.md:35-41 —
//     `curl ... -o /tmp/app.zip && unzip -oq /tmp/app.zip -d /tmp/app`,
//     `cp -R /tmp/app/<App>.app`, then the same for /tmp/plug.zip//tmp/plug;
//   .agents/skills/gauge-app-release/SKILL.md:28-29 —
//     `curl ... -o /tmp/g.dmg; hdiutil attach /tmp/g.dmg ...`;
//   .agents/skills/worktree-over-stash/SKILL.md:11,17 —
//     `git status --porcelain | sort > /tmp/<repo>-wip-baseline.txt`
//     then `diff - /tmp/<repo>-wip-baseline.txt` (fixed by the #333
//     contract; pinned here too because #346's acceptance names all
//     three skills).
//
// Fix shape: per-run staging — `stage="$(mktemp -d
// "${TMPDIR:-/tmp}/dsh-<flow>-XXXXXX")"` with every artifact riding
// "$stage/...", and cleanup of only the minted path.
//
// These pins were PER-SKILL while the class still had open surfaces: the
// corpus-wide scan was deliberately deferred (two more skills carried it —
// gates-step-verbatim-repro /tmp/step.sh, flight-recorder-audit
// /tmp/s.zst//tmp/s.jsonl — and widening early would have gone red on
// them by design). Every filed surface has landed fixed and per-skill
// pinned since: #346's three skills, #355 (gates-step-verbatim-repro),
// #364 (flight-recorder-audit). So the reserved corpus-wide scan RUNS
// from here on (issue #353's second acceptance criterion): a NEW
// fixed-/tmp staging path in ANY skill goes red the moment it lands —
// no new pin file required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = (name) => readFileSync(path.join(ROOT, ".agents", "skills", name, "SKILL.md"), "utf8");

// The observed defect shapes — a fixed /tmp name used as a staging or
// proof surface inside a taught recipe. Line-based by design (the house
// lint doctrine: catch the observed defect class, not the universe).
// Each alternative is the EXACT shape from an issue-#346 or #355
// receipt, so a revert of any fixed fence goes red on the matching arm.
// The "${TMPDIR:-/tmp}" mktemp default never matches: its /tmp is
// preceded by ':' inside the parameter expansion, not by a staging
// operator.
const FIXED_TMP_STAGING_SHAPES = [
  /-o \/tmp\//, // curl ... -o /tmp/app.zip
  /-d \/tmp\//, // unzip ... -d /tmp/app
  /> \/tmp\//, // sort > /tmp/<repo>-wip-baseline.txt
  /- \/tmp\//, // diff - /tmp/<repo>-wip-baseline.txt
  /attach \/tmp\//, // hdiutil attach /tmp/g.dmg
  /cp -R \/tmp\//, // cp -R /tmp/app/<App>.app
  /bash -n \/tmp\//, // bash -n /tmp/step.sh (#355 receipt)
  /bash \/tmp\//, // bash /tmp/step.sh (#355 receipt)
  /open\(['"]\/tmp\//, // python open('/tmp/step.sh','w') (#355 receipt)
];

/** All fixed-/tmp staging violations in a skill's text, with line numbers. */
function violations(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const shape of FIXED_TMP_STAGING_SHAPES) {
      if (shape.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

// --- negative pins: none of the three skills teaches a fixed /tmp path --

test("issue #346: gauge-plugin-release teaches no fixed /tmp staging path", () => {
  const hits = violations(skill("gauge-plugin-release"));
  assert.deepEqual(hits, [], `fixed /tmp staging shapes remain:\n${hits.join("\n")}`);
});

test("issue #346: gauge-app-release teaches no fixed /tmp staging path", () => {
  const hits = violations(skill("gauge-app-release"));
  assert.deepEqual(hits, [], `fixed /tmp staging shapes remain:\n${hits.join("\n")}`);
});

test("issue #346: worktree-over-stash baselines through no fixed /tmp path", () => {
  const hits = violations(skill("worktree-over-stash"));
  assert.deepEqual(hits, [], `fixed /tmp staging shapes remain:\n${hits.join("\n")}`);
});

// --- corpus-wide scan (issue #353's second acceptance criterion) --------
//
// The reserved sweep: every skill in the corpus, the same scanner. Every
// filed surface of the class is fixed and per-skill pinned (#346 x3,
// #355, #364), so this runs green today — and a NEW fixed-/tmp staging
// path in ANY skill (a new skill, a revert, a "temporary" example fence)
// goes red the moment it lands, without waiting for someone to file the
// found: ticket and hand-write the next per-skill pin.

const ALL_SKILL_PATHS = readdirSync(path.join(ROOT, ".agents", "skills"))
  .filter((d) => d.endsWith(".md") === false)
  .map((d) => path.join(ROOT, ".agents", "skills", d, "SKILL.md"))
  .filter((p) => {
    try { readFileSync(p, "utf8"); return true; } catch { return false; }
  });

test("issue #353: the corpus scan actually sees the skills corpus", () => {
  // A vacuous sweep (empty/broken enumeration) must fail loudly, not
  // pass as a zero-violation green.
  assert.ok(
    ALL_SKILL_PATHS.length >= 30,
    `corpus scan enumerated only ${ALL_SKILL_PATHS.length} skills — the sweep would be vacuous`,
  );
});

test("issue #353: NO skill in the corpus stages through a fixed /tmp path", () => {
  const offenders = [];
  for (const p of ALL_SKILL_PATHS) {
    const name = path.basename(path.dirname(p));
    for (const hit of violations(readFileSync(p, "utf8"))) {
      offenders.push(`${name}/SKILL.md ${hit}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `fixed /tmp staging shapes in the skills corpus (mint a per-run mktemp path instead):\n${offenders.join("\n")}`,
  );
});

// --- positive pins: the per-run mktemp staging forms are actually taught --

test("issue #346: gauge-plugin-release stages app+plugin through a per-run mktemp dir", () => {
  const text = skill("gauge-plugin-release");
  assert.match(text, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-gauge-plugin-release-XXXXXX"/);
  assert.match(text, /-o "\$stage\/app\.zip"/);
  assert.match(text, /-o "\$stage\/plug\.zip"/);
  assert.match(text, /rm -rf "\$stage"/); // cleanup: only the minted path
});

test("issue #346: gauge-app-release stages the DMG (and its mountpoint) through a per-run mktemp dir", () => {
  const text = skill("gauge-app-release");
  assert.match(text, /mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-gauge-app-release-XXXXXX"/);
  assert.match(text, /-o "\$stage\/g\.dmg"/);
  // the mountpoint rides the stage too — a fixed /Volumes/G is as shared as /tmp
  assert.match(text, /hdiutil attach "\$stage\/g\.dmg" -nobrowse -mountpoint "\$stage\/G"/);
  assert.doesNotMatch(text, /-mountpoint \/Volumes\//);
  assert.match(text, /rm -rf "\$stage"/);
});

test("issue #346: worktree-over-stash baselines into a mktemp file and diffs the same variable", () => {
  const text = skill("worktree-over-stash");
  assert.match(text, /baseline="\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/<repo>-wip-baseline\.XXXXXX"\)"/);
  assert.match(text, /sort > "\$baseline"/);
  assert.match(text, /diff - "\$baseline"/);
});

// --- scanner self-test: the pre-fix receipt lines ARE violations ---------
//
// Proves the negative pins bite: every exact line quoted in the issue
// #346 receipts (pristine main) trips at least one shape. A scanner that
// cannot see the defect class it exists to catch is decoration.

test("issue #346 scanner self-test: every pre-fix receipt line is a violation", () => {
  const receipts = [
    'curl -sL "<app.zip URL>" -o /tmp/app.zip && unzip -oq /tmp/app.zip -d /tmp/app',
    "rm -rf /Applications/<App>.app && cp -R /tmp/app/<App>.app /Applications/",
    'curl -sL "<plugin.zip URL>" -o /tmp/plug.zip && unzip -oq /tmp/plug.zip -d /tmp/plug',
    "cp -R /tmp/plug/<Name>.gaugeplugin ~/Library/Application\\ Support/Gauge/plugins/",
    'curl -sL "https://secondsee.com/downloads/gauge/Gauge-<VER>.dmg" -o /tmp/g.dmg',
    "hdiutil attach /tmp/g.dmg -nobrowse -mountpoint /Volumes/G && cp -R /Volumes/G/Gauge.app /Applications/ && hdiutil detach /Volumes/G",
    "1. Baseline before touching anything: `git status --porcelain | sort > /tmp/<repo>-wip-baseline.txt`",
    "6. Prove the main checkout untouched: `git status --porcelain | sort | diff - /tmp/<repo>-wip-baseline.txt` → must be empty.",
  ];
  for (const line of receipts) {
    assert.ok(
      violations(line).length > 0,
      `receipt line no longer trips the scanner — the pin is blind to it:\n  ${line}`,
    );
  }
});

// The #355 receipts (gates-step-verbatim-repro /tmp/step.sh) exercise the
// three EXTENDED shapes: a fixed path read, syntax-checked, executed, and
// written through python's open() — none carries a #346 staging operator,
// so a scanner without these arms is blind to the extract→check→run
// TOCTOU class corpus-wide.

test("issue #353 scanner self-test: every #355 receipt line is a violation", () => {
  const receipts = [
    "       open('/tmp/step.sh','w').write(s[i+7:j])",
    '       open("/tmp/step.sh","w").write(s[i+7:j])', // double-quote form
    "3. **Syntax-check it before running**: `bash -n /tmp/step.sh`.",
    "5. **Run it**: `bash /tmp/step.sh` from the repo root",
  ];
  for (const line of receipts) {
    assert.ok(
      violations(line).length > 0,
      `receipt line no longer trips the scanner — the pin is blind to it:\n  ${line}`,
    );
  }
});

// --- scanner false-positive guard ----------------------------------------
//
// The legal forms must stay legal: the mktemp default expansion and the
// prose ban inside the fixed skills' own explanatory mentions.

test("issue #346 scanner self-test: mktemp TMPDIR defaults and prose bans are not violations", () => {
  const legal = [
    'stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-gauge-plugin-release-XXXXXX")"',
    'baseline="$(mktemp "${TMPDIR:-/tmp}/<repo>-wip-baseline.XXXXXX")"; git status --porcelain | sort > "$baseline"',
    "(mktemp — a fixed `/tmp/<repo>-...` path collides with same-box siblings, issue #333)",
    // the #355 fix shapes — every leg rides the minted variable
    'step="$(mktemp "${TMPDIR:-/tmp}/dsh-step.XXXXXX")"',
    'python3 - "$step" <<\'EOF\'',
    "open(sys.argv[1],'w').write(s[i+7:j])",
    'bash -n "$step"',
    'bash "$step"',
    'rm -f "$step"',
    // the #364 fix shape — decode/encode through the minted dir
    'zstd -dc "$stage/s.zst" > "$stage/s.jsonl"',
  ];
  for (const line of legal) {
    assert.deepEqual(
      violations(line),
      [],
      `legal line wrongly flagged:\n  ${line}`,
    );
  }
});
