// prose-pins.test.mjs — pins the tolerant prose-matching contract itself
// (issue #270) and the doc→pin map that points doc editors at the tests
// grading their edits.
//
// The class (the PR #268 receipt): contract pins graded doc RULES with
// case-sensitive, sentence-position-anchored regexes, so a legitimate
// editorial reflow — a clause capitalized into its own sentence, a
// rewrapped paragraph, a renumbered checklist — red-lined CI with no
// pointer from the doc back to the pin. Two fixes, both pinned here:
//   1. tests/lib/prose.mjs: foldProse/proseHas anchor pins on the
//      substantive clause — decoration stripped, wraps collapsed, case
//      folded — so a pin fails only when the RULE disappears;
//   2. the contract docs (CONTRIBUTING.md, .agents/README.md) carry a
//      map line naming the pin files and the after-edit test run.
//
// Scope note (surveyed 2026-10-04, the #270 family walk): the other
// contract tests' doc pins are either single-token labels (already
// reflow-tolerant), deliberate word-for-word driver↔doc agreement pins
// (branch-hygiene), verified mutation syntax (relationships), or
// driver-source pins of the stamped task text (decompose — the stamped
// text IS the deliverable). milestone-contract was the one grading pure
// doc prose with sentence-shaped regexes; the map line now covers the
// whole family's discoverability gap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldProse, proseHas } from "./lib/prose.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// --- the tolerance contract -----------------------------------------------

test("issue #270: proseHas is casing-agnostic (mid-sentence vs standalone sentence)", () => {
  // The exact #268 shape pair — same rule, two spellings:
  const midSentence =
    'zero-orphan branch hygiene); the PR itself carries the closing ticket\'s milestone (issue #185 — stamps it)';
  const standalone =
    'zero-orphan branch hygiene). The PR itself carries the closing ticket\'s milestone (issue #185 — stamps it)';
  const clause = "The PR itself carries the closing ticket's milestone (issue #185";
  assert.ok(proseHas(midSentence, clause), "a mid-sentence lowercase clause matches");
  assert.ok(proseHas(standalone, clause), "a standalone capitalized sentence matches");
});

test("issue #270: proseHas is wrap- and decoration-agnostic (markdown reflow)", () => {
  const wrapped =
    "5. **Stamp the chain/sweep milestone** (issue #185): a `found:` ticket\n   that belongs to a chain or sweep carries that chain's milestone —\n   the filer sets it, creating the milestone if absent";
  assert.ok(proseHas(wrapped, "Stamp the chain/sweep milestone (issue #185"), "bold decoration and the (issue #185 wrap do not hide the rule");
  assert.ok(proseHas(wrapped, "creating the milestone if absent"), "a clause split across a line wrap matches");
  assert.equal(foldProse("a `code` **bold** span"), "a code bold span", "foldProse keeps the words, drops only the decoration");
});

test("issue #270: proseHas still bites — the clause is the rule, rewording it away reds the pin", () => {
  const doc = 'The PR itself carries the closing ticket\'s milestone (issue #185 — stamped at ship).';
  const clause = "The PR itself carries the closing ticket's milestone (issue #185";
  assert.ok(!proseHas(doc.replace("milestone", "label"), clause), "substantive reword (milestone→label) reds");
  assert.ok(!proseHas(doc.replace(" (issue #185", " (issue #999"), clause), "wrong issue attribution reds");
  assert.ok(!proseHas("Nothing relevant here.", clause), "absent rule reds");
});

// --- the doc→pin map -------------------------------------------------------

test("issue #270: the contract docs map their sections to the tests that pin them", () => {
  for (const [name, doc] of [
    [".agents/README.md", read(".agents/README.md")],
    ["CONTRIBUTING.md", read("CONTRIBUTING.md")],
  ]) {
    assert.ok(
      proseHas(doc, "rules below are pinned by tests"),
      `${name}: the map says the sections are pinned`,
    );
    assert.ok(
      proseHas(doc, "tests/milestone-contract.test.mjs"),
      `${name}: the map names at least the milestone pin file`,
    );
    assert.ok(
      proseHas(doc, "run node --test tests/*.test.mjs after any edit"),
      `${name}: the map tells the editor which run to make after an edit`,
    );
  }
});
