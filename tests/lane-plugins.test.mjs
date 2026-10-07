import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, utimesSync, copyFileSync, chmodSync } from "node:fs";
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
      assert.ok(["native-web", "plugin", "profile-config", "system-prompt"].includes(e.seam), `${e.id}: valid seam`);
      if (e.source?.repo) {
        assert.match(e.source.ref, /^[0-9a-f]{40}$/, `${e.id}: external source pinned to a full sha`);
        assert.ok(e.canonical_dest, `${e.id}: external source declares canonical_dest`);
      }
      if (e.seam === "native-web") assert.equal(e.require_browser, true, `${e.id}: native-web gates on a browser`);
      if (e.probe_port) assert.equal(e.require_probe, true, `${e.id}: probe_port implies require_probe`);
      // issue #256: the converse pin — a probe gate without a port is a
      // manifest bug; the consult must SKIP it loud, never crash mid-loop.
      if (e.require_probe) assert.ok(e.probe_port, `${e.id}: require_probe declares probe_port`);
      if (e.seam === "profile-config") {
        assert.ok(e.package, `${e.id}: profile-config names the profile-tree package it restates`);
        assert.ok(!e.source, `${e.id}: profile-config copies nothing`);
      }
      if (e.seam === "system-prompt") {
        assert.ok(e.source?.path, `${e.id}: system-prompt names an in-tree template`);
        assert.ok(existsSync(join(ROOT, e.source.path)), `${e.id}: template exists in-tree`);
        assert.ok(e.target_file, `${e.id}: system-prompt names its target file`);
        const tpl = readFileSync(join(ROOT, e.source.path), "utf8");
        assert.ok(tpl.includes(`<!-- dsh:${e.id} -->`) && tpl.includes(`<!-- /dsh:${e.id} -->`), `${e.id}: template carries its marker block (unscoped prompt writes are refused)`);
        assert.ok(/TCC/i.test(tpl), `${e.id}: template carries the TCC exclusion (issue #254: consent dialogs are owner-once)`);
      }
    }
  }
  // issue #254: the reflex directive is a mac-lane bake-in — a system-prompt
  // entry must not silently ride the linux set (Linux nodes never mount it).
  assert.ok(!m.linux.some((e) => e.seam === "system-prompt"), "no system-prompt entry on the linux set");
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

// issue #256: `require_probe` without `probe_port` used to raise KeyError
// OUTSIDE any try block — the traceback killed the consult mid-loop and
// every LATER entry silently never mounted. The pin: both seams (plugin +
// system-prompt) degrade to a loud SKIP and the loop survives.
test("consult: require_probe without probe_port SKIPs loud on both seams — the loop survives, later entries still mount", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const manifest = join(d, "m.json");
  const root = join(d, "tk");
  makePkg(join(root, "plugins", "bad-plugin"), "@local/bad-plugin");
  makePkg(join(root, "plugins", "good-plugin"), "@local/good-plugin");
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [
        { id: "bad-plugin", seam: "plugin", nodes: ["*"], source: { path: "plugins/bad-plugin" }, require_probe: true }, // no probe_port
        { id: "bad-prompt", seam: "system-prompt", nodes: ["*"], source: { path: "config/system-prompts/none.md" }, target_file: join(d, "prompt.md"), require_probe: true }, // no probe_port
        { id: "good-plugin", seam: "plugin", nodes: ["*"], source: { path: "plugins/good-plugin" } },
      ],
    })
  );
  // execFileSync throws on a non-zero exit — the crash class itself fails here
  const lines = consult(["--platform", "Darwin", "--node", "mini-L1", "--home", d, "--root", root, manifest]);
  const badPlugin = lines.find((l) => l.startsWith("SKIP\tbad-plugin"));
  assert.ok(badPlugin && /probe_port missing/.test(badPlugin), `plugin seam skips loud, got: ${badPlugin}`);
  const badPrompt = lines.find((l) => l.startsWith("SKIP\tbad-prompt"));
  assert.ok(badPrompt && /probe_port missing/.test(badPrompt), `system-prompt seam skips loud, got: ${badPrompt}`);
  assert.ok(!lines.some((l) => l.startsWith("PATCH\t" + join(d, "lane-plugin-bad-plugin"))), "no overlay for the ungated probe row");
  assert.ok(lines.some((l) => l.startsWith("MOUNTED\tgood-plugin")), `the LATER entry still mounts (mid-loop death was the defect), got: ${lines.join(" | ")}`);
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
  // Unique per-RUN dir under the real home: still exercises the ~/ expansion
  // against the shared per-box parent (~/.dsh), but a fixed name here let two
  // concurrent suite runs on a multi-tenant box wipe each other's dir with
  // the rmSync calls below — the load-only flake of issue #140.
  const sharedIndex = `~/.dsh/lp-test-session-index-${process.pid}-${Date.now()}`;
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [{ id: "session-query-sqlite", seam: "profile-config", nodes: ["*"], package: "@deepseek-ai/dsh-session-query-sqlite", config: { openAt: "first-search" }, shared_index: sharedIndex }],
    })
  );
  const indexDir = join(homedir(), sharedIndex.replace(/^~\/?/, ""));
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

