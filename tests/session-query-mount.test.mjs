// session-query-mount — the tool-session-query mount (issue #110): the
// vendored build (plugins/tool-session-query), the three manifest entries
// that turn prior-session search on, and the skill that points at the
// native tools. The consult half (gating, row shapes) lives in
// lane-plugins.test.mjs; this file pins the CROSS-FILE contracts and runs
// the live proofs on cells that carry the real dsh CLI.
//
// Harness modeled on search-compose-mount.test.mjs: offline tests never
// import the vendored lib (CI has no profile tree — parse checks only);
// the live half is skip-gated on `dsh --version`.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "plugins", "tool-session-query");
const MANIFEST = join(ROOT, "config", "lane-plugins.json");
const CONSULT = join(ROOT, "scripts", "lane-plugins-consult.py");
const SKILL = join(ROOT, ".agents", "skills", "verify-before-dismissal", "SKILL.md");
// The vendored build must era-match the deployed profile tree: newer alpha
// lines import session APIs the rc-era dsh-session does not export and the
// live boot proof fails them (measured: 0.1.7-alpha.2 imports SessionSeq).
const PINNED_VERSION = "0.1.0-rc.8";

const DSH_PRESENT = spawnSync("dsh", ["--version"]).status === 0;

function consult(args) {
  const out = execFileSync("python3", [CONSULT, ...args], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.trim());
}

test("vendored package: parseable, pinned, structurally complete", () => {
  const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
  assert.equal(pkg.name, "@deepseek-ai/dsh-tool-session-query", "the overlay rows and docs name this exact package");
  assert.equal(pkg.version, PINNED_VERSION, `vendored build pinned (bump only with a green live boot proof)`);
  assert.equal(pkg.main, "lib/index.js");
  assert.ok(existsSync(join(PKG, "lib", "index.js")), "built lib present");
  assert.ok(existsSync(join(PKG, "LICENSE")), "upstream license kept");
  assert.ok(!existsSync(join(PKG, "test")), "no test/ dir — the gates' plugin-deps smoke would otherwise try to install its peers");
  const check = spawnSync("node", ["--check", join(PKG, "lib", "index.js")], { encoding: "utf8" });
  assert.equal(check.status, 0, `vendored lib must parse: ${check.stderr}`);
  // every other runtime file in the lib tree must parse too (companion
  // entries like invariant.js are loaded by their own import specifiers)
  const libFiles = readdirSync(join(PKG, "lib")).filter((f) => f.endsWith(".js"));
  for (const f of libFiles) {
    const c = spawnSync("node", ["--check", join(PKG, "lib", f)], { encoding: "utf8" });
    assert.equal(c.status, 0, `vendored lib/${f} must parse: ${c.stderr}`);
  }
});

