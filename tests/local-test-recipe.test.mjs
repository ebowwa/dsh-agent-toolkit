// local-test-recipe.test.mjs — pins the local test recipe's CI parity
// (issue #301): the docs' quick glob form (`node --test tests/*.test.mjs`)
// skips every `plugins/*/test/smoke.mjs` suite that CI's bare `node --test`
// also runs (bare discovery visits `test/` directories; a shell glob does
// not), so an agent who edits a plugin smoke suite and verifies with the
// quick form sees green while the edited suite never ran. The pin anchors
// on the literal recipe strings (rule clauses, not sentence shape — the
// #270 lesson) and on the glob↔filesystem agreement: the parity glob must
// name real suites, and CI's bare invocation must still be what the parity
// claim is made against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// Expansion of the parity recipe's second glob (plugins under test/smoke.mjs).
const smokeSuites = () => {
  const pluginsDir = path.join(ROOT, "plugins");
  let plugins;
  try {
    plugins = readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return plugins
    .filter((d) => d.isDirectory())
    .map((d) => path.join("plugins", d.name, "test", "smoke.mjs"))
    .filter((rel) => existsSync(path.join(ROOT, rel)))
    .sort();
};

test("CI grades with bare discovery — the parity claim's referent (gates.yml)", () => {
  const gates = read(".github/workflows/gates.yml");
  // The "Unit tests" step runs bare `node --test` (line 103 at pin time).
  // If CI ever moves to a narrower invocation, the docs' divergence story
  // changes with it — red here so the recipes get re-derived, not silently
  // wrong.
  assert.match(gates, /name: Unit tests[\s\S]*?run: node --test\n/, "the Unit tests step must stay bare `node --test`");
});

test("the parity glob names real suites (glob↔tree agreement)", () => {
  const suites = smokeSuites();
  assert.ok(
    suites.length >= 1,
    "plugins/*/test/smoke.mjs matches nothing — the parity recipe went stale",
  );
});

test("CLAUDE.md names the skip at the recipe bullet and carries the parity form", () => {
  const doc = read("CLAUDE.md");
  // the divergence is named at the same bullet that teaches the quick form
  assert.match(doc, /The glob form also SKIPS the plugin/, "the skip must be named where the quick form is taught");
  // the parity recipe, verbatim — the exact set CI grades
  assert.match(doc, /node --test tests\/\*\.test\.mjs plugins\/\*\/test\/smoke\.mjs/, "the parity recipe must appear verbatim");
  // the pre-existing directory-form hazard warning stays intact
  assert.match(doc, /Do NOT use the directory form/, "the directory-form warning is unchanged");
});

test("README's testing section carries the same parity recipe", () => {
  const doc = read("README.md");
  assert.match(doc, /node --test tests\/\*\.test\.mjs plugins\/\*\/test\/smoke\.mjs/, "the parity recipe must appear verbatim");
  assert.match(doc, /skips the plugin smoke suites/, "the skip is named next to the quick form");
});