test("consult: system-prompt — live engine merges the marker block; operator text untouched", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-"));
  const root = mkdtempSync(join(tmpdir(), "lp-root-"));
  const tplDir = join(root, "config", "system-prompts");
  mkdirSync(tplDir, { recursive: true });
  const tpl = join(tplDir, "macos.md");
  writeFileSync(tpl, "<!-- dsh:mac-reflex-prompt -->\nREFLEX RULE v1\n<!-- /dsh:mac-reflex-prompt -->\n");
  const home = mkdtempSync(join(tmpdir(), "lp-home-"));
  const target = join(home, "system-prompt.md");
  writeFileSync(target, "operator preamble — never touched\n");
  const manifest = join(d, "m.json");
  const entry = (port) => ({
    id: "mac-reflex-prompt",
    seam: "system-prompt",
    nodes: ["*"],
    source: { path: "config/system-prompts/macos.md" },
    target_file: target, // absolute: expanduser leaves it alone
    probe_port: port,
    require_probe: true,
  });
  writeFileSync(manifest, JSON.stringify({ macos: [entry(1)] }));
  const dead = consult(["--platform", "Darwin", "--node", "mini-L1", "--home", home, "--root", root, manifest]);
  const skip = dead.find((l) => l.startsWith("SKIP\tmac-reflex-prompt"));
  assert.ok(skip && /not answering/.test(skip), `dead engine skips loud, got: ${skip}`);
  assert.ok(!readFileSync(target, "utf8").includes("REFLEX RULE"), "dead engine writes nothing");

  return new Promise((resolve) => {
    const srv = createServer(() => {});
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
    setTimeout(() => srv.close(), 20000).unref?.();
  }).then((port) => {
    writeFileSync(manifest, JSON.stringify({ macos: [entry(port)] }));
    const out = consult(["--platform", "Darwin", "--node", "mini-L1", "--home", home, "--root", root, manifest]);
    assert.ok(out.some((l) => l.startsWith("MOUNTED\tmac-reflex-prompt")), `mounts with a live engine, got: ${out.join(" | ")}`);
    let merged = readFileSync(target, "utf8");
    assert.ok(merged.includes("operator preamble"), "operator text preserved");
    assert.ok(merged.includes("REFLEX RULE v1"), "template block merged");

    // idempotent: unchanged template is a no-op write
    const before = readFileSync(target, "utf8");
    const again = consult(["--platform", "Darwin", "--node", "mini-L1", "--home", home, "--root", root, manifest]);
    assert.ok(again.some((l) => l.includes("already current")), "second run reports no-op");
    assert.equal(readFileSync(target, "utf8"), before, "no rewrite when current");

    // template change replaces ONLY the block
    writeFileSync(tpl, "<!-- dsh:mac-reflex-prompt -->\nREFLEX RULE v2\n<!-- /dsh:mac-reflex-prompt -->\n");
    consult(["--platform", "Darwin", "--node", "mini-L1", "--home", home, "--root", root, manifest]);
    merged = readFileSync(target, "utf8");
    assert.ok(merged.includes("REFLEX RULE v2") && !merged.includes("REFLEX RULE v1"), "block replaced on template change");
    assert.ok(merged.includes("operator preamble"), "operator text still preserved");

    // unmarked template is refused, never merged
    writeFileSync(tpl, "REFLEX RULE v3 without markers\n");
    const refused = consult(["--platform", "Darwin", "--node", "mini-L1", "--home", home, "--root", root, manifest]);
    assert.ok(refused.some((l) => l.startsWith("SKIP\tmac-reflex-prompt") && /marker block/.test(l)), "unmarked template skips loud");
    assert.ok(!readFileSync(target, "utf8").includes("v3"), "unmarked template writes nothing");
  });
});

// --- sync-lane-plugins.sh --verify (issue #548) ------------------------------
// The VERIFY arm's ref read was a bare `git rev-parse "$SRC_REF"`: on an
// unresolvable ref it echoes the LITERAL ref name to stdout (stderr
// suppressed, exit status unused inside $()) while the preceding
// `diff --quiet "$SRC_REF"` fails for the same missing-ref reason — together
// the "cache not at $SRC_REF" NOTE fired off garbage, not a comparison (the
// #526/#545 garbage-capture class). The pin: the NOTE fires only when
// SRC_REF actually resolves AND the cache sits elsewhere; an unresolvable
// ref prints no NOTE; the NOTE never sets FAIL (keepalives run --verify
// `|| true` — loud, never blocking).

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function commitAll(dir, msg) {
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);
}

