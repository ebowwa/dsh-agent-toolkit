// resolve-push-token.test.mjs — tests for scripts/resolve-push-token.sh.
//
// Regression anchor: factory PR #229 (2026-08-26). The agent-dispatch main
// checkout persisted the ephemeral GITHUB_TOKEN as the workspace git
// credential, so every agent `git push` rode github-actions[bot]. On PRs
// whose overall diff touches workflow files, GitHub parks bot-triggered
// runs in action_required (gates runs 32921795436/32924697952: created,
// never executed) — and a push that itself edits workflow files is
// rejected outright. These tests pin the resolver that rewrites the
// credential Doppler-first: which token lands in
// http.https://github.com/.extraheader, per failure mode, and the wiring
// of both reusable workflows around it. They fail without the fix: on the
// parent there is no script to run and no wiring to find.
//
// Review round 1 (request-changes) added four pins/constructions, all
// lane-independent: hermetic no-doppler PATH (finding 1), a watchdog
// bound on a hung doppler fetch (finding 4), an argv-observation pin
// that the credential never rides a child command line (finding 5), and
// a base64 shim that wraps at 76 columns on every lane so the
// wrap-strip is pinned for real (finding 6).
//
// Review round 2 (request-changes) widened the argv pin and added three
// pins: the argv log now covers curl too — round 1's pin watched only
// git while the scope probe passed `-H "Authorization: token …"` on
// curl's command line (r2 finding 1) — plus a self-sealing-append pin
// for a .git/config with no trailing newline (r2 finding 2), a pin that
// a non-numeric DOPPLER_FETCH_TIMEOUT_S cannot kill the watchdog
// (r2 finding 3), and a two-run idempotency pin (r2 finding 4).
//
// Load-tolerance round (#389, 2026-10-04): both watchdog legs dropped
// their wall-clock assertions. A stopwatch raced the box, not the code:
// the healthy leg ran 10717ms red inside a full-gate run and 5699ms
// green in isolation on the SAME tree — concurrent fleet agents are the
// normal environment on these cells, so any elapsed-ms bound is a
// load-shaped flake. The bound is now pinned by CONSTRUCTION: the shim
// hang sleeps BETWEEN the honored timeout and the script's hard-coded
// 20s default, so every unbounded/ignored class lets the fetch ANSWER,
// flipping the output to the doppler-wins shape — the typed-line and
// header pins red deterministically, at any load. A generous spawnSync
// timeout backstops the residual never-exits class with a red, never a
// suite freeze.
//
// First-exec-tax round (#404, 2026-10-04): every FIRST exec of a
// freshly-written script pays a macOS Xprotect scan — ~2.1s measured on
// this box class under concurrent load, ~6ms on the second exec of the
// same path (issue-body repro). This suite minted a FRESH shim dir per
// leg (the right collision hygiene, #346/#364), which under a loaded
// full gate queued ~60 fresh-script scans behind one pegged
// XprotectService per run and stretched the suite ~10x. Two levers, no
// hygiene regression — every dir is still a unique per-run mkdtemp
// mint, never a fixed staging path:
// 1. MINT-ONCE PER PROCESS: the canonical doppler/curl/base64 set is
//    minted lazily and shared READ-ONLY by every leg that does not
//    mutate it (the shims are pure env readers — nothing persists
//    between legs), so the suite pays ONE scan tax instead of ~one per
//    leg. Legs that MUTATE the dir (the argv-logging pin overwrites
//    git/curl; the hermetic pin removes doppler and symlinks
//    git/tr/awk/bash) mint their own private dir, so no mutation can
//    leak into a sibling leg regardless of test order.
// 2. PRE-WARM AT MINT: each fresh shim is exec'd once (one parallel
//    round, before any leg) so every leg's exec is the warm ~6ms one.
//    Best-effort by design: a pre-warm that silently no-ops only
//    degrades to the pre-#404 scan-per-leg behavior — correctness never
//    depends on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "resolve-push-token.sh");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const headerFor = (tok) => `AUTHORIZATION: basic ${b64(`x-access-token:${tok}`)}`;

