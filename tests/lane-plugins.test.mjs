import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONSULT = join(ROOT, "scripts", "lane-plugins-consult.py");
const MANIFEST = join(ROOT, "config", "lane-plugins.json");

function consult(args) {
  const out = execFileSync("python3", [CONSULT, ...args], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.trim());
}

function makePkg(dir, name) {
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-test", main: "./lib/index.js" }));
  writeFileSync(join(dir, "lib", "index.js"), "export default {};\n");
}

test("manifest: parses, required fields per seam, external refs pinned", () => {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  assert.ok(Array.isArray(m.macos), "macos set exists");
  assert.ok(Array.isArray(m.linux), "linux set exists");
  assert.ok(m.linux.length > 0, "linux set is non-empty (session-query entries ride both platforms)");
  for (const set of [m.macos, m.linux]) {
    for (const e of set) {
      assert.ok(e.id, "entry has id");
      assert.ok(["native-web", "plugin", "profile-config"].includes(e.seam), `${e.id}: valid seam`);
      if (e.source?.repo) {
        assert.match(e.source.ref, /^[0-9a-f]{40}$/, `${e.id}: external source pinned to a full sha`);
        assert.ok(e.canonical_dest, `${e.id}: external source declares canonical_dest`);
      }
      if (e.seam === "native-web") assert.equal(e.require_browser, true, `${e.id}: native-web gates on a browser`);
      if (e.probe_port) assert.equal(e.require_probe, true, `${e.id}: probe_port implies require_probe`);
      if (e.seam === "profile-config") {
        assert.ok(e.package, `${e.id}: profile-config names the profile-tree package it restates`);
        assert.ok(!e.source, `${e.id}: profile-config copies nothing`);
      }
    }
  }
});

test("consult: platform gate — linux node sees nothing from the macos set", () => {
  const lines = consult(["--platform", "Linux", "--node", "hetzner-shell", "--home", tmpdir()]);
  assert.ok(lines.every((l) => l.startsWith("SKIP") || l === ""), "no ENV/PATCH directives on a gated platform");
});

test("consult: native-web — missing canonical copy SKIPs (never a dead mount)", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  const browser = join(d, "chrome-headless-shell");
  writeFileSync(browser, "#!/bin/sh\n");
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [
        {
          id: "web-search-browser",
          seam: "native-web",
          nodes: ["*"],
          source: { repo: "ebowwa/HelloMacOScreator", path: "web-search-browser", ref: "d4f0213d31975ea55113de04103a4d91adef4e22" },
          canonical_dest: join(d, "canonical", "dsh-web-search-browser"), // does not exist
          browsers_probe: [browser],
          require_browser: true,
        },
      ],
    })
  );
  const lines = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, manifest]);
  const skip = lines.find((l) => l.startsWith("SKIP\tweb-search-browser"));
  assert.ok(skip && /canonical copy missing/.test(skip), `loud skip with reason, got: ${skip}`);
  assert.ok(!lines.some((l) => l.startsWith("ENV")), "no ENV primed for a missing canonical");
});

test("consult: native-web — primed ENV when canonical + browser exist; spacey browsers excluded", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  const canon = join(d, "canonical", "dsh-web-search-browser");
  makePkg(canon, "@local/dsh-web-search-browser");
  const cleanBrowser = join(d, "chrome-headless-shell");
  writeFileSync(cleanBrowser, "#!/bin/sh\n");
  mkdirSync(join(d, "Application Support")); // a path WITH a space
  const spaceyBrowser = join(d, "Application Support", "Brave Browser");
  writeFileSync(spaceyBrowser, "#!/bin/sh\n");
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [
        {
          id: "web-search-browser",
          seam: "native-web",
          nodes: ["*"],
          source: { repo: "x/y", path: "p", ref: "d4f0213d31975ea55113de04103a4d91adef4e22" },
          canonical_dest: canon,
          browsers_probe: [spaceyBrowser, cleanBrowser],
          require_browser: true,
        },
      ],
    })
  );
  const lines = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, manifest]);
  const cells = lines.find((l) => l.startsWith("ENV\tDSH_WEB_SEARCH_CELLS\t"));
  assert.ok(cells, "DSH_WEB_SEARCH_CELLS primed");
  assert.equal(cells.split("\t")[2], "mini-native-open", "cells names THIS node (2e glob then matches)");
  const browsers = lines.find((l) => l.startsWith("ENV\tDSH_WEB_SEARCH_BROWSER_BROWSERS\t"));
  assert.ok(browsers, "browser pin primed");
  const val = browsers.split("\t")[2];
  assert.ok(!val.includes(" "), "no space-containing browser in the env pin");
  assert.ok(val.includes("chrome-headless-shell"), "clean browser pinned");
});

