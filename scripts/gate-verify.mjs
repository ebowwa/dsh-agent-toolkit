#!/usr/bin/env node
// gate-verify.mjs — line-strict extraction of the independent-verification
// marker from a PR comment (issue #326), the channel twin of
// review-verdict.mjs / drift-verdict.mjs.
//
// The gap (issue #326): the fleet mints every PR under one shared account,
// so GitHub rejects `gh pr review --approve` from ANY agent
// ("Review can not approve your own pull request"). An agent that
// independently verified a sibling PR could only leave comment noise the
// merge decision never sees. The channel: the verifying agent posts a PR
// comment whose line `gate-verify: pass` (or `gate-verify: fail`) IS the
// verification — receipts ride the surrounding comment text.
//
// Line-strict, exactly like review-verdict.mjs: a marker is A LINE that IS
// a marker, never a substring inside prose ("I'll post gate-verify: pass
// once gates finish" must not parse). The difference from the verdict
// twins: the `gate-verify:` label is REQUIRED, not optional — a bare
// `pass` line in free prose must never count, because this channel is a
// deliberate machine marker, not a verdict word a reviewer was told to
// end with. The LAST marker line in the comment wins (the comment's final
// word on verification — the drift-verdict lesson).
//
// Vocabulary:
//   pass | passed | passing  → PASS
//   fail | failed | failing  → FAIL
// (case-insensitive; markdown decoration `**gate-verify:**` and backticks
// strip first, mirroring review-verdict.mjs's DECOR pass.)
//
// Usage: node gate-verify.mjs <comment-file>
//   stdout: PASS | FAIL — or empty (the comment carries no marker)
//   exit:   0 parsing completed (marker may be empty);
//           2 bad usage / unreadable input.
//
// Comment bodies are unscrubbed agent text; this tool only ever emits the
// verdict word — the body itself never passes through (pr-verification.mjs
// relies on that when it aggregates comments into the merge decision).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [outFile] = process.argv.slice(2);

if (!outFile) {
  console.error("gate-verify: usage: node gate-verify.mjs <comment-file>");
  process.exit(2);
}
if (!existsSync(outFile)) {
  console.error("gate-verify: comment file is missing");
  process.exit(2);
}

// Decoration pass identical to review-verdict.mjs's DECOR: bold/italics/
// code/quote/heading markers strip before the anchored match, so
// `**gate-verify:** pass` and "`gate-verify: pass`" both qualify while the
// WORDS still have to stand alone on the line.
const DECOR = /[*_`>#"']/g;
// The label is REQUIRED (the review-verdict contrast): anchor on
// gate-verify / gate_verify / gateverify, colon, then the marker word —
// and NOTHING else on the line (a prose suffix is the substring trap).
const MARKER_LINE = /^\s*gate[-_ ]?verify\s*:\s*(pass(?:ed|ing)?|fail(?:ed|ing)?)[.,;:! ]*$/i;

const markerOfLine = line => {
  const stripped = line.trim().replace(DECOR, "");
  const m = MARKER_LINE.exec(stripped);
  if (!m) return null;
  return m[1].toLowerCase().startsWith("pass") ? "PASS" : "FAIL";
};

const text = readFileSync(outFile, "utf8");

// Last marker line wins (the comment's final word — the drift-verdict
// lesson: flipping this order mis-parses a reconsidered verdict).
let marker = null;
for (const line of text.split("\n").reverse()) {
  marker = markerOfLine(line);
  if (marker) break;
}

process.stdout.write(`${marker ?? ""}\n`);