// Absolute path of a tool under the FULL PATH — used to bake real
// binaries into shims (and to symlink them into hermetic bin dirs) so
// they resolve even when the resolver child's PATH carries no system dir.
const resolveBin = (name) => {
  const r = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" });
  assert.equal(r.status, 0, `cannot resolve ${name} on PATH`);
  return r.stdout.trim();
};
const BASH = resolveBin("bash");

// A PATH prefix with shims for `doppler` (sleeps DOPPLER_HANG_S first if
// set — the hung-fetch pin — then echoes DOPPLER_OUT, exits DOPPLER_RC)
// and `curl` (prints an X-OAuth-Scopes: CURL_SCOPES header, exits
// CURL_RC), plus a `base64` that ALWAYS wraps at 76 columns: real base64,
// strip its wrap, re-wrap deterministically — GNU default-wrap, BSD and
// busybox no-wrap implementations all collapse to the same input, so the
// wrap-stripping pin bites on every lane (review round-1 finding 6).
// Real git/tr/awk stay on PATH in this mode.
const dopplerShim = `#!/bin/sh
if [ -n "\${DOPPLER_HANG_S:-}" ]; then sleep "\$DOPPLER_HANG_S"; fi
if [ "\${DOPPLER_RC:-0}" != "0" ]; then exit "\$DOPPLER_RC"; fi
printf '%s' "\${DOPPLER_OUT-}"
`;
const curlShim = `#!/bin/sh
if [ "\${CURL_RC:-0}" != "0" ]; then exit "\$CURL_RC"; fi
printf 'HTTP/1.1 200 OK\\r\\nX-OAuth-Scopes: %s\\r\\n\\r\\n' "\${CURL_SCOPES-}"
`;
const base64Shim = `#!/bin/sh
${resolveBin("base64")} "$@" | tr -d '\\n' | awk '{ while (length($0) > 76) { print substr($0, 1, 76); $0 = substr($0, 77) } print }'
`;