test("consult: plugin — dead probe port SKIPs; live port mounts with insert-row overlay", async () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  // in-repo source fixture at a fake root
  const root = join(d, "tk");
  makePkg(join(root, "plugins", "dsh-reflex"), "@local/dsh-reflex");

  const probePort = await new Promise((res) => {
    const srv = createServer(() => {});
    srv.listen(0, "127.0.0.1", () => res(srv.address().port));
    // keep alive for the duration via closure; node exits at end of test
    setTimeout(() => srv.close(), 20000).unref?.();
  });

  const entry = (port) => ({
    id: "dsh-reflex",
    seam: "plugin",
    nodes: ["*"],
    source: { path: "plugins/dsh-reflex" },
    probe_port: port,
    require_probe: true,
    config: { host: "127.0.0.1", port, timeoutMs: 15000 },
  });

  writeFileSync(manifest, JSON.stringify({ macos: [entry(1)] })); // port 1: nothing answers
  const dead = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, "--root", root, manifest]);
  const skip = dead.find((l) => l.startsWith("SKIP\tdsh-reflex"));
  assert.ok(skip && /not answering/.test(skip), `dead engine skips loud, got: ${skip}`);
  assert.ok(!dead.some((l) => l.startsWith("PATCH")), "no overlay for a dead engine");

  writeFileSync(manifest, JSON.stringify({ macos: [entry(probePort)] }));
  const home = join(d, "home");
  mkdirSync(home, { recursive: true });
  const live = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", home, "--root", root, manifest]);
  const patchLine = live.find((l) => l.startsWith("PATCH\t"));
  assert.ok(patchLine, "overlay directive emitted");
  const patchFile = patchLine.split("\t")[1];
  assert.ok(existsSync(patchFile), "overlay file written");
  const body = readFileSync(patchFile, "utf8");
  assert.match(body, /- insert:/, "insert grammar (bare rows only warn)");
  assert.match(body, /name: '@local\/dsh-reflex'/, "row names the package as packaged");
  assert.match(body, new RegExp(`port: ${probePort}`), "config rendered");
  const dest = join(home, "profiles", "node_modules", "@local", "dsh-reflex");
  assert.ok(existsSync(join(dest, "package.json")), "per-job package copy landed (compose pattern)");
});

test("consult: node glob gate — a node outside the pattern SKIPs", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  writeFileSync(manifest, JSON.stringify({ macos: [{ id: "x", seam: "plugin", nodes: ["mini-native-*"], source: { path: "p" } }] }));
  const lines = consult(["--platform", "Darwin", "--node", "hetzner-shell", "--home", d, manifest]);
  assert.ok(lines.some((l) => l.startsWith("SKIP\tx\tnode")), "glob mismatch skips loud");
});

// --- profile-config seam + require_profile_packages gate (issue #110) ------

function makeProfilePkg(home, name) {
  const ns = name.includes("/") ? name.split("/")[0] : "@local";
  const leaf = name.includes("/") ? name.split("/")[1] : name;
  const dir = join(home, "profiles", "node_modules", ns, leaf);
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-test", main: "./lib/index.js" }));
  writeFileSync(join(dir, "lib", "index.js"), "export default {};\n");
  return dir;
}

test("consult: profile-config — missing profile package SKIPs loud (a restated row naming a missing package is a dead mount)", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [{ id: "session-query-sqlite", seam: "profile-config", nodes: ["*"], package: "@deepseek-ai/dsh-session-query-sqlite", config: { openAt: "first-search" } }],
    })
  );
  const lines = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, manifest]);
  const skip = lines.find((l) => l.startsWith("SKIP\tsession-query-sqlite"));
  assert.ok(skip && /missing\/incomplete/.test(skip), `loud skip, got: ${skip}`);
  assert.ok(!lines.some((l) => l.startsWith("PATCH")), "no overlay for a missing package");
});

