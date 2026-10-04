// fleet-manifest-drift.test.mjs — tests for scripts/fleet-manifest-drift.mjs.
//
// Regression anchor: issue #397 (2026-10-04). config/fleet-manifest.md is
// injected into every dispatched task as the standing fleet context, yet it
// rotted 8 days behind the tower registry — air16-native-open minted ~110 of
// the day's claim rows while the manifest named none of the air nodes, and
// "owner-edit it when the pool changes" had no check backing it. These pins
// fail without the fix: revert the manifest rows (test 1 goes red), delete
// the fence wiring (tests 2-6 lose their verdicts), or reintroduce a
// symlink-blind entry guard (test 7 false-greens through the link).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(ROOT, "scripts", "fleet-manifest-drift.mjs");
const SHIPPED_MANIFEST = readFileSync(path.join(ROOT, "config", "fleet-manifest.md"), "utf8");

// The live tower registry's node roster as of the #397 alignment (receipts in
// the issue): five mini/seed nodes + the three air nodes on two pull-only
// MacBook Air machines.
const REGISTRY_IDS = [
  "mini-L2", "mini-L1", "mini-L4", "mini-L3", "seed-L3",
  "air16-native-open", "air8-native-open", "m1-8gb-air-open",
];

const registryFixture = ids => ({
  $schema: "./fleet.manifest.schema.md",
  machines: {
    "m1mini16gb.local": {
      os: "macos",
      nodes: ["mini-L2", "mini-L1", "mini-L4", "mini-L3"].filter(ids.includes.bind(ids))
        .map(id => ({ id, lane: "l" + id.slice(-1), registryNote: "mac mini" })),
    },
    "seed-node-prod": {
      os: "linux",
      nodes: ids.includes("seed-L3") ? [{ id: "seed-L3", lane: "l3", registryNote: "seed box (Linux)" }] : [],
    },
    "macos-m1-16gb-air.local": {
      os: "macos",
      nodes: ids.includes("air16-native-open")
        ? [{ id: "air16-native-open", lane: "open", registryNote: "MacBook Air m1 16gb, pull-only" }] : [],
    },
    "macos-m1-8gb-air.local": {
      os: "macos",
      nodes: ["air8-native-open", "m1-8gb-air-open"].filter(ids.includes.bind(ids))
        .map(id => ({ id, lane: "open", registryNote: "MacBook Air m1 8gb" })),
    },
  },
});

/** Minimal manifest whose Node-registry table lists exactly `ids`. */
const manifestFixture = ids => [
  "# Fleet manifest — standing node registry + placement law",
  "",
  "## The placement law (factory#60 — the agent-side mirror)",
  "",
  "neutral → open lane, any OS.",
  "",
  "## Node registry",
  "",
  "| Nodes | OS | Lanes served | Notes |",
  "|---|---|---|---|",
  ...ids.map(id => `| ${id} | macOS | open | fixture row |`),
  "",
  "## After",
  "",
  "prose after the table must not be parsed as rows",
].join("\n");

/** Run the tool in a fresh tmpdir; returns the spawn result. */
const run = ({ manifestIds = REGISTRY_IDS, registryIds = REGISTRY_IDS, useShippedManifest = false, ghScript = null, extraArgs = [] } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-drift-test-"));
  try {
    const manifestPath = path.join(dir, "fleet-manifest.md");
    writeFileSync(manifestPath, useShippedManifest ? SHIPPED_MANIFEST : manifestFixture(manifestIds));
    const registryPath = path.join(dir, "fleet.manifest.json");
    writeFileSync(registryPath, JSON.stringify(registryFixture(registryIds)));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    // gh stub: default succeeds is irrelevant (--registry mode never calls
    // it); the loud-skip legs point GH_BIN at a stub that fails.
    writeFileSync(path.join(bin, "gh"), ghScript ?? "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "gh"), 0o755);
    const args = [TOOL, "--manifest", manifestPath, "--registry", registryPath, ...extraArgs];
    const proc = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        GH_BIN: path.join(bin, "gh"),
        GH_TOKEN: process.env.GH_TOKEN ?? "stub",
      },
    });
    return { proc, dir };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
};

// --- 1. the shipped manifest carries the #397 roster -------------------------

test("the shipped manifest's Node registry parses to the full 8-node roster", async () => {
  const { parseManifestNodes } = await import(TOOL);
  const ids = parseManifestNodes(SHIPPED_MANIFEST);
  assert.ok(Array.isArray(ids), "manifest must carry a parseable Node registry table");
  // the pre-#397 five survive…
  for (const id of ["mini-L1", "mini-L2", "mini-L3", "mini-L4", "seed-L3"]) {
    assert.ok(ids.includes(id), `manifest lost pre-existing node ${id}`);
  }
  // …and the three air nodes the tower registry added are present (#397)
  for (const id of ["air16-native-open", "air8-native-open", "m1-8gb-air-open"]) {
    assert.ok(ids.includes(id), `manifest still missing air node ${id} (the #397 gap)`);
  }
  // the alignment note is honest about when the fence last passed
  assert.match(SHIPPED_MANIFEST, /Last aligned with the tower registry[^]*?2026-10-04/);
});