test("vendored package: imports only @deepseek-ai/* bare specifiers (the flat-fallback contract)", () => {
  const src = readFileSync(join(PKG, "lib", "index.js"), "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, "imports found");
  for (const s of specs) {
    assert.match(s, /^@deepseek-ai\//, `bare @deepseek-ai/* specifier only, got: ${s} — anything else needs provisioning the flat fallback cannot satisfy`);
  }
  assert.ok(specs.includes("@deepseek-ai/dsh-session-query"), "binds ctx.sessionQuery's interface package");
});

test("manifest: the three session-query entries cross-pin (ids are the SHIPPED profile ids; tool entry gated on the backend)", () => {
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
  for (const platform of ["macos", "linux"]) {
    const byId = Object.fromEntries(m[platform].map((e) => [e.id, e]));
    // Bare rows REPLACE whole config — the id must equal the shipped row's
    // id from the real profile dump, or the overlay adds a duplicate plugin.
    assert.equal(byId["session-persistence-jsonl"]?.seam, "profile-config", `${platform}: corpus row restates the shipped id`);
    assert.equal(byId["session-persistence-jsonl"]?.package, "@deepseek-ai/dsh-session-persistence-jsonl");
    assert.equal(byId["session-persistence-jsonl"]?.config?.root, "~/.dsh/sessions", `${platform}: corpus rooted at the box-shared sessions dir`);
    const sqlite = byId["session-query-sqlite"];
    assert.equal(sqlite?.seam, "profile-config", `${platform}: backend row restates the shipped id`);
    assert.equal(sqlite?.config?.openAt, "first-search", `${platform}: boot unaffected; an unopenable index fails one search`);
    assert.ok(sqlite?.shared_index, `${platform}: per-job db under a shared dir — one shared FILE breaks the single-process-owner contract`);
    const tool = byId["tool-session-query"];
    assert.equal(tool?.seam, "plugin", `${platform}: tools ride the compose seam`);
    assert.equal(tool?.source?.path, "plugins/tool-session-query", `${platform}: in-tree vendored build`);
    assert.deepEqual(tool?.require_profile_packages, ["@deepseek-ai/dsh-session-query-sqlite"], `${platform}: tools must not mount without their backend`);
  }
});

test("skill: exists and points at the native tools (not the hand-parser path) as step one", () => {
  const body = readFileSync(SKILL, "utf8");
  assert.match(body, /^name: verify-before-dismissal/m, "frontmatter name");
  assert.match(body, /session_search/, "native full-text search is the first move");
  assert.match(body, /session_event_search/, "prior pushbacks searchable");
  assert.match(body, /session_trace/, "lineage searchable");
  assert.match(body, /Fallback/, "the hand-parser path survives as fallback, not primary");
});

// --- live half: real dsh only (the dsh lanes; skipped elsewhere) -----------

// Consult-stamp all three entries into a temp home whose profile tree
// carries the REAL backend packages (symlinked from the box's own install —
// the same packages a dispatched job's profile hoists), then hand back the
// overlay paths in manifest order.
function stampOverlays() {
  const home = mkdtempSync(join(tmpdir(), "dsh-sq-mount-"));
  // The backend packages must resolve from THIS home BEFORE the consult runs
  // (their presence is the entries' gate): symlink the box's real installs —
  // the same packages a dispatched job's profile hoists. The tool package is
  // copied per-job by the consult itself, from the in-tree vendored build.
  const ns = join(home, "profiles", "node_modules", "@deepseek-ai");
  mkdirSync(ns, { recursive: true });
  for (const name of ["dsh-session-query-sqlite", "dsh-session-persistence-jsonl"]) {
    symlinkSync(join(process.env.HOME ?? "", ".dsh", "profiles", "node_modules", "@deepseek-ai", name), join(ns, name), "dir");
  }
  const out = consult(["--platform", process.platform === "darwin" ? "Darwin" : "Linux", "--node", process.env.DSH_RUNNER_NAME || process.env.RUNNER_NAME || "test-node", "--home", home, join(ROOT, "config", "lane-plugins.json")]);
  const patches = out.filter((l) => l.startsWith("PATCH\t")).map((l) => l.split("\t")[1]);
  assert.ok(patches.length >= 3, `at least the three session-query overlays must stamp (reflex may probe-skip), got ${patches.length}: ${out.join(" | ")}`);
  return { home, patches };
}

test("the three overlays compose into the real profile (skip when dsh is absent)", { skip: !DSH_PRESENT }, () => {
  const { home, patches } = stampOverlays();
  const dump = spawnSync("dsh", ["--profile", "headless", ...patches.flatMap((p) => ["--patch", p]), "--dump-config"], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
    timeout: 90_000,
  });
  assert.equal(dump.status, 0, `dump-config must compose, stderr: ${dump.stderr}`);
  assert.match(dump.stdout, /- id: session-query-sqlite\n\s+name: ['"]@deepseek-ai\/dsh-session-query-sqlite['"]\n\s+config:\n\s+openAt: first-search/, "backend row ON in the composed tree");
  assert.doesNotMatch(dump.stdout, /openAt: never/, "shipped-off default must not survive the restatement");
  assert.match(dump.stdout, /- id: tool-session-query\n\s+name: ['"]@deepseek-ai\/dsh-tool-session-query['"]/, "tool row resolved (not warn-and-skipped)");
  assert.match(dump.stdout, /root: .*\/\.dsh\/sessions/, "corpus rooted at the shared store");
});

test("the composed tree BOOTS: all three plugins load, boot dies at the credential wall (skip when dsh is absent)", { skip: !DSH_PRESENT }, () => {
  const { home, patches } = stampOverlays();
  const cwd = mkdtempSync(join(tmpdir(), "dsh-sq-bootcwd-"));
  // Strip every plausible inference credential: the boot must die at
  // credential resolution (fast, offline), never place a live call. A
  // plugin-tree load failure dies EARLIER with a different error — which is
  // exactly the failure that caught the alpha-line API drift (SessionSeq).
  const env = { ...process.env, DSH_HOME: home };
  for (const k of ["ZAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DOPPLER_SERVICE_TOKEN"]) delete env[k];
  const boot = spawnSync("dsh", ["--profile", "headless", ...patches.flatMap((p) => ["--patch", p]), "reply ok"], {
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    env,
  });
  assert.notEqual(boot.status, null, "the boot probe must terminate, not hang");
  const combined = `${boot.stdout}\n${boot.stderr}`;
  assert.match(combined, /MISSING_CREDENTIAL/, `boot must reach the credential wall with every plugin loaded, got: ${combined.slice(0, 800)}`);
  assert.doesNotMatch(combined, /failed to apply loader entry|does not provide an export/, "no plugin-load failure (the alpha-line drift shape)");
});