test("consult: profile-config — bare RESTATING row (no insert grammar), ~/ config expanded against the real home", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  makeProfilePkg(d, "@deepseek-ai/dsh-session-persistence-jsonl");
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [{ id: "session-persistence-jsonl", seam: "profile-config", nodes: ["*"], package: "@deepseek-ai/dsh-session-persistence-jsonl", config: { root: "~/.dsh/sessions" } }],
    })
  );
  const lines = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, manifest]);
  const patchLine = lines.find((l) => l.startsWith("PATCH\t"));
  assert.ok(patchLine, "overlay emitted");
  const body = readFileSync(patchLine.split("\t")[1], "utf8");
  assert.doesNotMatch(body, /insert/, "bare row — the id already ships; insert would append a duplicate");
  assert.match(body, /- id: session-persistence-jsonl/, "restates the SHIPPED id");
  assert.match(body, /name: '@deepseek-ai\/dsh-session-persistence-jsonl'/, "names the package");
  assert.match(body, new RegExp(`root: "${join(homedir(), ".dsh", "sessions").replace(/\\/g, "\\\\")}"`), "~/ expanded to the real home (job homes are discarded; the corpus is not)");
});

test("consult: profile-config shared_index — unique per-job db under the shared dir, dir created, stale files pruned", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  makeProfilePkg(d, "@deepseek-ai/dsh-session-query-sqlite");
  const sharedIndex = "~/.dsh/lp-test-session-index";
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [{ id: "session-query-sqlite", seam: "profile-config", nodes: ["*"], package: "@deepseek-ai/dsh-session-query-sqlite", config: { openAt: "first-search" }, shared_index: sharedIndex }],
    })
  );
  const indexDir = join(homedir(), ".dsh", "lp-test-session-index");
  // a stale file older than any keep window must be pruned by the stamp
  rmSync(indexDir, { recursive: true, force: true });
  mkdirSync(indexDir, { recursive: true });
  const stale = join(indexDir, "session-search-stale.db");
  writeFileSync(stale, "x");
  utimesSync(stale, new Date(Date.now() - 40 * 86400_000), new Date(Date.now() - 40 * 86400_000));

  const lines = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, manifest]);
  const patchLine = lines.find((l) => l.startsWith("PATCH\t"));
  assert.ok(patchLine, "overlay emitted");
  const body = readFileSync(patchLine.split("\t")[1], "utf8");
  const m = body.match(/path: "(.+\.db)"/);
  assert.ok(m, `per-job db path stamped, got: ${body}`);
  assert.ok(m[1].startsWith(indexDir + "/"), "db lives under the SHARED per-box dir");
  assert.match(m[1], /session-search-\d+-\d+\.db$/, "unique per-run file name (one process owner per path)");
  assert.ok(existsSync(indexDir), "shared index dir created");
  assert.ok(!existsSync(stale), "stale index file pruned");
  // a second stamp must hand out a DIFFERENT path — no two jobs share a file
  const lines2 = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, manifest]);
  const body2 = readFileSync(lines2.find((l) => l.startsWith("PATCH\t")).split("\t")[1], "utf8");
  assert.notEqual(body2.match(/path: "(.+\.db)"/)[1], m[1], "second run gets its own db file");
  rmSync(indexDir, { recursive: true, force: true });
});

test("consult: plugin require_profile_packages — backend missing SKIPs the tools (never a mount that fails every call)", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  const root = join(d, "tk");
  makePkg(join(root, "plugins", "tool-session-query"), "@deepseek-ai/dsh-tool-session-query");
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [{ id: "tool-session-query", seam: "plugin", nodes: ["*"], source: { path: "plugins/tool-session-query" }, require_profile_packages: ["@deepseek-ai/dsh-session-query-sqlite"] }],
    })
  );
  const lines = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, "--root", root, manifest]);
  const skip = lines.find((l) => l.startsWith("SKIP\ttool-session-query"));
  assert.ok(skip && /dsh-session-query-sqlite/.test(skip), `backend gate skips loud, got: ${skip}`);
  assert.ok(!lines.some((l) => l.startsWith("PATCH")), "no overlay without the backend");
  // and the mount succeeds once the backend ships in the profile tree
  makeProfilePkg(d, "@deepseek-ai/dsh-session-query-sqlite");
  const ok = consult(["--platform", "Darwin", "--node", "mini-native-open", "--home", d, "--root", root, manifest]);
  assert.ok(ok.some((l) => l.startsWith("MOUNTED\ttool-session-query")), "mounts once the backend is present");
  const copied = join(d, "profiles", "node_modules", "@deepseek-ai", "dsh-tool-session-query", "package.json");
  assert.ok(existsSync(copied), "vendored package copied into the @deepseek-ai flat-fallback namespace");
});
