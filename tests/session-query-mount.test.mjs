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
import { bootProbe } from "./lib/live-boot.mjs";

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

// The live legs need MORE than the CLI: stampOverlays symlinks the box's
// real backend packages (~/.dsh/profiles/node_modules/@deepseek-ai/...) —
// their presence is the overlay rows' gate, so an absent or dangling
// profile tree stamps 2 patches and the legs red at the >=3 assert on a
// PRISTINE main (issue #273: exactly that red on a box whose profile tree
// had drifted; healed only by the tree's own refresh — no PR could fix
// it). Box state, not a code regression: degrade to a LOUD skip naming
// the missing precondition, the same shape as the dsh-absent gate above.
// Strict whenever the precondition holds — the offline legs never touch it.
function backendPackagesPresent(home) {
  const ns = join(home ?? "", ".dsh", "profiles", "node_modules", "@deepseek-ai");
  return ["dsh-session-query-sqlite", "dsh-session-persistence-jsonl"].every(
    (name) => existsSync(join(ns, name, "package.json")),
  );
}
const LIVE_SKIP_REASON = !DSH_PRESENT
  ? "dsh is absent"
  : backendPackagesPresent(process.env.HOME)
    ? false
    : `box profile tree lacks the backend packages under ~/.dsh/profiles/node_modules/@deepseek-ai (dsh-session-query-sqlite, dsh-session-persistence-jsonl) — box state, not a code regression (issue #273)`;

// Hermetic lane-plugin consult (issue #129): empty-entry manifest — nothing
// mounts regardless of what answers on the box.
const HERMETIC_LANE_PLUGINS = join(ROOT, "tests", "fixtures", "lane-plugins-hermetic.json");

// Hermetic base env (issue #144 — the #131 class in the sibling suites): an
// agent job's ambient dsh exports (DSH_HOME, DSH_SESSION_JSONL,
// DSH_SESSION_ID, DSH_SHELL, DSH_RUNNER_NAME, DSH_LANE_PLUGINS_MANIFEST,
// RUNNER_NAME, ...) must not reach the spawns below. The live half hands
// real dsh boots to whatever the caller exported — a dispatched job's
// session seams (DSH_SESSION_JSONL/DSH_SESSION_ID) would redirect the very
// persistence behavior the boot proof exercises — and even the harness-side
// consult reads ambient env (lane-plugins-consult.py reads
// DSH_SESSION_INDEX_KEEP_DAYS). Strip the whole ambient DSH_* family plus
// the RUNNER_NAME seam at the base; each spawn then re-pins exactly what it
// wants (DSH_HOME here, per-test extras last). CI's clean env is unaffected.
// The BASE also pins the no-mount manifest fixture: dsh does not read that
// seam today (it is the driver's, run-dsh-agent.sh:710), so the pin is
// inert in this file — it keeps every spawn deterministic against a future
// reader and matches the sibling suites' base.
const HERMETIC_ENV = (() => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "RUNNER_NAME" || key.startsWith("DSH_")) delete env[key];
  }
  env.DSH_LANE_PLUGINS_MANIFEST = HERMETIC_LANE_PLUGINS;
  return env;
})();

