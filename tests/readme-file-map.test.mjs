// readme-file-map.test.mjs — pins CLAUDE.md's "every script" promise
// (issue #405): the file map must carry a row for EVERY file under
// scripts/. The gap class: scripts shipped without their README row
// (install-worker.sh — the worker deployment entrypoint — sat
// undiscoverable from the map; agents grepped README first and concluded
// the machinery lived elsewhere). The pin is the receipt loop from the
// ticket, run against the live tree: any future script that lands
// without a map row reds HERE instead of rotting silently. Anchored on
// filesystem↔doc agreement (rule clauses, not sentence shape — the #270
// lesson: a prose reflow can't false-green it, and a new script can't
// ship unmapped).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const scriptBasenames = () =>
  readdirSync(path.join(ROOT, "scripts"), { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort();

test("the file map carries a row for every script (the #405 receipt loop)", () => {
  const readme = read("README.md");
  const missing = scriptBasenames().filter((n) => !readme.includes(n));
  assert.deepEqual(
    missing,
    [],
    "scripts/ files with no README.md map row (CLAUDE.md promises 'every script'): " +
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
