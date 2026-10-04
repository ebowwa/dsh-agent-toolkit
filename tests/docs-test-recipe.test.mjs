// docs-test-recipe.test.mjs — pins the local test recipe to CI parity.
//
// Regression anchor: issue #301. CLAUDE.md and README.md told agents to
// verify locally with the glob form `node --test tests/*.test.mjs` while
// CI (gates.yml "Unit tests" step) runs BARE `node --test`. Node's bare
// discovery treats every test/ directory as a suite too, so CI ran the
// five plugin smoke suites (plugins/*/test/smoke.mjs) the glob form
// silently skipped: an agent who edited a plugin's smoke suite saw green
// locally while the suite CI grades never executed — the #270 class
// (local runs giving zero warning about what CI grades) on the recipe
// itself. Revert either doc to the glob-form recommendation, or narrow
// the gates step away from bare discovery, and these pins go red.
//
// The pins are anchored on the RULE CLAUSE, not the sentence shape
// (issue #270's reflow lesson): whitespace-insensitive matches, no
// line-layout coupling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docs = {
  "CLAUDE.md": readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8"),
  "README.md": readFileSync(path.join(ROOT, "README.md"), "utf8"),
};

// The recipe's forbidden forms, and the rule clause that must ride with
// every mention: a doc may WARN about a form (that is the fix) but may
// not recommend it. Reflow-tolerant: collapse whitespace, then require
// the negation in the SAME SENTENCE as each occurrence.
const collapse = (s) => s.replace(/\s+/g, " ");
const GLOB_FORM = /node --test tests\/\*\.test\.mjs/g;
const DIR_FORM = /node --test tests\//g;

/** the sentence (collapsed, split on . or ;) containing the occurrence */
const sentenceAt = (flat, idx) => {
  const before = flat.slice(0, idx);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("; "), 0);
  const rest = flat.slice(idx);
  const stop = rest.match(/[.;]/);
  return flat.slice(start, idx + (stop ? stop.index : rest.length));
};

/** every occurrence of re must sit in a negated sentence — a mention
 *  that recommends the form instead fails this. */
const assertOnlyWarnedAgainst = (name, doc, re) => {
  const flat = collapse(doc);
  let m;
  while ((m = re.exec(flat)) !== null) {
    const sentence = sentenceAt(flat, m.index);
    assert.match(
      sentence,
      /\b(do not|don't|never|not)\b/i,
      `${name}: the form \`${m[0]}\` must only appear WARNED AGAINST ` +
        `(issue #301 — the glob form skips the plugin smoke suites CI runs); ` +
        `offending sentence: "${sentence.trim()}"`
    );
  }
};

for (const [name, doc] of Object.entries(docs)) {
  test(`${name}: the local recipe is bare \`node --test\` — CI parity (issue #301)`, () => {
    // the bare invocation, backtick-delimited (the directory-form and
    // glob-form warnings carry their args inside the same backticks, so
    // this matches ONLY the bare recommendation)
    assert.match(
      doc,
      /`node --test`/,
      `${name}: must instruct bare \`node --test\` locally — exactly what the gates.yml "Unit tests" step runs`
    );
    assert.match(
      collapse(doc),
      /exactly what CI runs/i,
      `${name}: the recipe must state the CI-parity rule clause`
    );
  });

  test(`${name}: the glob form is only ever warned against, never recommended`, () => {
    const hits = collapse(doc).match(GLOB_FORM) || [];
    assert.ok(hits.length > 0, `${name}: must warn about the glob form (the #301 hazard)`);
    assertOnlyWarnedAgainst(name, doc, GLOB_FORM);
  });

  test(`${name}: the directory form is only ever warned against, never recommended`, () => {
    const hits = collapse(doc).match(DIR_FORM) || [];
    assert.ok(hits.length > 0, `${name}: must warn about the directory form (the Node 26 hazard)`);
    assertOnlyWarnedAgainst(name, doc, DIR_FORM);
  });

  test(`${name}: the plugin-smoke dep prerequisite rides with the recipe`, () => {
    const flat = collapse(doc);
    assert.match(
      flat,
      /install-plugin-smoke-deps\.mjs/,
      `${name}: the recipe must carry the one-time installer step`
    );
    assert.match(
      flat,
      /reruns are no-ops/,
      `${name}: the installer mention must keep its idempotence clause`
    );
    assert.match(
      flat,
      /plugins\/\*\/test\/smoke\.mjs/i,
      `${name}: must name the suites bare discovery adds over the glob form`
    );
  });
}

test("gates.yml keeps running the suite bare — the CI half of the parity (issue #301)", () => {
  const gates = readFileSync(path.join(ROOT, ".github", "workflows", "gates.yml"), "utf8");
  const step = gates.split(/^ *- name: Unit tests$/m)[1] ?? "";
  assert.ok(step.length > 0, "the 'Unit tests' step must exist in gates.yml");
  assert.match(
    step.split(/^ {6}- name: /m)[0],
    /run: node --test\s*$/m,
    "the gates 'Unit tests' step must stay bare `node --test` — bare discovery " +
      "is what runs the plugin smoke suites; a narrowed form makes CI itself " +
      "skip them (and silently diverges from every doc recipe)"
  );
});

test("the plugin smoke suites bare discovery adds actually exist (fixture honesty)", () => {
  const dir = path.join(ROOT, "plugins");
  const found = [];
  for (const name of readdirSync(dir)) {
    const smoke = path.join(dir, name, "test", "smoke.mjs");
    try {
      readFileSync(smoke);
      found.push(`${name}/test/smoke.mjs`);
    } catch {
      // plugin without a smoke suite — fine
    }
  }
  assert.ok(
    found.length >= 5,
    `expected the five plugin smoke suites the docs name (found: ${found.join(", ")})`
  );
});