function consult(args) {
  const out = execFileSync("python3", [CONSULT, ...args], { encoding: "utf8", env: HERMETIC_ENV });
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

test("the live-half gate pins its own contract: backend packages absent → skip named, present → strict (issue #273)", () => {
  // A home whose profile tree lacks the backends must gate the live legs
  // OFF (skip, never an unexplained red at the >=3 assert); a home that
  // carries both package.json files must keep the legs strict.
  const absentHome = mkdtempSync(join(tmpdir(), "dsh-sq-gate-absent-"));
  assert.equal(backendPackagesPresent(absentHome), false, "absent backends → live legs skip");
  assert.equal(backendPackagesPresent(join(absentHome, "no-such-home")), false, "a missing home is the absent case too");
  const presentHome = mkdtempSync(join(tmpdir(), "dsh-sq-gate-present-"));
  const ns = join(presentHome, ".dsh", "profiles", "node_modules", "@deepseek-ai");
  for (const name of ["dsh-session-query-sqlite", "dsh-session-persistence-jsonl"]) {
    mkdirSync(join(ns, name), { recursive: true });
    writeFileSync(join(ns, name, "package.json"), "{}");
  }
  assert.equal(backendPackagesPresent(presentHome), true, "both backends present → live legs stay strict");
  // A tree with only ONE of the two is still the absent case — the
  // overlays' gate needs every require_profile_packages row to resolve.
  rmSync(join(ns, "dsh-session-persistence-jsonl"), { recursive: true });
  assert.equal(backendPackagesPresent(presentHome), false, "half-present backends → live legs skip (every row must resolve)");
});

test("the three overlays compose into the real profile (live: needs dsh + the box backend packages)", { skip: LIVE_SKIP_REASON }, () => {
  const { home, patches } = stampOverlays();
  // Starvation retry (issue #595): the dump-config leg carries the same
  // under-load starvation exposure #594 fixed for the boot leg below — a
  // starved child terminates empty and reds HERE, at the status assert
  // (nonzero/null), not at a match. The dump's starvation shape is the same
  // both-streams-empty discriminator bootProbe pins: the composed config
  // (stdout) and the diagnostic (stderr) are both OUTPUT, so both streams
  // empty is exactly "neither a composed config nor a diagnostic" — a
  // starvation artifact, retried once; a diagnostic-bearing attempt is a
  // verdict and returns immediately. Pins: tests/live-boot-probe.test.mjs.
  const { boot: dump, attemptsRan, starvationRetried } = bootProbe({
    command: "dsh",
    args: ["--profile", "headless", ...patches.flatMap((p) => ["--patch", p]), "--dump-config"],
    options: { encoding: "utf8", env: { ...HERMETIC_ENV, DSH_HOME: home }, timeout: 90_000 },
  });
  const dumpLoad = starvationRetried
    ? ` (attempt 1 starved to empty output and was retried once — ${attemptsRan} attempts; a STILL-empty result is box load, not the diff — issue #595)`
    : "";
  assert.equal(dump.status, 0, `dump-config must compose${dumpLoad}, stderr: ${dump.stderr}`);
  assert.match(dump.stdout, /- id: session-query-sqlite\n\s+name: ['"]@deepseek-ai\/dsh-session-query-sqlite['"]\n\s+config:\n\s+openAt: first-search/, `backend row ON in the composed tree${dumpLoad}`);
  assert.doesNotMatch(dump.stdout, /openAt: never/, "shipped-off default must not survive the restatement");
  assert.match(dump.stdout, /- id: tool-session-query\n\s+name: ['"]@deepseek-ai\/dsh-tool-session-query['"]/, "tool row resolved (not warn-and-skipped)");
  assert.match(dump.stdout, /root: .*\/\.dsh\/sessions/, "corpus rooted at the shared store");
});

test("the composed tree BOOTS: all three plugins load, boot dies at the credential wall (live: needs dsh + the box backend packages)", { skip: LIVE_SKIP_REASON }, () => {
  const { home, patches } = stampOverlays();
  const cwd = mkdtempSync(join(tmpdir(), "dsh-sq-bootcwd-"));
  // Strip every plausible inference credential: the boot must die at
  // credential resolution (fast, offline), never place a live call. A
  // plugin-tree load failure dies EARLIER with a different error — which is
  // exactly the failure that caught the alpha-line API drift (SessionSeq).
  const env = { ...HERMETIC_ENV, DSH_HOME: home };
  for (const k of ["ZAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DOPPLER_SERVICE_TOKEN"]) delete env[k];
  // Starvation retry (issue #594): under the full suite's parallel file
  // execution this child can starve to an EMPTY-output termination
  // (measured: 125s wall, both streams empty) while the quiet single-file
  // rerun is green on the same tree. bootProbe retries exactly that shape
  // once; a diagnostic-bearing attempt returns immediately — a real defect
  // prints (the alpha-line drift shape dies loudly), so the retry never
  // masks one. Pins: tests/live-boot-probe.test.mjs.
  const { boot, attemptsRan, starvationRetried } = bootProbe({
    command: "dsh",
    args: ["--profile", "headless", ...patches.flatMap((p) => ["--patch", p]), "reply ok"],
    options: { timeout: 120_000, cwd, env },
  });
  const load = starvationRetried
    ? ` (attempt 1 starved to empty output and was retried once — ${attemptsRan} attempts; a STILL-empty result is box load, not the diff — issue #594)`
    : "";
  assert.notEqual(boot.status, null, `the boot probe must terminate, not hang${load}`);
  const combined = `${boot.stdout}\n${boot.stderr}`;
  assert.match(combined, /MISSING_CREDENTIAL/, `boot must reach the credential wall with every plugin loaded${load}, got: ${combined.slice(0, 800)}`);
  assert.doesNotMatch(combined, /failed to apply loader entry|does not provide an export/, "no plugin-load failure (the alpha-line drift shape)");
});
