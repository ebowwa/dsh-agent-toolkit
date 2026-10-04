// skill-staging-contract.test.mjs — contract fixtures for the per-run
// staging protocol in taught skills (issue #346).
//
// Contract under test: no taught skill stages release installs or proof
// files through a FIXED /tmp path. Two same-box agents running the same
// recipe concurrently collide — the second overwrites the first's
// staging (or proof file) mid-flight, silently (the #346 receipts: the
// two gauge release fences staged through /tmp/g.dmg, /tmp/app*,
// /tmp/plug*; the worktree-over-stash baseline through
// /tmp/<repo>-wip-baseline.txt — the same silent-loss family as the
// clone-path collision #333, different surface).
//
// The fix this pins: every staging fence/span mints a per-run directory
// first — `stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-<flow>-XXXXXX")"` —
// and stages under "$stage/...". The XXXXXX suffix is the collision
// guard: two same-box siblings mint different dirs.
//
// Scope: the THREE skills issue #346 names. The corpus carries two more
// fixed-/tmp skills of the same family (gates-step-verbatim-repro's
// /tmp/step.sh, flight-recorder-audit's /tmp/s.zst) that #346
// deliberately excludes — widening this pin to all skills lands with
// their fix, not here (no scope-creep; the exclusion is filed).
//
// Detector design: code contexts ONLY — fenced blocks and inline code
// spans. Prose may NAME a fixed /tmp path to ban it; only a path an
// agent would EXECUTE is the recipe. The mktemp template itself carries
// the literal "/tmp" inside "${TMPDIR:-/tmp}" — no path separator
// follows it, so the detector spares it by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The three skills issue #346 names.
const SKILLS = [
  "gauge-app-release",
  "gauge-plugin-release",
  "worktree-over-stash",
];

const skillPath = (name) => path.join(ROOT, ".agents", "skills", name, "SKILL.md");

// A literal fixed path under /tmp in code: "/tmp/" then any run of
// non-quote non-whitespace (placeholders like <repo> included — a
// placeholder path is still a fixed, shared path once instantiated).
// "${TMPDIR:-/tmp}" is spared: the character after "/tmp" is "}", not a
// separator.
const FIXED_TMP_STAGING = /\/tmp\/[^\s"'`]+/;

// Extract everything a reader would EXECUTE from a skill body: fenced
// code blocks and inline code spans. Prose between them is not code.
const codeContexts = (text) => {
  const out = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (let m; (m = fence.exec(text)); ) out.push(m[1]);
  const withoutFences = text.replace(/```[^\n]*\n[\s\S]*?```/g, "");
  const span = /`([^`\n]+)`/g;
  for (let m; (m = span.exec(withoutFences)); ) out.push(m[1]);
  return out;
};

// The per-run mint every fixed skill must carry instead.
const MKTEMP_MINT = /stage="\$\(mktemp -d "\$\{TMPDIR:-\/tmp\}\/dsh-[a-z-]+-XXXXXX"\)"/;

// --- the three named skills: no fixed /tmp staging, mint present --------

test("issue #346: none of the three skills stages through a fixed /tmp path (code contexts only)", () => {
  for (const name of SKILLS) {
    const text = readFileSync(skillPath(name), "utf8");
    const offenders = [];
    for (const code of codeContexts(text)) {
      const m = code.match(FIXED_TMP_STAGING);
      if (m) offenders.push(`${m[0]} in ${JSON.stringify(code.slice(0, 60))}`);
    }
    assert.deepEqual(offenders, [], `${name}: staging must ride a per-run mktemp dir, not a fixed /tmp path`);
  }
});

test("issue #346: each of the three skills teaches the per-run mktemp stage", () => {
  for (const name of SKILLS) {
    const text = readFileSync(skillPath(name), "utf8");
    assert.match(text, MKTEMP_MINT, `${name}: the staging fence must mint its workdir with mktemp -d`);
  }
});

// --- detector fixtures: catches every pre-fix spelling, spares the rest -

test("issue #346 detector: catches the pre-fix fixed-/tmp recipes, spares the mktemp forms and prose", () => {
  // Catches — the exact spellings the three skills carried (receipts in
  // the issue body):
  for (const bad of [
    'curl -sL "<app.zip URL>" -o /tmp/app.zip && unzip -oq /tmp/app.zip -d /tmp/app',
    "curl -sL https://secondsee.com/downloads/gauge/Gauge-<VER>.dmg -o /tmp/g.dmg",
    "git status --porcelain | sort > /tmp/<repo>-wip-baseline.txt",
    "git show origin/x:f > /tmp/s.zst && zstd -dc /tmp/s.zst > /tmp/s.jsonl",
  ]) {
    assert.match(bad, FIXED_TMP_STAGING, `detector must catch: ${bad.slice(0, 50)}…`);
  }
  // Spares — the per-run mint (the "}" before the separator), "$stage"
  // targets, and PROSE that names a fixed path to ban it (prose is not
  // code; the extractor below never hands it to the detector):
  for (const good of [
    'stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-gauge-app-XXXXXX")"',
    'curl -sL "<URL>" -o "$stage/g.dmg"',
    'git status --porcelain | sort | diff - "$stage/wip-baseline.txt"',
    "Prose may name the old fixed baseline path to ban it — no code span, no recipe.",
  ]) {
    assert.doesNotMatch(good, FIXED_TMP_STAGING, `detector must spare: ${good.slice(0, 50)}…`);
  }
});

test("issue #346 detector: code-context extraction covers fences and inline spans, never prose", () => {
  const body = [
    "Prose may say /tmp/step.sh without teaching it.",
    "",
    "```bash",
    "echo fenced /tmp/x.sh",
    "```",
    "",
    "Inline span: `echo span /tmp/y.sh` — and nothing else.",
  ].join("\n");
  const code = codeContexts(body).join("\n");
  assert.match(code, /fenced \/tmp\/x\.sh/);
  assert.match(code, /span \/tmp\/y\.sh/);
  assert.doesNotMatch(code, /Prose may say/);
});
