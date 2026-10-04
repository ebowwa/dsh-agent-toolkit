// fleet-manifest-drift.test.mjs — contract pins for the standing registry's
// alignment fence (issue #397). config/fleet-manifest.md is the standing
// fleet context injected into every dispatched agent's task prompt and is
// authoritative over the inline summary the driver carries — but it rotted
// for 8 days (three nodes on two air machines missing from the table while
// air16-native-open carried ~110 of the day's claim rows), because nothing
// diffed it against the live tower registry.
//
// Two pin families:
//   1. CONTENT — the manifest table carries the air machines the tower
//      added, their machine homes, and a non-stale Last-aligned date. The
//      date pin is deliberately exact: the point is that the manifest date
//      and this pin move together — a future alignment that bumps one
//      without the other goes red here, so the copy cannot silently rot
//      again (the acceptance "stale copy fails loud", test-side mirror).
//   2. MECHANICS — parseRegistryTable / towerNodesFromJson / diffRegistries
//      behave on fixtures (missing node, phantom row, OS mismatch), and
//      the CLI guard is the symlink-safe realpath form, NOT the naive
//      import.meta.url comparison (the #302/#324 false-green class).
//
// No network: the tower fetch itself is fenced by CI
// (.github/workflows/fleet-manifest-drift.yml) — unit tests never wire a
// live-registry leg (the box-load flake class the repo is actively
// retiring, issues #389/#398).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRegistryTable,
  towerNodesFromJson,
  diffRegistries,
} from "../scripts/fleet-manifest-drift.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const MANIFEST = read("config/fleet-manifest.md");
const DRIFT_SRC = read("scripts/fleet-manifest-drift.mjs");
const DRIFT_WF = ".github/workflows/fleet-manifest-drift.yml";

// --- 1. content pins: the air machines are IN the standing registry ------

test("manifest registry: the three air nodes the tower added are present (issue #397)", () => {
  const table = parseRegistryTable(MANIFEST);
  for (const id of ["air16-native-open", "air8-native-open", "m1-8gb-air-open"]) {
    const row = table.get(id);
    assert.ok(row, `node ${id} missing from the registry table`);
    assert.equal(row.os, "macOS", `${id} OS cell must say macOS (tower machine os)`);
    assert.ok(row.lanes.includes("open"), `${id} serves the open lane`);
  }
  // the alignment did not lose the incumbent rows
  for (const id of ["mini-L1", "mini-L2", "mini-L3", "mini-L4", "seed-L3"]) {
    assert.ok(table.has(id), `incumbent node ${id} lost from the registry table`);
  }
  assert.equal(table.get("seed-L3").os, "Linux", "seed-L3 stays the one Linux node");
});

