// agent-contract.test.mjs — the standing agent contract (issue #113).
//
// Lane agents observed out-of-scope problems and stayed silent, because no
// instruction anywhere in the standing contract asked for more: the driver
// assembled the prompt with zero issue-filing protocol (the only
// `gh issue create` calls lived in the worker dashboard and the dispatch
// trigger — never in anything an agent reads). Three things are pinned
// here:
//   1. the driver STAMPS the discovery protocol into every task, and the
//      append sits OUTSIDE the REPLY_TARGET guard — dispatched worker
//      tasks and legacy CI comment jobs both inherit it;
//   2. the contract docs (.agents/README.md, CONTRIBUTING.md) carry the
//      same protocol, so a doc-only reader gets the identical rule set;
//   3. the exit-summary shape: ONE `filed-followups:` line, comma-space
//      separated issue refs, nothing else on the line; filed nothing — the
//      line is omitted entirely (`filed-followups: none` is a violation,
//      not an absence).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const driverSrc = readFileSync(path.join(ROOT, "scripts", "run-dsh-agent.sh"), "utf8");
const agentsReadme = readFileSync(path.join(ROOT, ".agents", "README.md"), "utf8");
const contributing = readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8");

// The machine-checkable form of the exit-summary shape documented in
// .agents/README.md. Matching is relay-tolerant: a markdown bullet /
// blockquote / bold decoration in front of the label is stripped before
// the check (the reply relay may sit inside markdown), so the RELAYED
// line is validated by the same rules instead of being skipped — but the
// line itself carries nothing but the label and the refs.
const FILED_FOLLOWUPS_LINE = /^filed-followups: #\d+(, #\d+)*$/;

// Markdown relay tolerance (issue #141): the reply relay may decorate the
// label with a list bullet / blockquote marker / bold pair — "- filed-followups:",
// "**filed-followups:**". Strip exactly that
// decoration before the label check so the RELAYED line is VALIDATED by
// the shape rules below — a bullet-relayed `filed-followups: none` is a
// violation, not an invisible line (a bare `startsWith` skipped it, which
// made the markdown-relay-safe claim vacuous).
const stripMarkdownRelay = (line) =>
  line.replace(/^[-*\s>]+/, "").replace(/:\*\*(?=\s|$)/, ":");

/** Violations of the exit-summary shape in an agent's final summary. */
const followupsViolations = (summary) => {
  const violations = [];
  const lines = summary.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = stripMarkdownRelay(lines[i].trim());
    if (!line.startsWith("filed-followups")) continue;
    seen++;
    if (!FILED_FOLLOWUPS_LINE.test(line)) {
      violations.push(`line ${i + 1} is not the documented shape: ${JSON.stringify(lines[i])}`);
    }
  }
  if (seen > 1) violations.push(`${seen} filed-followups lines — the contract allows ONE`);
  return violations;
};

// --- 1. the prompt assembly inherits the protocol ------------------------

