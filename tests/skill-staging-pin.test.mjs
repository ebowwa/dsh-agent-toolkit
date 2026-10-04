// tests/skill-staging-pin.test.mjs — corpus pin for issue #346.
//
// Contract under test: a TAUGHT recipe (.agents/skills/**) never stages
// through a FIXED /tmp/<name> path. On a multi-agent box (m1mini16gb runs
// four lane homes), two siblings executing the same skill concurrently
// share every literal /tmp path — the second run's write clobbers the
// first's staging mid-flight, silently. #346's receipts, all verified on
// pristine main @ 3da299e:
//
//   .agents/skills/gauge-plugin-release/SKILL.md:35-41   /tmp/app.zip, /tmp/app, /tmp/plug.zip, /tmp/plug
//   .agents/skills/gauge-app-release/SKILL.md:28-29      /tmp/g.dmg
//   .agents/skills/worktree-over-stash/SKILL.md:11,17    /tmp/<repo>-wip-baseline.txt
//
// The fix is per-run staging (mktemp mints a path only this run owns);
// this pin keeps it honest in three layers:
//
//   1. CORPUS — no literal /tmp/<segment> in ANY skill markdown outside
//      the grandfather list. The detector is a plain substring shape
//      (`/tmp/` + at least one non-space char), so it cannot match the
//      mktemp templates the fixed skills teach: `${TMPDIR:-/tmp}/dsh-…`
//      carries `/tmp}` (no trailing slash), and `$stage/…` carries no
//      `/tmp/` at all. Reintroduce a fixed path anywhere — these three
//      skills, or any other skill — and this goes red.
//   2. TEETH — the exact OLD fence lines from the #346 receipts are
//      fixtures here: the detector must flag every one (proves the scan
//      is not vacuously green), and must NOT flag the NEW mktemp fences
//      (proves the fix shape is legal).
//   3. REVERT GUARD — each of the three fixed skills must actively teach
//      `mktemp` staging. A revert that swaps the fences back goes red on
//      layer 1 (the /tmp literal returns) AND here (mktemp disappears).
//
// Grandfathered, NOT fixed here — same class, out of #346's named scope,
// filed separately per the discovery protocol (scope-creep is a
// contract violation, not a shortcut):
//
//   gates-step-verbatim-repro — /tmp/step.sh  → tracked in #355
//   flight-recorder-audit     — /tmp/s.*      → tracked in #356
//
// Each lands its own fix and drops off this list; the list must only
// ever shrink. A NEW fixed-/tmp path in a NEW skill is never covered by
// the grandfather — that is the point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, ".agents", "skills");

// `/tmp/` + ≥1 non-space char — a literal fixed staging path. Cannot
// match `${TMPDIR:-/tmp}` (that is `/tmp}` with no trailing slash) nor a
// bare `/tmp` or `/tmp/` mention.
const FIXED_TMP_PATH = /\/tmp\/\S+/g;

// Skills whose fixed-/tmp usage predates this pin and is tracked in its
// own ticket. Keys are paths relative to .agents/skills.
const GRANDFATHERED = new Map([
  ["gates-step-verbatim-repro/SKILL.md", "#355"],
  ["flight-recorder-audit/SKILL.md", "#356"],
]);

// The three skills #346 names — fixed by the same claim as this pin,
// and required to KEEP teaching per-run staging.
const FIXED_SKILLS = [
  "gauge-plugin-release/SKILL.md",
  "gauge-app-release/SKILL.md",
  "worktree-over-stash/SKILL.md",
];

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkMarkdown(full);
    } else if (entry.endsWith(".md")) {
      yield full;
    }
  }
}

function fixedTmpMatches(text) {
  return text.match(FIXED_TMP_PATH) ?? [];
}