test("manifest registry: the two air machine homes are named for placement", () => {
  assert.match(MANIFEST, /air16-native-open` on macos-m1-16gb-air\.local/);
  assert.match(MANIFEST, /`air8-native-open` \+\n`m1-8gb-air-open`/);
  assert.match(MANIFEST, /macos-m1-8gb-air\.local/);
  // pull-only is a placement input: no ssh route from seed, heartbeat truth
  assert.match(MANIFEST, /pull-only \(no ssh route from seed; heartbeat\ntruth\)/);
  // the MLX trait rides the m1-8gb-air row (trait-class hardware note)
  assert.match(MANIFEST, /m1-8gb-air-open \| macOS \| open \| MacBook Air m1 8gb — MLX-capable/);
});

test("manifest: Last aligned date is the #397 alignment, not the stale one", () => {
  // the stale receipt date (2026-09-26) may still appear as the ghost-seat
  // HISTORY note — only the Last-aligned line must not carry it
  assert.doesNotMatch(MANIFEST, /receipts: 2026-09-26/);
  assert.match(MANIFEST, /receipts: 2026-10-04/);
});

test("drift fence is wired: script + CI workflow reference each other", () => {
  assert.ok(existsSync(path.join(ROOT, "scripts", "fleet-manifest-drift.mjs")));
  const wf = read(DRIFT_WF);
  assert.match(wf, /node scripts\/fleet-manifest-drift\.mjs/);
  // PR-touch on the fence's own files AND a schedule (tower-side drift is
  // the case a repo-push trigger can never see)
  assert.match(wf, /pull_request:/);
  assert.match(wf, /config\/fleet-manifest\.md/);
  assert.match(wf, /cron:/);
  // the manifest points back at its fence (discoverability from either side)
  assert.match(MANIFEST, /scripts\/fleet-manifest-drift\.mjs/);
  assert.match(MANIFEST, /fleet-manifest-drift\.yml/);
});

// --- 2. mechanics: the comparator catches the drift classes ---------------

test("parseRegistryTable: header, separator, and rows parse with trimmed cells", () => {
  const md = [
    "## Node registry",
    "",
    "| Nodes | OS | Lanes served | Notes |",
    "|---|---|---|---|",
    "| mini-L1 | macOS | mac (native toolchain) | mac-native parts MUST land here |",
    "| seed-L3 | Linux | linux (cheap cells) | the only Linux node today |",
    "",
    "prose paragraph, no table line",
  ].join("\n");
  const table = parseRegistryTable(md);
  assert.equal(table.size, 2);
  assert.equal(table.get("mini-L1").os, "macOS");
  assert.equal(table.get("seed-L3").lanes, "linux (cheap cells)");
});

test("towerNodesFromJson: machines flatten to nodes with machine-attributed OS", () => {
  const registry = {
    machines: {
      "box-a.local": { os: "macos", nodes: [{ id: "air16-native-open", lane: "open", registryNote: "pull-only" }] },
      "box-b": { os: "linux", nodes: [{ id: "seed-L9", lane: "l3" }] },
    },
  };
  const tower = towerNodesFromJson(registry);
  assert.equal(tower.size, 2);
  assert.equal(tower.get("air16-native-open").os, "macOS");
  assert.equal(tower.get("air16-native-open").machine, "box-a.local");
  assert.equal(tower.get("seed-L9").os, "Linux");
});

test("diffRegistries: aligned registries carry zero findings", () => {
  const tower = new Map([
    ["mini-L4", { os: "macOS", lane: "l4", note: "", machine: "m1mini16gb.local" }],
  ]);
  const manifest = new Map([
    ["mini-L4", { os: "macOS", lanes: "open (default)", notes: "" }],
  ]);
  assert.deepEqual(diffRegistries(manifest, tower), []);
});

test("diffRegistries: a tower node missing from the manifest fails loud", () => {
  const tower = new Map([
    ["mini-L4", { os: "macOS", lane: "l4", note: "", machine: "m1mini16gb.local" }],
    ["air16-native-open", { os: "macOS", lane: "open", note: "pull-only", machine: "macos-m1-16gb-air.local" }],
  ]);
  const manifest = new Map([
    ["mini-L4", { os: "macOS", lanes: "open (default)", notes: "" }],
  ]);
  const findings = diffRegistries(manifest, tower);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^missing-from-manifest: air16-native-open/);
  assert.match(findings[0], /macos-m1-16gb-air\.local/);
});

test("diffRegistries: a manifest row the tower no longer lists is flagged", () => {
  const tower = new Map([
    ["mini-L4", { os: "macOS", lane: "l4", note: "", machine: "m1mini16gb.local" }],
  ]);
  const manifest = new Map([
    ["mini-L4", { os: "macOS", lanes: "open (default)", notes: "" }],
    ["ghost-node", { os: "macOS", lanes: "open", notes: "retired box" }],
  ]);
  const findings = diffRegistries(manifest, tower);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^absent-from-tower: ghost-node/);
});

test("diffRegistries: an OS-class mismatch on a shared node is a placement hazard", () => {
  const tower = new Map([
    ["mini-L3", { os: "macOS", lane: "l3", note: "", machine: "m1mini16gb.local" }],
  ]);
  const manifest = new Map([
    ["mini-L3", { os: "Linux", lanes: "open (cheap cells)", notes: "mislabelled" }],
  ]);
  const findings = diffRegistries(manifest, tower);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^os-mismatch: mini-L3 \(manifest says Linux, tower says macOS\)/);
});

// --- 3. the CLI guard is the symlink-safe form -----------------------------

test("drift script: the main guard is realpath-safe, not the #302/#324 naive class", () => {
  assert.match(DRIFT_SRC, /realpathSync\(argv1\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.doesNotMatch(DRIFT_SRC, /import\.meta\.url === `file:\/\//);
  assert.doesNotMatch(DRIFT_SRC, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});