// Every dir is a fresh mkdtemp mint — a unique per-run name, the #346/#364
// collision guarantee, never a fixed staging path (#404 acceptance 2).
const mintedShimDirs = [];
process.on("exit", () => {
  for (const dir of mintedShimDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// #404 pre-warm: exec each fresh shim once, in ONE parallel round, so the
// one-time Xprotect scan is paid here instead of inside a leg (or ~once
// per leg across the run). Best-effort: the wait status is deliberately
// not asserted — a no-op'd or failed pre-warm only degrades to the
// pre-#404 behavior, it can never flip a pin.
const prewarmShims = (dir, names = ["doppler", "curl", "base64"]) => {
  const warm = (name) => `'${path.join(dir, name)}' </dev/null >/dev/null 2>&1`;
  // Clean env: a stray ambient DOPPLER_HANG_S must not make the pre-warm
  // itself hang — the warm exec only needs PATH.
  spawnSync(BASH, ["-c", `${names.map(warm).join(" & ")} & wait`],
    { env: { PATH: process.env.PATH } });
};

const mintShims = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-push-shims-"));
  mintedShimDirs.push(dir);
  writeFileSync(path.join(dir, "doppler"), dopplerShim);
  writeFileSync(path.join(dir, "curl"), curlShim);
  writeFileSync(path.join(dir, "base64"), base64Shim);
  for (const f of ["doppler", "curl", "base64"]) chmodSync(path.join(dir, f), 0o755);
  prewarmShims(dir);
  return { dir, path: `${dir}:${process.env.PATH}` };
};

// #404 mint-once: the canonical set is IMMUTABLE across the legs that use
// it (pure env readers — no state persists between execs), so one shared
// per-process mint carries every plain leg. Mutating legs (hermetic,
// argv-logging) call mintShims() directly for their own private dir.
let sharedShims;
const shimPath = () => (sharedShims ??= mintShims());
// Fresh empty git repo = the job workspace after a persist-credentials:
// false checkout (no credential in config — that is the state the
// resolver must fill).
const freshRepo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-push-repo-"));
  const r = spawnSync("git", ["init", "-q", "."], { cwd: dir });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return dir;
};

const runResolver = (repo, envOverrides = {}, { hermetic = false, timeoutMs = 0 } = {}) => {
  // #404: plain legs share the per-process minted+pre-warmed set
  // read-only; the hermetic leg MUTATES its dir (removes doppler,
  // symlinks git/tr/awk/bash), so it takes a private mint — mutation can
  // never leak into a sibling leg. Only private dirs clean up per leg;
  // the shared dir is removed once by the process-exit hook.
  const shims = hermetic ? mintShims() : shimPath();
  if (hermetic) {
    // Review round-1 finding 1, the prescribed construction: a PATH with
    // ONLY the prepared bin dir — curl + wrapping-base64 shims and
    // git/tr/awk symlinks — and no system dir at all, so no lane image's
    // doppler (/usr/bin, /opt/homebrew/bin, ...) can leak in. The doppler
    // SHIM must come out too: hermetic means the binary is absent, not
    // stubbed — `command -v doppler` must genuinely fail.
    rmSync(path.join(shims.dir, "doppler"));
    // `bash` joins the symlink set because this lane's own `git` is the
    // dsh scrub shim — a #!/usr/bin/env bash SCRIPT — so its shebang needs
    // a findable bash even when no system dir is on PATH (on lanes whose
    // git is a plain binary the extra symlink is inert).
    for (const tool of ["git", "tr", "awk", "bash"]) {
      symlinkSync(resolveBin(tool), path.join(shims.dir, tool));
    }
  }
  const env = {
    ...process.env,
    PATH: hermetic ? shims.dir : shims.path,
    DOPPLER_SERVICE_TOKEN: "svc-token",
    PUSH_FALLBACK_CRED: "fallback-tok",
    ...envOverrides,
  };
  // Absolute bash: in hermetic mode the child's PATH has no system dirs,
  // so the executable must not be resolved through it. timeoutMs, when
  // set, is a hang BACKSTOP only (kill a resolver that never exits) —
  // never a bound pin; see the #389 note in the file header.
  const r = spawnSync(BASH, [SCRIPT],
    { cwd: repo, env, encoding: "utf8", ...(timeoutMs ? { timeout: timeoutMs } : {}) });
  return {
    r,
    cleanup: hermetic
      ? () => rmSync(shims.dir, { recursive: true, force: true })
      : () => {}, // shared dir — removed once by the exit hook
  };
};

const headerIn = (repo) =>
  spawnSync("git", ["config", "--local", "--get", "http.https://github.com/.extraheader"],
    { cwd: repo, encoding: "utf8" }).stdout.trim();

const withCase = (fn) => () => {
  const repo = freshRepo();
  try {
    fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

test("doppler token with full scopes wins (scopes ok, header = doppler token)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, {
    DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "delete_repo, gist, read:org, repo, workflow",
  });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /push-token: doppler seed\/prd \(scopes ok\)/);
    assert.equal(headerIn(repo), headerFor("doppler-pat"));
  } finally { cleanup(); }
}));

test("minimal satisfiable set (repo, workflow) still takes the doppler token", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /push-token: doppler seed\/prd \(scopes ok\)/);
    assert.equal(headerIn(repo), headerFor("doppler-pat"));
  } finally { cleanup(); }
}));

