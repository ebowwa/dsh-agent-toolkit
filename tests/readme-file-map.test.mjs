// readme-file-map.test.mjs — pins CLAUDE.md's "the file map: every
// workflow, script, plugin, and config file with its purpose" promise
// (issues #405 and #417). The #405 half: the map must carry a row for
// EVERY file under scripts/ (the gap class: scripts shipped without
// their README row — install-worker.sh, the worker deployment
// entrypoint, sat undiscoverable from the map; agents grepped README
// first and concluded the machinery lived elsewhere). The #417 half
// extends the same receipt loop to the OTHER promised classes —
// .github/workflows/* and config/* — and hardens it against the
// prose-only false-green: a basename mentioned anywhere in README
// (e.g. inside another row's purpose text, or a section like
// "Prior-session search") passes a substring loop while the map still
// lacks its purpose row. That exact case shipped twice: config/
// lane-plugins.json (prose mention, no row) and .github/workflows/
// gates.yml (mentioned inside other rows' purpose text, no row). So
// the row-based leg requires each walked basename to sit in the FILE
// cell of a table row, not merely anywhere in the page. Anchored on
// filesystem↔doc agreement (rule clauses, not sentence shape — the
// #270 lesson: a prose reflow can't false-green it, and a new file
// can't ship unmapped).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// The classes CLAUDE.md's promise names and the fence grades.
const MAP_CLASSES = [
  [".github/workflows", "workflows"],
  ["scripts", "scripts"],
  ["config", "configs"],
];

const fileBasenames = (dir) =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();

// The FILE cell (first column) of every markdown table row in README —
// the "map row" contract: path first, purpose second.
const tableFileCells = () =>
  read("README.md")
    .split("\n")
    .filter((l) => l.trimStart().startsWith("|"))
    .map((l) => l.split("|")[1] ?? "");

test("the file map carries a row for every script (the #405 receipt loop)", () => {
  const readme = read("README.md");
  const missing = fileBasenames("scripts").filter((n) => !readme.includes(n));
  assert.deepEqual(
    missing,
    [],
    "scripts/ files with no README.md map row (CLAUDE.md promises 'every script'): " +
      missing.join(", "),
  );
});

test("the #405 loop over the other promised classes: workflows + configs are all mentioned (issue #417)", () => {
  const readme = read("README.md");
  for (const [dir, label] of MAP_CLASSES) {
    const missing = fileBasenames(dir).filter((n) => !readme.includes(n));
    assert.deepEqual(
      missing,
      [],
      `${label} with no README.md mention (CLAUDE.md promises the map covers every workflow and config file): ` +
        missing.join(", "),
    );
  }
});

test("every mapped file sits on a TABLE ROW, not just prose (the #417 promotion fence)", () => {
  // The lane-plugins.json / gates.yml class: a substring loop passes a
  // file that only appears in README prose while the map still lacks
  // its purpose row. The FILE cell is what makes it a map row.
  const cells = tableFileCells();
  for (const [dir, label] of MAP_CLASSES) {
    const missing = fileBasenames(dir).filter(
      (n) => !cells.some((c) => c.includes(n)),
    );
    assert.deepEqual(
      missing,
      [],
      `${label} present in README prose only — no file-map row with a purpose (issue #417): ` +
        missing.join(", "),
    );
  }
});

test("CLAUDE.md still makes the promise this fence enforces", () => {
  // The referent: if the claim ever softens, this pin's contract changes
  // with it — red here so the fence and the promise cannot drift apart.
  const doc = read("CLAUDE.md");
  assert.match(
    doc,
    /the file map: every workflow, script, plugin, and config/,
    "CLAUDE.md's file-map promise must keep naming every script",
  );
});