test("corpus: no skill teaches a fixed /tmp staging path outside the grandfather list", () => {
  const offenders = [];
  const grandfatherHits = [];
  for (const file of walkMarkdown(SKILLS_DIR)) {
    const rel = path.relative(SKILLS_DIR, file);
    const matches = fixedTmpMatches(readFileSync(file, "utf8"));
    if (!matches.length) continue;
    if (GRANDFATHERED.has(rel)) {
      grandfatherHits.push(rel);
    } else {
      offenders.push(`${rel}: ${matches.join(", ")}`);
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `skills staging through FIXED /tmp paths (the #346 clobber class — use per-run mktemp staging):\n  ${offenders.join("\n  ")}`,
  );
  // The grandfather must stay honest: every listed entry still names a
  // real skill dir (a renamed/removed skill leaves a stale exemption).
  for (const rel of grandfatherHits) {
    assert.ok(GRANDFATHERED.has(rel), `grandfather entry stopped matching: ${rel}`);
  }
});

test("teeth: the detector flags every OLD #346 fence and passes the NEW mktemp fences", () => {
  // Verbatim old fence lines from the #346 receipts.
  const OLD_FENCES = [
    `curl -sL "<app.zip URL>" -o /tmp/app.zip && unzip -oq /tmp/app.zip -d /tmp/app`,
    `rm -rf /Applications/<App>.app && cp -R /tmp/app/<App>.app /Applications/`,
    `curl -sL "<plugin.zip URL>" -o /tmp/plug.zip && unzip -oq /tmp/plug.zip -d /tmp/plug`,
    `cp -R /tmp/plug/<Name>.gaugeplugin ~/Library/Application\\ Support/Gauge/plugins/`,
    `curl -sL "https://secondsee.com/downloads/gauge/Gauge-<VER>.dmg" -o /tmp/g.dmg`,
    `hdiutil attach /tmp/g.dmg -nobrowse -mountpoint /Volumes/G`,
    `git status --porcelain | sort > /tmp/<repo>-wip-baseline.txt`,
    `git status --porcelain | sort | diff - /tmp/<repo>-wip-baseline.txt`,
  ];
  for (const fence of OLD_FENCES) {
    assert.ok(
      fixedTmpMatches(fence).length > 0,
      `detector went blind on an old fence: ${fence}`,
    );
  }

  // The new per-run shapes must stay clean. (Plain quotes: the fences
  // contain ${…} shell parameter expansion that a JS template literal
  // would interpolate.)
  const NEW_FENCES = [
    'stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-gauge-plugin-release-XXXXXX")"',
    `curl -sL "<app.zip URL>" -o "$stage/app.zip" && unzip -oq "$stage/app.zip" -d "$stage/app"`,
    `rm -rf "$stage"`,
    'baseline="$(mktemp "${TMPDIR:-/tmp}/dsh-wip-baseline-XXXXXX")"; git status --porcelain | sort > "$baseline"',
    `git status --porcelain | sort | diff - "$baseline"`,
  ];
  for (const fence of NEW_FENCES) {
    assert.deepStrictEqual(
      fixedTmpMatches(fence),
      [],
      `legal per-run fence flagged as fixed-/tmp: ${fence}`,
    );
  }
});

test("revert guard: each #346-fixed skill still teaches mktemp per-run staging", () => {
  for (const rel of FIXED_SKILLS) {
    const text = readFileSync(path.join(SKILLS_DIR, rel), "utf8");
    assert.match(
      text,
      /mktemp/,
      `${rel} lost its per-run mktemp staging — the #346 fix reverted?`,
    );
    assert.deepStrictEqual(
      fixedTmpMatches(text),
      [],
      `${rel} reintroduced a fixed /tmp staging path`,
    );
  }
});

test("grandfather list: every entry points at an existing skill file", () => {
  for (const rel of GRANDFATHERED.keys()) {
    const full = path.join(SKILLS_DIR, rel);
    assert.ok(statSync(full).isFile(), `grandfathered skill missing: ${rel} (drop the entry)`);
  }
});
