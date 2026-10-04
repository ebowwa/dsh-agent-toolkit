// fleet-manifest-drift.test.mjs — contract pins for the standing-registry
// drift fence (issue #397): the shipped node table carries every node the
// 2026-10-04 tower-registry alignment counts, the parser/differ hold their
// invariants, and the CLI fails loud in every direction — aligned / drift /
// unreadable input / bad usage — including through a symlinked invocation
// (the #302/#324 guard class this script's isMain must survive).
//
// Division of labor with the live fence: THIS file pins presence (a node
// row cannot silently disappear from the shipped manifest); ADDITIONS are
// the drift script's job (node --test has no network — a test pinning the
// registry's live set would rot exactly like the manifest did).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffIds, parseNodeTable, registryNodeIds } from "../scripts/fleet-manifest-drift.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "fleet-manifest-drift.mjs");
const MANIFEST = readFileSync(path.join(ROOT, "config", "fleet-manifest.md"), "utf8");

// The alignment set this pin freezes: the five historical homes + the two
// air machines the 2026-10-04 sync added (issue #397's acceptance). A node
// leaves this list only through a deliberate manifest edit + this test.
const ALIGNED_IDS = [
  "mini-L1", "mini-L2", "mini-L3", "mini-L4", // the m1mini16gb lane homes
  "air16-native-open", "air8-native-open", // the air machines (#397)
  "m1-8gb-air-open", // the MLX-trait node on the 8gb air (#397)
  "seed-L3", // the only Linux node
];

// --- 1. the shipped manifest is the sync pin ---------------------------------

test("shipped manifest: node table parses and carries the full 2026-10-04 alignment", () => {
  const rows = parseNodeTable(MANIFEST);
  const ids = rows.map(r => r.id);
  for (const id of ALIGNED_IDS) {
    assert.ok(ids.includes(id), `node ${id} missing from config/fleet-manifest.md`);
  }
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  // OS column is the placement law's input — pin it for the nodes the law
  // names hardest: the only Linux target, and the new air cells (macOS —
  // an open-lane name like "air16-native-open" must never read as Linux)
  assert.equal(byId["seed-L3"].os, "Linux");
  assert.equal(byId["air16-native-open"].os, "macOS");
  assert.equal(byId["air8-native-open"].os, "macOS");
  assert.equal(byId["m1-8gb-air-open"].os, "macOS");
  // the MLX trait rides the table — the note the placement law consults
  // for trait-beats-language routing
  assert.match(byId["m1-8gb-air-open"].note, /MLX/i);
});

test("shipped manifest: the alignment date and the fence are cited in the header", () => {
  assert.match(MANIFEST, /Last aligned[\s\S]*2026-10-04/);
  assert.match(MANIFEST, /fleet-manifest-drift\.mjs/);
});

// --- 2. parser + differ invariants (inline fixtures) -------------------------

test("parseNodeTable: skips header/separator/prose, joins pipe-bearing notes", () => {
  const md = [
    "# Fleet manifest",
    "",
    "prose before the section is ignored",
    "",
    "## Node registry",
    "",
    "| Nodes | OS | Lanes served | Notes |",
    "|---|---|---|---|",
    "| n1 | macOS | open | plain note |",
    "| n2 | Linux | linux | a | b | pipe |", // pipes in the note column
    "",
    "prose after the table ends the scan",
    "| n3 | macOS | open | must not be picked up |",
  ].join("\n");
  const rows = parseNodeTable(md);
  assert.deepEqual(rows.map(r => r.id), ["n1", "n2"]);
  assert.equal(rows[1].note, "a|b|pipe"); // cells beyond column 3 rejoin with |
});

test("parseNodeTable: fails closed on a missing section, duplicate ids, or no rows", () => {
  assert.throws(() => parseNodeTable("# no section here\n"), /no '## Node registry' section/);
  assert.throws(
    () => parseNodeTable("## Node registry\n\n| Nodes | OS | Lanes served | Notes |\n|---|---|---|---|\n| n1 | a | b | c |\n| n1 | a | b | c |\n"),
    /duplicate node id.*n1/,
  );
  assert.throws(
    () => parseNodeTable("## Node registry\n\n| Nodes | OS | Lanes served | Notes |\n|---|---|---|---|\n"),
    /no rows/,
  );
});

