// local-test-recipe.test.mjs — the local test recipe runs what CI runs
// (issue #301).
//
// Regression anchor: CLAUDE.md's gates bullet told agents to verify
// locally with the glob form `node --test tests/*.test.mjs` while CI's
// gates step runs BARE `node --test` — and Node's bare discovery treats
// every `test/` directory as a suite too, so CI additionally ran the
// `plugins/*/test/smoke.mjs` suites the glob form silently skipped
// (receipts at 3da299e: bare 446 tests vs glob 441, no warning either
// way). An agent who edits a plugin smoke, verifies with the documented
// local form, and pushes sees green while the edited suite never ran —
// the #270 local-vs-CI divergence class. These pins keep every living
// recipe honest: bare is the local form, the skip is named wherever the
// glob form is mentioned, and CI's step stays the bare discovery the
// docs promise. HYGIENE.md's mentions are dated audit receipts (the
// 190-test era) and are deliberately not pinned — history, not recipe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claude = readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
const gates = readFileSync(path.join(ROOT, ".github", "workflows", "gates.yml"), "utf8");

// Reflow tolerance: markdown prose may wrap anywhere — compare against a
// whitespace-collapsed copy so a rewrap cannot silently unpin the contract.
const norm = (s) => s.replace(/\s+/g, " ");

test("the plugin smoke suites exist outside tests/ — the skip the docs name is real", () => {
  const pluginsDir = path.join(ROOT, "plugins");
  const smokes = readdirSync(pluginsDir).flatMap((p) => {
    const d = path.join(pluginsDir, p, "test");
    try {
      return readdirSync(d).filter((f) => f.endsWith(".mjs")).map((f) => path.join(d, f));
    } catch {
      return []; // plugin without a test/ dir
    }
  });
  assert.ok(smokes.length >= 1,
    "expected plugins/*/test/ suites to exist — they are the CI-vs-glob delta this contract is about");
  for (const s of smokes) {
    assert.ok(!s.startsWith(path.join(ROOT, "tests") + path.sep),
      `plugin smoke ${s} lives outside tests/ — only bare discovery, not the tests/ glob, runs it`);
  }
});

test("CI's Unit tests step stays bare node --test (the discovery the docs promise)", () => {
  const step = gates.split(/^ *- name: Unit tests$/m)[1]?.split(/^ {6}- name: /m)[0] ?? "";
  assert.match(step, /run: node --test\s*$/m,
    "the gates step must run bare `node --test` — the docs' 'same as CI' promise hangs on it");
});

test("CLAUDE.md prescribes bare node --test locally and names the glob form's skip (#301)", () => {
  const bullet = claude.split(/^ {2}3\. Unit tests:/m)[1]?.split(/\n- /m)[0] ?? "";
  const n = norm(bullet);
  assert.ok(bullet, "the '3. Unit tests:' gates bullet must exist in CLAUDE.md");
  assert.ok(n.includes("node --test` — bare"),
    "the bullet must prescribe the bare `node --test` form");
  assert.ok(n.includes("silently skips"),
    "the bullet must name that the glob form silently skips the plugin smokes");
  assert.ok(!n.includes("locally use the glob form"),
    "the bullet must not prescribe the glob form for local verification (issue #301)");
});

test("README's Testing section matches: bare form, skip named, no glob prescription (#301)", () => {
  const section = readme.split(/^## Testing\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const n = norm(section);
  assert.ok(section, "the '## Testing' section must exist in README.md");
  assert.ok(/```bash\s*node --test\s*```/.test(norm(section)),
    "the section's example invocation must be bare `node --test`");
  assert.ok(n.includes("silently skips"),
    "the section must name that the glob form silently skips the plugin smokes");
  assert.ok(!n.includes("Run the suite with the glob form"),
    "the section must not prescribe the glob form (issue #301)");
});