test("the driver stamps the discovery protocol into every task (issue #113)", () => {
  assert.match(driverSrc, /STANDING_CONTRACT=/, "the contract block must exist");
  assert.match(driverSrc, /file what you notice, never silently scope-creep/);
  assert.match(driverSrc, /Title starts with\n   "found:"/, "the found: title-prefix rule");
  assert.match(driverSrc, /receipts: file:line, command output/, "the receipts requirement");
  assert.match(driverSrc, /agent-todo/, "the todo-label rule");
  assert.match(driverSrc, /filed-followups:/, "the exit-summary followups line");
  assert.match(driverSrc, /filed-followups: #114, #115/, "the exact-shape example");
});

test("the append is unconditional: it sits OUTSIDE the REPLY_TARGET guard", () => {
  const guard = driverSrc.indexOf('if [ "${REPLY_TARGET:-}" != "" ]');
  const append = driverSrc.indexOf('TASK="${TASK}\n\n${STANDING_CONTRACT}"');
  assert.ok(guard > -1, "the REPLY_TARGET guard exists");
  assert.ok(append > -1, "the unconditional append exists");
  assert.ok(
    append < guard,
    "the append must precede the REPLY_TARGET guard — a dispatched task (REPLY_TARGET empty) must carry the contract too",
  );
});

test("the single-quoted contract assignment survives intact (no premature close)", () => {
  const assign = driverSrc.match(/STANDING_CONTRACT='[^']*'/);
  assert.ok(assign, "one balanced single-quoted assignment");
  assert.match(assign[0], /filed-followups: #114, #115/, "the shape text lives inside the assignment");
});

// --- 2. the contract docs carry the same protocol ------------------------

test("the contract docs carry the protocol and the same exit-summary shape", () => {
  for (const [name, text] of [[".agents/README.md", agentsReadme], ["CONTRIBUTING.md", contributing]]) {
    assert.match(text, /found:/, `${name}: the found: title-prefix rule`);
    assert.match(text, /receipts/, `${name}: the receipts requirement`);
    assert.match(text, /agent-todo/, `${name}: the todo-label rule`);
    assert.match(text, /filed-followups: #114, #115/, `${name}: the exact-shape example`);
    assert.match(text, /scope-creep/, `${name}: the no-scope-creep rule`);
  }
});

test("no-scope-creep is stated as a refusal with the trivial AND in-scope carve-out", () => {
  for (const [name, text] of [["the driver", driverSrc], [".agents/README.md", agentsReadme], ["CONTRIBUTING.md", contributing]]) {
    assert.match(text, /trivial AND in-scope/, `${name}: the carve-out wording`);
  }
});

test("the docs point at the enforcement seam (the driver stamps every task)", () => {
  assert.match(agentsReadme, /run-dsh-agent\.sh/);
  assert.match(contributing, /run-dsh-agent\.sh/);
});

// --- 3. the exit-summary shape (fixtures) --------------------------------

test("exit-summary shape: a single filed issue", () => {
  assert.deepEqual(followupsViolations("What changed: fixed the boot race.\n\nfiled-followups: #114\n"), []);
});

test("exit-summary shape: multiple filed issues, comma-space separated", () => {
  assert.deepEqual(followupsViolations("filed-followups: #114, #115, #116\n"), []);
});

test("exit-summary shape: trim-tolerant (markdown-relay safe), still strict on content", () => {
  assert.deepEqual(followupsViolations("- filed-followups: #114\n"), []);
});

test("exit-summary shape: markdown-relayed lines are VALIDATED, not skipped (issue #141)", () => {
  // Valid relayed forms stay valid under every decoration the reply
  // relay actually emits:
  for (const good of [
    "- filed-followups: #114",
    "* filed-followups: #114, #115",
    "> filed-followups: #114",
    "**filed-followups:** #114",
  ]) {
    assert.deepEqual(followupsViolations(`${good}\n`), [], `expected zero violations for: ${good}`);
  }
  // ...and the relayed form is VALIDATED: a placeholder or a malformed
  // list behind a bullet is a violation, not an invisible line.
  for (const bad of [
    "- filed-followups: none",
    "**filed-followups:** none",
    "- filed-followups: 114",
    "- filed-followups: #114 (found during review)",
    "- filed-followups: #114,#115",
  ]) {
    assert.equal(followupsViolations(`${bad}\n`).length, 1, `expected exactly one violation for: ${bad}`);
  }
  // The relayed form counts toward the ONE-line rule too.
  const violations = followupsViolations("filed-followups: #114\n- filed-followups: #115\n");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ONE/);
});

test("exit-summary shape: filed nothing — the line is absent, zero violations", () => {
  assert.deepEqual(followupsViolations("What changed: the diff is complete. No followups observed.\n"), []);
});

test("exit-summary shape violations: padded placeholders are violations, not absences", () => {
  for (const bad of ["filed-followups: none", "filed-followups: N/A", "filed-followups:", "filed-followups: -"]) {
    assert.equal(followupsViolations(`${bad}\n`).length, 1, `expected exactly one violation for: ${bad}`);
  }
});

test("exit-summary shape violations: malformed ref lists", () => {
  for (const bad of [
    "filed-followups: #114,#115", // missing comma-space
    "filed-followups: #114 #115", // missing comma
    "filed-followups: 114", // missing the ref hash
    "filed-followups: #", // empty ref
    "filed-followups: #114, #115 (found during review)", // trailing prose
  ]) {
    assert.equal(followupsViolations(`${bad}\n`).length, 1, `expected exactly one violation for: ${bad}`);
  }
});

test("exit-summary shape violations: TWO filed-followups lines (the contract allows ONE)", () => {
  const violations = followupsViolations("filed-followups: #114\nsome prose\nfiled-followups: #115\n");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /ONE/);
});