test("registryNodeIds: collects ids across machines; fails closed on bad shape", () => {
  const registry = {
    machines: {
      "mini.local": { os: "macos", nodes: [{ id: "mini-L1", lane: "l1" }, { id: "mini-L4", lane: "l4" }] },
      "seed": { os: "linux", nodes: [{ id: "seed-L3", lane: "l3" }] },
    },
  };
  assert.deepEqual(registryNodeIds(registry), ["mini-L1", "mini-L4", "seed-L3"]);
  assert.throws(() => registryNodeIds({}), /no machines object/);
  assert.throws(() => registryNodeIds({ machines: { m: {} } }), /no nodes array/);
  assert.throws(() => registryNodeIds({ machines: { m: { nodes: [{}] } } }), /without an id/);
  assert.throws(() => registryNodeIds({ machines: { m: { nodes: [] } } }), /no nodes/);
});

test("diffIds: empty on both sides when aligned; each direction reports its own set", () => {
  const aligned = diffIds(["a", "b"], ["b", "a"]);
  assert.deepEqual(aligned.missingFromManifest, []);
  assert.deepEqual(aligned.notInRegistry, []);
  const drift = diffIds(["a", "stale-node"], ["a", "b", "new-node"]);
  assert.deepEqual(drift.missingFromManifest, ["b", "new-node"]);
  assert.deepEqual(drift.notInRegistry, ["stale-node"]);
});

// --- 3. the CLI, end to end (per-run mktemp staging — the #346 fence) --------

// Every fixture registry is written fresh into a per-run tmpdir; no fixed
// /tmp names anywhere in this suite (the sibling-collision class).
const registryFixture = ids => JSON.stringify({
  machines: Object.fromEntries(
    ids.map((id, i) => [`machine-${i}`, { os: "macos", nodes: [{ id, lane: "open" }] }]),
  ),
});

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: "utf8",
  timeout: 30_000,
});

const writeFixture = (dir, name, text) => {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
};

test("CLI: aligned registry exits 0 with the aligned line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fmd-aligned-"));
  try {
    const reg = writeFixture(dir, "fleet.manifest.json", registryFixture(ALIGNED_IDS));
    const res = run(["--registry", reg]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /aligned — 8 nodes in both/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: drift exits 1 and names both directions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fmd-drift-"));
  try {
    const ids = ALIGNED_IDS.filter(id => id !== "air16-native-open").concat("ghost-node");
    const reg = writeFixture(dir, "fleet.manifest.json", registryFixture(ids));
    const res = run(["--registry", reg]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /DRIFT/);
    // ghost-node rides the registry fixture but not the manifest; the
    // removed air16 rides the manifest but not the fixture — one line each
    assert.match(res.stderr, /MISSING from the manifest table: ghost-node/);
    assert.match(res.stderr, /NOT in the tower registry: air16-native-open/);
    assert.doesNotMatch(res.stdout, /aligned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unreadable registry, bad JSON, and bad usage all exit 2 — never a silent green", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fmd-red-"));
  try {
    const missing = run(["--registry", path.join(dir, "nope.json")]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /registry file not found/);
    const badJson = run(["--registry", writeFixture(dir, "bad.json", "{not json")]);
    assert.equal(badJson.status, 2);
    assert.match(badJson.stderr, /unparseable/);
    const badUsage = run(["--wat"]);
    assert.equal(badUsage.status, 2);
    assert.match(badUsage.stderr, /unknown or incomplete argument/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a symlinked invocation still runs (the #302/#324 guard class)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fmd-link-"));
  try {
    const reg = writeFixture(dir, "fleet.manifest.json", registryFixture(ALIGNED_IDS));
    const link = path.join(dir, "fmd-link.mjs");
    symlinkSync(SCRIPT, link);
    // on macOS tmpdir() sits behind /var → /private/var, so argv[1] and
    // import.meta.url already disagree by realpath; the guard must survive
    const res = spawnSync(process.execPath, [link, "--registry", reg], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /aligned — 8 nodes/); // main() RAN, not skipped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