test("doppler token lacking `workflow` falls back (workflow edits would be rejected)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, read:project" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lacks: workflow/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("doppler token lacking `repo` falls back (cannot write private repos)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "gist, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lacks: repo/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("doppler fetch failure falls back (never breaks the run)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_RC: "1", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /doppler fetch failed/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("hung doppler fetch is watchdog-bounded (falls back, does not hold the job)", withCase((repo) => {
  // The doppler CLI never answers before the bound; the watchdog must cut
  // it at DOPPLER_FETCH_TIMEOUT_S and take the typed fallback — the
  // fetch-side twin of the --max-time 15 curl pin below (review round-1
  // finding 4: the fetch was the one unbounded call).
  //
  // #389 load-tolerance: NO wall-clock assertion — the old pin raced
  // `elapsed < 10s` against box load and red-shifted a HEALTHY watchdog
  // (10717ms red in-gate, 5699ms green in isolation, same tree). The
  // bound is pinned by construction instead: the shim hang (10s) sleeps
  // BETWEEN the honored timeout (1s) and the script's hard-coded 20s
  // default, so every defect class — watchdog removed, kill failed,
  // timeout env ignored in favor of the default — lets the hang ANSWER,
  // the resolver takes the doppler token (scopes ok), and the
  // typed-fallback + header pins below red DETERMINISTICALLY at any box
  // load. Only the healthy class (kill at ~1s) prints "fetch failed".
  // The 60s spawnSync backstop (far past any observed load overhead —
  // the loaded legs of this suite run ≤ ~35s) covers the residual
  // never-exits class with a red, not a suite freeze.
  const { r, cleanup } = runResolver(repo, {
    DOPPLER_HANG_S: "10", DOPPLER_FETCH_TIMEOUT_S: "1",
    DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, workflow",
  }, { timeoutMs: 60_000 });
  try {
    assert.equal(r.status, 0,
      `resolver status=${r.status} signal=${r.signal ?? "none"} — either it failed or the 60s hang backstop fired; stderr=${r.stderr}`);
    assert.match(r.stdout, /doppler fetch failed/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("credential never appears on any child argv (ps-safe on shared runners)", withCase((repo) => {
  // Review round-1 finding 5: the round-1 write_header passed the whole
  // header as a `git config` ARGUMENT — argv is ps//proc readable by any
  // concurrent job under the same runner service account. GIT_BIN points
  // at a shim that logs every git argv then execs the real git: if the
  // value ever rides an argument again, the log catches it.
  //
  // Review round-2 finding 1 widened the pin: curl is shimmed to log its
  // argv too. Round 1's scope probe passed `-H "Authorization: token …"`
  // on curl's command line — the exact exposure the test name denies —
  // while this pin observed only GIT_BIN calls and stayed green. Now the
  // header travels in a 0600 mktemp curl --config file, and any leak
  // through git OR curl argv trips the assertions below.
  const logDir = mkdtempSync(path.join(tmpdir(), "resolve-push-argv-"));
  const gitLog = path.join(logDir, "git-argv.log");
  const curlLog = path.join(logDir, "curl-argv.log");
  // This leg MUTATES the shim set (logging git + logging curl variants),
  // so it takes a private #404 mint — the shared per-process set stays
  // untouched for the canonical legs.
  const shims = mintShims();
  const gitShim = `#!/bin/sh
printf '%s\\n' "\$*" >> ${JSON.stringify(gitLog)}
exec ${resolveBin("git")} "\$@"
`;
  writeFileSync(path.join(shims.dir, "git"), gitShim);
  chmodSync(path.join(shims.dir, "git"), 0o755);
  // Logs argv, then answers like the base curl shim. It must NOT exec
  // the real curl — this suite is offline by contract.
  const curlShim = `#!/bin/sh
printf '%s\\n' "\$*" >> ${JSON.stringify(curlLog)}
if [ "\${CURL_RC:-0}" != "0" ]; then exit "\${CURL_RC}"; fi
printf 'HTTP/1.1 200 OK\\r\\nX-OAuth-Scopes: %s\\r\\n\\r\\n' "\${CURL_SCOPES-}"
`;
  writeFileSync(path.join(shims.dir, "curl"), curlShim);
  chmodSync(path.join(shims.dir, "curl"), 0o755);
  const env = {
    ...process.env,
    PATH: shims.path,
    DOPPLER_SERVICE_TOKEN: "svc-token",
    PUSH_FALLBACK_CRED: "fallback-tok",
    GIT_BIN: path.join(shims.dir, "git"),
    DOPPLER_OUT: "doppler-pat",
    CURL_SCOPES: "repo, workflow",
  };
  const r = spawnSync(BASH, [SCRIPT], { cwd: repo, env, encoding: "utf8" });
  const redact = (line) => line.replace(/doppler-pat/g, "<tok>").replace(/basic \S.*/, "basic <redacted>");
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(headerIn(repo), headerFor("doppler-pat"));
    const argvByTool = [
      ["git", readFileSync(gitLog, "utf8")],
      ["curl", readFileSync(curlLog, "utf8")],
    ];
    assert.match(argvByTool[0][1], /rev-parse --git-dir/, "git must run through the shim — otherwise this pin is vacuous");
    assert.match(argvByTool[1][1], /--config/, "curl must run through the shim and take its header by --config — otherwise this pin is vacuous");
    for (const [tool, log] of argvByTool) {
      for (const line of log.split("\n")) {
        assert.ok(!/authorization/i.test(line), `${tool} argv leaked the probe header: ${redact(line)}`);
        assert.ok(!line.includes("doppler-pat"), `${tool} argv leaked the token value: ${redact(line)}`);
        assert.ok(!/basic /.test(line), `${tool} argv leaked the header value: ${redact(line)}`);
      }
    }
  } finally {
    rmSync(shims.dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
}));

test("append self-seals a .git/config whose last line lacks a trailing newline", withCase((repo) => {
  // Review r2 finding 2: when the key is absent, --unset-all is a no-op
  // and does not normalize the file — a non-git writer can leave the
  // final line unterminated, and a bare append then fuses the [http …]
  // section header onto it, after which git refuses the config. The
  // write_header printf starts with a blank line so the stanza always
  // begins on a fresh line; a stray blank line in a git config is
  // harmless.
  const cfgPath = path.join(repo, ".git", "config");
  writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/\n$/, ""));
  const { r, cleanup } = runResolver(repo, { DOPPLER_SERVICE_TOKEN: "" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no doppler cli\/service token/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("non-numeric DOPPLER_FETCH_TIMEOUT_S still bounds the fetch (watchdog survives a bad env)", withCase((repo) => {
  // Review r2 finding 3: a bad timeout must not kill the watchdog and
  // resurrect the unbounded fetch. Precision on the mechanism: the
  // set-but-EMPTY case is already absorbed by `${VAR:-20}` (the colon
  // form covers null too) — the value that genuinely slips through is a
  // NON-NUMERIC one: `sleep "abc"` fails instantly, the watchdog
  // subshell dies silently, and a hung fetch is unbounded again. So the
  // pin rides "abc" — the case `:-` alone lets through — and asserts
  // the guard's 20s default still fires: the doppler shim sleeps far
  // past 20, so the ONLY bounded outcome is the watchdog kill + typed
  // fallback.
  //
  // #389 load-tolerance: the old `< 30_000` stopwatch shared the
  // 10717ms-class box-load red-shift — healthy legs of this wall-clock
  // shape ran 17–34s under full-gate load on this box class, so a
  // healthy 20s default + load overhead could cross 30s. The pin no
  // longer races: the hang OUTLASTS the 20s default, and the defect
  // class it guards (guard removed → `sleep abc` dies → no watchdog)
  // lets the hang ANSWER, flipping the output to the doppler-wins
  // shape — the typed-fallback + header pins below red
  // deterministically.
  //
  // #450 differential widening: outcome ordering only proves the bound
  // if the two kernel timers cannot INVERT under load — timer expiry is
  // processed late under contention, so the hang must outlast the kill
  // by more than any plausible differential scheduler slip. The #389
  // geometry (40s vs 20s) left 20s of margin while the #450 receipt
  // measured a bare `sleep 15` at 22s wall (~7s slip) under live
  // sibling load, so this leg rides 60s vs the 20s default — 40s of
  // differential. Failure direction is safe: the inversion can only
  // ever false-RED (visible), never false-green. Green runs pay
  // nothing — the kill still fires at ~20s + overhead; only the defect
  // path waits out the full hang (~60s), which is why this leg's
  // spawnSync backstop is 120s: the defect-path completion lands well
  // inside it, so the backstop only ever fires on a resolver that
  // never exits and the fallback-path asserts below stay the sole
  // oracle.
  const { r, cleanup } = runResolver(repo, {
    DOPPLER_HANG_S: "60", DOPPLER_FETCH_TIMEOUT_S: "abc",
    DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, workflow",
  }, { timeoutMs: 120_000 });
  try {
    assert.equal(r.status, 0,
      `resolver status=${r.status} signal=${r.signal ?? "none"} — either it failed or the 120s hang backstop fired; stderr=${r.stderr}`);
    assert.match(r.stdout, /doppler fetch failed/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("resolver is idempotent: a second run replaces the stanza, never stacks it", withCase((repo) => {
  // Review r2 finding 4: the idempotency claim (--unset-all first, one
  // stanza) was unpinned — a coverage gap, not a bug. Two runs, the
  // second resolving a DIFFERENT credential, must leave exactly one
  // value: the latest. --get-all (not --get) so a stacked duplicate
  // cannot hide behind first-match semantics.
  const runs = [
    runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "repo, workflow" }),
    runResolver(repo, { DOPPLER_SERVICE_TOKEN: "" }),
  ];
  try {
    assert.equal(runs[0].r.status, 0, runs[0].r.stderr);
    assert.equal(runs[1].r.status, 0, runs[1].r.stderr);
    const all = spawnSync("git", ["config", "--local", "--get-all", "http.https://github.com/.extraheader"],
      { cwd: repo, encoding: "utf8" });
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(all.stdout.trim().split("\n"), [headerFor("fallback-tok")]);
  } finally {
    for (const run of runs) run.cleanup();
  }
}));

test("doppler config without GITHUB_TOKEN falls back", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /has no GITHUB_TOKEN/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("no doppler CLI on the runner falls back (hermetic PATH — lanes ship a system doppler)", withCase((repo) => {
  // Hermetic absence (review round-1 finding 1): PATH contains ONLY the
  // prepared bin dir — curl + wrapping-base64 shims, git/tr/awk symlinks
  // — so no system dir and no lane's real doppler can be found. No seam
  // involved: this pins the actual `command -v doppler` path production
  // takes (round 2's DOPPLER_BIN seam is gone from the script).
  const { r, cleanup } = runResolver(repo, { CURL_SCOPES: "repo, workflow" }, { hermetic: true });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no doppler cli\/service token/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("no DOPPLER_SERVICE_TOKEN secret falls back", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_SERVICE_TOKEN: "", CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no doppler cli\/service token/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("hung scope probe (curl exit 28) falls back without failing the job", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_RC: "28" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /scope probe failed/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("probe answer without scopes header falls back (token invalid)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: "doppler-pat", CURL_SCOPES: "" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /token invalid/);
    assert.equal(headerIn(repo), headerFor("fallback-tok"));
  } finally { cleanup(); }
}));

test("missing fallback credential fails loud (never silently unauthenticated)", withCase((repo) => {
  const { r, cleanup } = runResolver(repo, { PUSH_FALLBACK_CRED: "", DOPPLER_RC: "1" });
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no fallback credential supplied/);
  } finally { cleanup(); }
}));

test("long token lands single-line (BSD base64 76-col wrap must not break the header)", withCase((repo) => {
  // The shimmed base64 ALWAYS wraps at 76 columns (see shimPath), so
  // deleting the wrap-strip fails this pin on EVERY lane — Linux/GNU
  // included — not just the BSD mac cells the name came from
  // (review round-1 finding 6: with the system base64 the pin was
  // vacuous wherever GNU default-wrap happened to match).
  const longTok = `doppler-${"x".repeat(120)}`;
  const { r, cleanup } = runResolver(repo, { DOPPLER_OUT: longTok, CURL_SCOPES: "repo, workflow" });
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(headerIn(repo), headerFor(longTok));
  } finally { cleanup(); }
}));

// The in-job entry-point wiring guards (persist-credentials false +
// resolver-before-agent on agent-comment.yml / agent-dispatch.yml) retired
// WITH their surfaces: both workflows are removed (issue #264) and the
// removal itself is pinned in tests/decouple-structure.test.mjs. The
// worker-side guard (abort_item on a failed push-credential write) is
// pinned there too — the worker is the only pusher left.
