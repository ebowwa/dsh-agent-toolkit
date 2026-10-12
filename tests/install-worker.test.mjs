// install-worker.test.mjs — hermetic tests for scripts/install-worker.sh.
//
// The deploy workflow runs this ON a factory box; these tests pin the
// deployment's security shape offline: the env file is 0600 and holds the
// values, the cron line contains NO credential, installation is
// idempotent (no duplicate cron lines), and missing env fails typed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(ROOT, "scripts", "install-worker.sh");
const GH_CRED = "ghp_INSTALLERTESTTOKEN1234567890";
const DOPPLER_CRED = "dp.st.installertest.prj.slugvalue";

const fixture = (opts = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "install-worker-test-"));
  const home = path.join(dir, "home");
  const botDir = path.join(dir, "toolkit");
  const shim = path.join(dir, "shim");
  const crontabLog = path.join(dir, "crontab-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(shim, { recursive: true });
  // toolkit dir pre-seeded with .git so the installer skips the clone
  // (offline: no network in this suite). With realGit the caller seeds a
  // REAL repo here instead (the guarded re-pin behaves differently on a
  // dirty tree — the stub git cannot construct that state).
  mkdirSync(path.join(botDir, ".git"), { recursive: true });
  // stub crontab: records installs so idempotence is observable
  const store = path.join(dir, "crontab-store");
  writeFileSync(store, "");
  writeFileSync(path.join(shim, "crontab"), `#!/usr/bin/env bash
echo "crontab $*" >> "${crontabLog}"
if [ "$1" = "-l" ]; then cat "${store}"; exit 0; fi
cat > "${store}"
`);
  chmodSync(path.join(shim, "crontab"), 0o755);
  const flockLog = path.join(dir, "flock-calls.log");
  writeFileSync(path.join(shim, "flock"), `#!/usr/bin/env bash
echo "flock $*" >> "${flockLog}"
exit 0
`);
  chmodSync(path.join(shim, "flock"), 0o755);
  const gitLog = path.join(dir, "git-calls.log");
  if (!opts.realGit) {
    writeFileSync(path.join(shim, "git"), `#!/usr/bin/env bash
echo "git $*" >> "${gitLog}"
exit 0
`);
    chmodSync(path.join(shim, "git"), 0o755);
  }
  return { dir, home, botDir, store, crontabLog, gitLog, flockLog, shim,
    env: (extra = {}) => ({
      HOME: home,
      WORKER_GH_CRED: GH_CRED,
      WORKER_DOPPLER_CRED: DOPPLER_CRED,
      WORKER_REPOS: "ebowwa/dsh-agent-toolkit ebowwa/github-activity-tracker",
      DSH_AGENT_TOOLKIT_INSTALL_DIR: botDir,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

test("installs the env file 0600 with the values; cron line has NO credential", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);

    const envFile = path.join(f.home, ".dsh-worker", "env");
    assert.ok(existsSync(envFile), "env file written");
    const mode = statSync(envFile).mode & 0o777;
    assert.equal(mode, 0o600, `env file mode must be 600 (got ${mode.toString(8)})`);
    const envBody = readFileSync(envFile, "utf8");
    assert.ok(envBody.includes(GH_CRED), "env holds the GH credential");
    assert.ok(envBody.includes(DOPPLER_CRED), "env holds the doppler credential");
    assert.match(envBody, /DSH_WORKER_REPOS="ebowwa\/dsh-agent-toolkit ebowwa\/github-activity-tracker"/);

    const cron = readFileSync(f.store, "utf8");
    assert.match(cron, /\/bin\/bash .*dsh-worker\.sh --once/, "sweep invoked via bash (scripts are mode 644 — direct exec is Permission denied)");
    // flock, never pgrep: EVERY pgrep form self-matches (the carrier's
    // cmdline contains the real script path in the sweep braces — proven
    // live twice). flock is the canonical cron mutual exclusion.
    assert.match(cron, /flock -n .*sweep\.lock/, "flock-overlapped, no pgrep self-match possible");
    assert.ok(!cron.includes("pgrep"), "no pgrep guard may ship in the keepalive");
    // issue #276: the re-pin rides the GUARDED arm, never inline git —
    // the old inline `checkout -q --force v1` destroyed in-flight agent
    // work in the shared checkout the moment drift-check advanced v1.
    assert.match(cron, /re-pin-toolkit\.sh/, "re-pin routes through the guarded arm (issue #276)");
    assert.ok(
      !/checkout [^;]*v1/.test(cron),
      "no inline force-checkout rides the cron line — scripts/re-pin-toolkit.sh owns the destructive half (the guard refuses while the tree carries live work)",
    );
    assert.match(
      cron,
      /re-pin-toolkit\.sh [^;]*>> .*worker\.log/,
      "the guard's refusal notes land in worker.log (the loud alarm)",
    );
    assert.ok(!cron.includes(GH_CRED), "NO credential in the cron line");
    assert.ok(!cron.includes(DOPPLER_CRED), "NO doppler credential in the cron line");
    // the installer's own output never echoes the values either
    assert.ok(!res.stdout.includes(GH_CRED) && !res.stderr.includes(GH_CRED), "installer output is credential-free");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("header comment names the guard the LINE arms (flock-guard, never pgrep-guard) — #292", () => {
  // Static source pin: the "What it installs" header is the first thing a
  // reader skims; it may never teach the discredited pgrep guard the cron
  // LINE replaced (every pgrep form self-matches — lines 93-99). Scoped to
  // the header block only: the flock-NOT-pgrep explanation below legitimately
  // spells "pgrep" while arguing against it.
  const src = readFileSync(INSTALLER, "utf8");
  const header = src.slice(0, src.indexOf("set -euo pipefail"));
  assert.ok(header.length > 0, "header block located in installer source");
  assert.match(header, /cron keepalive line: every minute, flock-guard, RE-PIN/,
    "the keepalive bullet labels the flock guard the LINE arms (#292)");
  assert.ok(!header.includes("pgrep-guard"),
    "the discredited pgrep-guard label never ships in the installer header");
});

test("success echo names the guard the LINE actually arms (flock-guarded, never pgrep-guarded)", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);

    // the LINE is the ground truth the echo must describe
    const cron = readFileSync(f.store, "utf8");
    assert.match(cron, /flock -n .*sweep\.lock/, "the armed LINE is flock-guarded");
    assert.ok(!cron.includes("pgrep"), "the armed LINE carries no pgrep");
    // #289: the label may never drift from the LINE again — 'pgrep-guarded'
    // is the exact phrase the 2026-09-21 self-match incident taught to
    // distrust, and it misdescribed the flock line at the moment of truth.
    assert.match(res.stdout, /cron\s+: keepalive armed \(flock-guarded, once per minute\)/,
      "the success echo labels the flock guard the LINE arms");
    assert.ok(!res.stdout.includes("pgrep-guarded"),
      "the discredited pgrep-guarded label never ships in installer output");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("idempotent: a second run does not duplicate the cron line", () => {
  const f = fixture();
  try {
    spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    const first = readFileSync(f.store, "utf8");
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /canonical line enforced/, "second run re-enforces the canonical line");
    const second = readFileSync(f.store, "utf8");
    assert.equal(second, first, "crontab unchanged by the second run");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("refreshes the toolkit pin to v1 through the guarded arm (safe.directory kept)", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /toolkit pinned at/);
    const git = readFileSync(f.gitLog, "utf8");
    assert.match(git, /fetch --tags --force/, "fetches tags every install (the guard's fetch: --force — plain fetch clobbers the moving tag)");
    assert.match(git, /checkout -q --force v1/, "checks out the moving v1 pin through the guard (only reached on a clean, non-working-branch tree — issue #276)");
    assert.match(git, /diff-index --quiet HEAD/, "the refusal gate runs before anything destructive");
    assert.match(git, /safe\.directory=/, "ownership guard explicitly satisfied");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("issue #276: a reinstall on a DIRTY shared checkout refuses the refresh and the work survives", () => {
  const f = fixture({ realGit: true });
  try {
    // a real repo standing in for the box's shared toolkit checkout,
    // with an agent's tracked-file edit in flight
    rmSync(path.join(f.botDir, ".git"), { recursive: true, force: true });
    const hermeticEnv = {
      ...process.env, // the lane's git may be the scrub shim — keep GIT_SCRUB_REAL etc.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    // issue #582/#621: spawnSync NEVER throws — a failed seed call used to
    // resolve silently, leaving this test exercising a botDir with no seeded
    // history while staying green. The seed CONSTRUCTS the fixture, so every
    // call asserts (the PR #589 gitSetup shape): non-zero exit or spawn error
    // throws with the failed argv + captured stderr.
    const gitSetup = (args) => {
      const r = spawnSync(
        "git",
        ["-C", f.botDir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
        { encoding: "utf8", env: hermeticEnv },
      );
      if (r.error || r.status !== 0) {
        throw new Error(
          `fixture setup failed: git ${args.join(" ")} (exit ${r.status ?? "?"})\n${r.error ?? r.stderr}`,
        );
      }
      return r;
    };
    gitSetup(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(path.join(f.botDir, "settings.zai.yaml"), "# template v1\n");
    gitSetup(["add", "settings.zai.yaml"]);
    gitSetup(["commit", "--quiet", "-m", "seed"]);
    writeFileSync(path.join(f.botDir, "settings.zai.yaml"), "# agent mid-edit marker DSH-276\n");

    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, "the install still lands (env + guarded cron line armed)");
    assert.match(res.stderr, /REFUSING re-pin/, "the guard's refusal is surfaced by the installer");
    assert.match(res.stderr, /guarded re-pin did not land/, "the installer names the degraded pin");
    assert.ok(!/toolkit pinned at/.test(res.stdout), "no false pin claim on a refused refresh");
    assert.equal(
      readFileSync(path.join(f.botDir, "settings.zai.yaml"), "utf8"),
      "# agent mid-edit marker DSH-276\n",
      "the mid-edit work SURVIVES the reinstall (issue #276 receipt)",
    );
    const cron = readFileSync(f.store, "utf8");
    assert.match(cron, /re-pin-toolkit\.sh/, "the armed keepalive is the guarded one — it will refuse loudly, not destroy");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("missing credentials fail typed (exit 2), nothing written", () => {
  const f = fixture();
  try {
    const env = f.env({ WORKER_GH_CRED: "" });
    const res = spawnSync("bash", [INSTALLER], { encoding: "utf8", env });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /WORKER_GH_CRED unset/);
    assert.ok(!existsSync(path.join(f.home, ".dsh-worker")), "no env dir on failure");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
