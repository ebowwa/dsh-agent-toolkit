// readme-file-map.test.mjs — pins CLAUDE.md's file-map promise
// (issues #405 + #417): the map must carry a row for EVERY file under
// scripts/, .github/workflows/, and config/. The gap class: files
// shipped without their README row (install-worker.sh — the worker
// deployment entrypoint — sat undiscoverable from the map; the three
// decoupled/gates/self-scaling workflows and fleet-priority.md — the
// authoritative lane-priority order — followed). The pins are the
// receipt loops from the tickets, run against the live tree: any future
// file that lands without a map row reds HERE instead of rotting
// silently. Anchored on filesystem↔doc agreement (rule clauses, not
// sentence shape — the #270 lesson: a prose reflow can't false-green
// it, and a new file can't ship unmapped). #417 adds the ROW-level
// fence: a prose mention (config/lane-plugins.json rode README prose
// with no map row for months) is not a row — the basename must sit in
// a table row's File cell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const basenames = (dir) =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();

// config/* like the #417 receipt loop: top-level files AND dirs (the
// system-prompts/ dir has its own row).
const configTopNames = () =>
  readdirSync(path.join(ROOT, "config"), { withFileTypes: true })
    .map((d) => d.name)
    .sort();

// plugins/* like the #417 receipt loop, at DIRECTORY granularity (issue
// #457): the README maps plugins one purpose row per plugin DIR (50 files
// under plugins/ carry no individual rows, and shouldn't — a per-file
// leg would demand a row for PR_BODY.md). Every top-level dir basename
// must sit in a File cell.
const pluginDirs = () =>
  readdirSync(path.join(ROOT, "plugins"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

// The File column (first cell) of every README table row — this is what
// "has a row in the file map" means; a name riding prose inside another
// row's purpose cell does not count.
const fileMapFileCells = () =>
  read("README.md")
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => (l.split("|")[1] ?? "").trim())
    .filter((c) => c.length > 0);

const hasRow = (name, cells) => cells.some((c) => c.includes(name));

test("the file map carries a row for every script (the #405 receipt loop)", () => {
  const readme = read("README.md");
  const missing = basenames("scripts").filter((n) => !readme.includes(n));
  assert.deepEqual(
    missing,
    [],
    "scripts/ files with no README.md map row (CLAUDE.md promises 'every script'): " +
      missing.join(", "),
  );
});

test("the file map names every workflow (the #417 receipt loop)", () => {
  const readme = read("README.md");
  const missing = basenames(".github/workflows").filter(
    (n) => !readme.includes(n),
  );
  assert.deepEqual(
    missing,
    [],
    ".github/workflows/ files absent from README.md (CLAUDE.md promises 'every workflow'): " +
      missing.join(", "),
  );
});

test("the file map names every config entry (the #417 receipt loop)", () => {
  const readme = read("README.md");
  const missing = configTopNames().filter((n) => !readme.includes(n));
  assert.deepEqual(
    missing,
    [],
    "config/ entries absent from README.md (CLAUDE.md promises 'every config file'): " +
      missing.join(", "),
  );
});

test("a prose mention is not a row — every workflow, script, config entry, and plugin dir sits in a File cell (the lane-plugins.json promotion, #417)", () => {
  const cells = fileMapFileCells();
  const missing = [
    ...basenames(".github/workflows").map((n) => [".github/workflows", n]),
    ...basenames("scripts").map((n) => ["scripts", n]),
    ...configTopNames().map((n) => ["config", n]),
    ...pluginDirs().map((n) => [`plugins/${n}/`, n]),
  ]
    .filter(([, n]) => !hasRow(n, cells))
    .map(([d, n]) => `${d}/`);
  assert.deepEqual(
    missing,
    [],
    "files named somewhere in README prose but missing a file-map row of their own (the #417 lane-plugins.json class — a purpose cell mentioning a sibling is not a row; the #457 dir-leg — a plugin dir basename must sit in a File cell, a row's purpose cell naming it does not count): " +
      missing.join(", "),
  );
});

test("every plugin dir basename sits in a README File cell (the #457 dir-leg)", () => {
  // The #417 row-leg checks basename-in-FILE-cell per FILE; plugins/ is
  // mapped at DIRECTORY granularity (one purpose row per plugin dir), so
  // the dir-leg checks the top-level dir basenames — not the ~50 files
  // beneath them (a per-file leg would demand rows for
  // plugins/dsh-flight-recorder/PR_BODY.md, the wrong shape). Red when a
  // plugin DIR loses its row, exactly like the other classes.
  const cells = fileMapFileCells();
  const missing = pluginDirs().filter((n) => !hasRow(n, cells));
  assert.deepEqual(
    missing,
    [],
    "plugins/* dirs with no README.md file-map row (CLAUDE.md promises 'every plugin'; issue #457 — the plugins class was the one promised class the #417 fence never fenced): " +
      missing.join(", "),
  );
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