function runSyncVerify(script, home) {
  return spawnSync("bash", [script, "--verify"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

test("sync --verify: NOTE fires only off a real comparison — an unresolvable SRC_REF prints no NOTE (issue #548)", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-sync-"));
  const home = join(d, "home");
  const scriptDir = join(d, "scripts");
  const configDir = join(d, "config");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const script = join(scriptDir, "sync-lane-plugins.sh");
  copyFileSync(join(ROOT, "scripts", "sync-lane-plugins.sh"), script);
  chmodSync(script, 0o755);
  const manifest = join(configDir, "lane-plugins.json");

  // three independent cache repos (the cache path derives from SRC_REPO),
  // each with two commits touching the synced path p/
  const cacheFor = (repo) => join(home, ".dsh-plugin-cache", repo.replace(/\//g, "__"));
  const makeCache = (repo) => {
    const cache = cacheFor(repo);
    mkdirSync(join(cache, "p"), { recursive: true });
    git(cache, "init", "-q", "-b", "main"); // pin the branch: init.defaultBranch differs per lane and the stale arm below checks out main by name (issue #567, convention per tests/rename-compat.test.mjs)
    git(cache, "config", "user.email", "t@t");
    git(cache, "config", "user.name", "t");
    writeFileSync(join(cache, "p", "f.txt"), "v1\n");
    commitAll(cache, "c1");
    const sha1 = git(cache, "rev-parse", "HEAD").trim();
    writeFileSync(join(cache, "p", "f.txt"), "v2\n");
    commitAll(cache, "c2");
    return sha1;
  };
  const shaAtRef = makeCache("x/at-ref");
  const shaBehind = makeCache("x/behind");
  makeCache("x/bad-ref");
  git(cacheFor("x/at-ref"), "checkout", "-q", shaAtRef); // HEAD == pinned ref: fresh
  git(cacheFor("x/behind"), "checkout", "-q", "main"); // HEAD past the pin: stale
  // x_bad-ref stays at main — its manifest ref (refs/heads/no-such-ref) resolves nowhere

  const destFor = (name) => join(d, "canonical", name);
  for (const name of ["at-ref", "behind", "bad-ref"]) {
    mkdirSync(destFor(name), { recursive: true });
    writeFileSync(join(destFor(name), "package.json"), JSON.stringify({ name: `@local/${name}`, version: "0.0.0-test" }));
  }
  writeFileSync(
    manifest,
    JSON.stringify({
      macos: [
        { id: "at-ref", seam: "plugin", nodes: ["*"], source: { repo: "x/at-ref", path: "p", ref: shaAtRef }, canonical_dest: destFor("at-ref") },
        { id: "behind", seam: "plugin", nodes: ["*"], source: { repo: "x/behind", path: "p", ref: shaBehind }, canonical_dest: destFor("behind") },
        { id: "bad-ref", seam: "plugin", nodes: ["*"], source: { repo: "x/bad-ref", path: "p", ref: "refs/heads/no-such-ref" }, canonical_dest: destFor("bad-ref") },
      ],
    })
  );

  const r = runSyncVerify(script, home);
  assert.equal(r.status, 0, `verify exits clean (a NOTE never FAILs), got: ${r.status} stderr=${r.stderr}`);
  const notes = r.stderr.split("\n").filter((l) => l.includes("VERIFY NOTE"));
  assert.equal(notes.length, 1, `exactly the meaningful NOTE fired, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(notes[0].includes(shaBehind), "the stale cache's NOTE names its pinned sha");
  assert.ok(!r.stderr.includes("no-such-ref"), "the unresolvable ref produced no NOTE (was: the literal ref echoed back as the comparison operand)");
});

test("sync --verify: missing canonical copy is still a loud FAIL (exit 1) — unchanged verdict path", () => {
  const d = mkdtempSync(join(tmpdir(), "lp-sync-"));
  const home = join(d, "home");
  const scriptDir = join(d, "scripts");
  const configDir = join(d, "config");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const script = join(scriptDir, "sync-lane-plugins.sh");
  copyFileSync(join(ROOT, "scripts", "sync-lane-plugins.sh"), script);
  chmodSync(script, 0o755);
  writeFileSync(
    join(configDir, "lane-plugins.json"),
    JSON.stringify({
      macos: [{ id: "gone", seam: "plugin", nodes: ["*"], source: { repo: "x/gone", path: "p", ref: "d4f0213d31975ea55113de04103a4d91adef4e22" }, canonical_dest: join(d, "canonical", "gone") }],
    })
  );
  const r = runSyncVerify(script, home);
  assert.equal(r.status, 1, `missing dest FAILs loud, got: ${r.status}`);
  assert.ok(r.stderr.includes("VERIFY FAIL"), "FAIL names the missing dest");
});
