// readme-file-map.test.mjs — pins CLAUDE.md's file-map promise
// (issues #405 + #417): the map must carry a row for EVERY file under
// scripts/, .github/workflows/, and config/. The gap class: files
// shipped without their README row (install-worker.sh — the worker
// deployment entrypoint — sat undiscoverable from the map; the three
// decoupled/gates/self-scaling workflows and fleet-priority.md — the
// authoritative lane-priority order — followed). The pins are the
// receipt loops from the tickets, run against the TRACKED tree (#674: an
// untracked, gitignored artifact in the checkout is not a repo file and
// must not be enumerable here): any future file that lands without a map
// row reds HERE instead of rotting silently. Anchored on
// filesystem↔doc agreement (rule clauses, not
// sentence shape — the #270 lesson: a prose reflow can't false-green
// it, and a new file can't ship unmapped). #417 adds the ROW-level
// fence: a prose mention (config/lane-plugins.json rode README prose
// with no map row for months) is not a row — the basename must sit in
// a table row's File cell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// Enumerate the TRACKED tree, not the working tree (issue #674). Every
// leg below asserts one claim — "this file is in the repo" — and an
// untracked, gitignored artifact sitting in the checkout is not in the
// repo, so it must not be enumerable here. The defect that forced this
// (#674): `scripts/harness-drift.sh` writes its deploy record,
// `.dsh/HARNESS_DEPLOYED_SHA` (gitignored runtime state) at the checkout root, not
// wrapper — on every box AND inside the CI checkout — so the
// working-tree walk turned that artifact into a red repo contract: the
// suite was 6/6 green with no stamp on disk and red with it, which is
// exactly the shape main's post-merge `gates` run 40060568019 graded (1
// fail, this file). `git ls-files` reads the INDEX, so a newly added
// script still has to carry its row once it is staged, and the suite
// already requires git (see the `check-ignore` pin in
// tests/harness-drift.test.mjs) — this adds no new environment
// requirement, it stops the fence from reading local runtime state as
// repo content.
const trackedRel = (dir) =>
  execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--", dir], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((p) => p.length > 0)
    .map((p) => (p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p))
    .filter((rel) => rel.length > 0 && rel !== dir);

// Files tracked DIRECTLY under dir (one path component), by basename.
const basenames = (dir) =>
  trackedRel(dir)
    .filter((rel) => !rel.includes("/"))
    .sort();

// config/* like the #417 receipt loop: top-level files AND dirs (the
// system-prompts/ dir has its own row).
const configTopNames = () =>
  [...new Set(trackedRel("config").map((rel) => rel.split("/")[0]))].sort();

// plugins/* like the #417 receipt loop, at DIRECTORY granularity (issue
// #457): the README maps plugins one purpose row per plugin DIR (50 files
// under plugins/ carry no individual rows, and shouldn't — a per-file
// leg would demand a row for PR_BODY.md). Every top-level dir basename
// must sit in a File cell.
const pluginDirs = () =>
  [
    ...new Set(
      trackedRel("plugins")
        .filter((rel) => rel.includes("/"))
        .map((rel) => rel.split("/")[0]),
    ),
  ].sort();

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

test("the walk enumerates the TRACKED tree, not the working tree (the #674 lesson)", () => {
  // #674 was invisible unless a gitignored artifact happened to sit in the
  // checkout — 6/6 green on a box with no stamp, red on main's post-merge
  // gates the moment harness-drift.sh stamped one — so pin the SOURCE of
  // the enumeration, not only its output: `git ls-files` is what makes "is
  // this in the repo" the question this fence asks, and a working-tree walk
  // silently re-arms the ticket with no local symptom. The negative token
  // is split so this pin's own source cannot satisfy it.
  const src = read("tests/readme-file-map.test.mjs");
  assert.match(
    src,
    /"ls-files"/,
    "the file map must enumerate the tracked tree (git ls-files), not the working tree — issue #674",
  );
  assert.ok(
    !src.includes("readdir" + "Sync"),
    "a working-tree walk reads gitignored runtime state as repo content (issue #674): enumerate git ls-files instead",
  );
});