// --- 2. verdicts -------------------------------------------------------------

test("aligned: exit 0 with the node count on stdout", () => {
  const { proc, dir } = run();
  try {
    assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
    assert.match(proc.stdout, /aligned — 8 manifest nodes match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift: a registry node missing from the manifest exits 1 naming node + machine", () => {
  const { proc, dir } = run({ manifestIds: REGISTRY_IDS.slice(0, 7) }); // drop m1-8gb-air-open
  try {
    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /DRIFT/);
    assert.match(proc.stderr, /MISSING from manifest: m1-8gb-air-open \(machine macos-m1-8gb-air\.local, macos, lane open\)/);
    assert.match(proc.stderr, /owner-edit config\/fleet-manifest\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift: a stale manifest row the registry no longer carries exits 1", () => {
  const { proc, dir } = run({ manifestIds: [...REGISTRY_IDS, "ghost-node"] });
  try {
    assert.equal(proc.status, 1);
    assert.match(proc.stderr, /STALE — registry no longer carries: ghost-node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped manifest itself is aligned against the #397 registry roster", () => {
  const { proc, dir } = run({ useShippedManifest: true });
  try {
    assert.equal(proc.status, 0, `the shipped config/fleet-manifest.md must match the registry fixture:\n${proc.stderr}`);
    assert.match(proc.stdout, /aligned — 8 manifest nodes match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. loud skip when the registry is unreachable ---------------------------

test("registry unreachable: exit 0 with a counted SKIP line, never a silent verdict", () => {
  const { proc, dir } = run({ ghScript: "#!/bin/sh\necho 'gh: HttpError: Not Found' >&2\nexit 1\n", extraArgs: [] });
  try {
    // strip --registry so the tool must go through gh (which fails here)
    const manifestPath = path.join(dir, "fleet-manifest.md");
    const proc2 = spawnSync(process.execPath, [TOOL, "--manifest", manifestPath], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GH_BIN: path.join(dir, "bin", "gh") },
    });
    assert.equal(proc2.status, 0, "an unreachable registry must not fail the gate");
    assert.match(proc2.stderr, /^SKIP fleet-manifest-drift: tower registry unreachable — gh: HttpError: Not Found$/m);
    assert.doesNotMatch(proc2.stderr, /aligned|DRIFT/);
    assert.equal(proc.status, 0); // the --registry control leg stays green
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. usage / parse errors exit 2 -------------------------------------------

test("a manifest without a Node registry table exits 2, not a false verdict", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-drift-test-"));
  try {
    const manifestPath = path.join(dir, "no-table.md");
    writeFileSync(manifestPath, "# just prose\n\nno table here\n");
    const proc = spawnSync(process.execPath, [TOOL, "--manifest", manifestPath, "--registry", path.join(dir, "fleet.manifest.json")], { encoding: "utf8", timeout: 30_000 });
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /no '## Node registry' table/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a zero-node registry exits 2 — an empty diff is not alignment", () => {
  const { proc, dir } = run({ registryIds: [] });
  try {
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /registry carries zero nodes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown argument exits 2 with usage", () => {
  const { proc, dir } = run({ extraArgs: ["--wat"] });
  try {
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /unknown argument: --wat/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. the entry guard is symlink-safe (the #302 class) ----------------------

test("a symlinked entry still runs main — a drift fixture exits 1 through the link", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-drift-test-"));
  try {
    // stage the tool + a drifting manifest/registry pair in the tmpdir
    const realTool = path.join(dir, "real-fleet-manifest-drift.mjs");
    cpSync(TOOL, realTool);
    const manifestPath = path.join(dir, "fleet-manifest.md");
    writeFileSync(manifestPath, manifestFixture(REGISTRY_IDS.slice(0, 7)));
    const registryPath = path.join(dir, "fleet.manifest.json");
    writeFileSync(registryPath, JSON.stringify(registryFixture(REGISTRY_IDS)));
    const link = path.join(dir, "via-link.mjs");
    symlinkSync(realTool, link);
    assert.ok(existsSync(link), "symlink fixture");
    // argv[1] is the LINK; import.meta.url resolves to the REAL path — a
    // raw href comparison skips main() silently (the #302 false green)
    const proc = spawnSync(process.execPath, [link, "--manifest", manifestPath, "--registry", registryPath], { encoding: "utf8", timeout: 30_000 });
    assert.equal(proc.status, 1, `main() must run through a symlinked entry — stderr: ${proc.stderr}\nstdout: ${proc.stdout}`);
    assert.match(proc.stderr, /DRIFT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
