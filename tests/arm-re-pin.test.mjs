// arm-re-pin.test.mjs — hermetic tests for scripts/arm-re-pin.sh
// (FleetTower issue #2109).
//
// install-worker.sh arms the re-pin keepalive only when it runs — the
// provisioning path of a lane box. The Hermes-profile macOS cells spawn
// sessions from the standing driver and never run that installer, so
// nothing moves their deployed checkout forward (the #2109 receipt:
// air16's checkout sat 221 commits / ~11 days behind and kept installing
// the pre-#251 git-scrub-shim). The arm script arms ONLY the guarded
// re-pin — OS-appropriately, launchd on darwin / markered cron on linux,
// no worker sweep, no credentials. These tests pin: the unit shape (no
// credential ever lands in the plist or the cron line, the re-pin is
// invoked via /bin/bash, no inline git in the schedule), idempotent
// re-arming (no duplicate units/lines, bootout before re-bootstrap),
// typed refusals (not a checkout, pre-#276 pin without the guarded arm,
// cron-inexpressible interval, missing flock), and the first-pin verdict
// reporting against a REAL git fixture (clean → landed; dirty → the arm
// stays green and the refusal prints loud).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "arm-re-pin.sh");

// Hermetic-but-ambient git env (see re-pin-toolkit.test.mjs: the lane's
// PATH git may be the driver's scrub shim resolving GIT_SCRUB_REAL — a
// stripped env kills every git call here).
const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd, args) =>
  spawnSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    env: HERMETIC_ENV,
  });

const commitFile = (cwd, name, body) => {
  writeFileSync(path.join(cwd, name), body);
  git(cwd, ["add", name]);
  return git(cwd, ["commit", "-m", `add ${name}`]);
};

/**
 * A toolkit checkout carrying the guarded re-pin arm: a bare origin
 * (main at A, tag v1 → A) plus a clean detached-at-v1 clone — the
 * steady state the arm's first pin reports on. `dirty()` marks a tracked
 * file so the guarded re-pin must REFUSE (exit 3, arm still green).
 */
const toolkitFixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "arm-re-pin-test-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const box = path.join(dir, "toolkit");
  mkdirSync(seed, { recursive: true });
  git(seed, ["init", "--quiet", "--initial-branch=main"]);
  commitFile(seed, "settings.zai.yaml", "# template v1\n");
  git(seed, ["clone", "--quiet", "--bare", ".", origin]);
  git(seed, ["push", "--quiet", origin, "main"]);
  git(seed, ["tag", "v1"]);
  git(seed, ["push", "--quiet", origin, "v1"]);
  spawnSync("git", ["clone", "--quiet", origin, box], { encoding: "utf8", env: HERMETIC_ENV });
  git(box, ["checkout", "--quiet", "v1"]);
  mkdirSync(path.join(box, "scripts"), { recursive: true });
  // the REAL guarded re-pin arm from this tree — the first-pin verdict
  // tests exercise its refusal gates (a stub would always exit 0)
  writeFileSync(path.join(box, "scripts", "re-pin-toolkit.sh"), readFileSync(path.join(ROOT, "scripts", "re-pin-toolkit.sh"), "utf8"));
  chmodSync(path.join(box, "scripts", "re-pin-toolkit.sh"), 0o755);
  return {
    dir, origin, box,
    dirty: () => writeFileSync(path.join(box, "settings.zai.yaml"), "# drifted\n"),
  };
};

/**
 * System shims: launchctl + crontab record their calls; flock exits 0.
 * launchctl's bootstrap fails exactly once when the `fail-first` marker
 * file exists (the already-loaded EEXIST path — bootout must precede the
 * retry). crontab reads/writes a store file so idempotence is observable.
 */
const shimFixture = (opts = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "arm-re-pin-shim-"));
  const home = path.join(dir, "home");
  const shim = path.join(dir, "shim");
  const launchctlLog = path.join(dir, "launchctl-calls.log");
  const crontabLog = path.join(dir, "crontab-calls.log");
  const store = path.join(dir, "crontab-store");
  mkdirSync(home, { recursive: true });
  mkdirSync(shim, { recursive: true });
  writeFileSync(store, "");
  writeFileSync(path.join(shim, "launchctl"), `#!/usr/bin/env bash
echo "launchctl $*" >> "${launchctlLog}"
[ -f "${dir}/fail-first" ] && [ ! -f "${dir}/fail-first.consumed" ] && touch "${dir}/fail-first.consumed" && exit 1
exit 0
`);
  chmodSync(path.join(shim, "launchctl"), 0o755);
  writeFileSync(path.join(shim, "crontab"), `#!/usr/bin/env bash
echo "crontab $*" >> "${crontabLog}"
if [ "$1" = "-l" ]; then cat "${store}"; exit 0; fi
cat > "${store}"
`);
  chmodSync(path.join(shim, "crontab"), 0o755);
  if (!opts.noFlock) {
    writeFileSync(path.join(shim, "flock"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(path.join(shim, "flock"), 0o755);
  }
  return { dir, home, shim, launchctlLog, crontabLog, store };
};

const runArm = (args, env) =>
  spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...HERMETIC_ENV, ...env },
  });

const darwinEnv = (f, over = {}) => ({
  HOME: f.home,
  PATH: `${f.shim}:${process.env.PATH}`,
  DSH_ARM_RE_PIN_OS: "darwin",
  DSH_ARM_RE_PIN_PLIST_DIR: path.join(f.home, "Library", "LaunchAgents"),
  ...over,
});

const linuxEnv = (f, over = {}) => ({
  HOME: f.home,
  PATH: `${f.shim}:${process.env.PATH}`,
  DSH_ARM_RE_PIN_OS: "linux",
  ...over,
});

test("darwin arm mints the launchd unit and bootstraps it — no credential, re-pin via /bin/bash, no inline git", () => {
  const tk = toolkitFixture();
  const f = shimFixture();
  const r = runArm([tk.box], darwinEnv(f));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const plistDir = path.join(f.home, "Library", "LaunchAgents");
  const plists = readdirSync(plistDir).filter((n) => n.endsWith(".plist"));
  assert.deepEqual(plists, ["com.dsh.re-pin.plist"], "exactly the default-label unit");
  const plist = readFileSync(path.join(plistDir, "com.dsh.re-pin.plist"), "utf8");
  assert.match(plist, /<key>Label<\/key><string>com\.dsh\.re-pin<\/string>/);
  assert.match(plist, /<string>\/bin\/bash<\/string>/, "re-pin invoked via /bin/bash");
  assert.match(plist, new RegExp(`<string>${tk.box.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/scripts\\/re-pin-toolkit\\.sh</string>`));
  assert.match(plist, /<key>StartInterval<\/key><integer>3600<\/integer>/, "hourly default");
  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.doesNotMatch(plist, /ghp_|dp\.st\.|token|credential/i, "no credential-shaped string in the unit");
  assert.doesNotMatch(plist, /\bgit\b/, "no inline git in the unit — the guarded arm owns the re-pin");
  const log = readFileSync(f.launchctlLog, "utf8").trim().split("\n");
  assert.equal(
    log.some((l) => l.startsWith("launchctl bootstrap gui/") && l.endsWith(`${plistDir}/com.dsh.re-pin.plist`)),
    true,
    `bootstrap call recorded — got: ${log}`,
  );
  assert.equal(r.stdout.includes("armed (darwin launchd)"), true);
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("darwin re-arm is idempotent: bootout precedes the re-bootstrap, one unit file", () => {
  const tk = toolkitFixture();
  const f = shimFixture();
  writeFileSync(path.join(f.dir, "fail-first"), "bootstrap will EEXIST\n");
  const plistDir = path.join(f.home, "Library", "LaunchAgents");
  const r1 = runArm([tk.box], darwinEnv(f));
  assert.equal(r1.status, 0, `first arm stderr: ${r1.stderr}`);
  const r2 = runArm([tk.box, "--label", "com.dsh.re-pin"], darwinEnv(f));
  assert.equal(r2.status, 0, `re-arm stderr: ${r2.stderr}`);
  const log = readFileSync(f.launchctlLog, "utf8");
  const bootouts = log.split("\n").filter((l) => l.includes("bootout gui/"));
  assert.equal(bootouts.length, 1, `exactly one bootout before the retry — got: ${bootouts}`);
  const plists = readdirSync(plistDir).filter((n) => n.endsWith(".plist"));
  assert.deepEqual(plists, ["com.dsh.re-pin.plist"], "re-arm replaced, not duplicated");
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("darwin arm honors --interval and --label overrides", () => {
  const tk = toolkitFixture();
  const f = shimFixture();
  const r = runArm([tk.box, "--interval", "900", "--label", "com.dsh.re-pin.test"], darwinEnv(f));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const plist = readFileSync(path.join(f.home, "Library", "LaunchAgents", "com.dsh.re-pin.test.plist"), "utf8");
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("linux arm installs exactly one markered cron line; re-arm does not duplicate; --interval maps onto the schedule", () => {
  const tk = toolkitFixture();
  const f = shimFixture();
  const r1 = runArm([tk.box], linuxEnv(f));
  assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
  let store = readFileSync(f.store, "utf8");
  let lines = store.split("\n").filter((l) => l.includes("# dsh-re-pin (arm-re-pin.sh)"));
  assert.equal(lines.length, 1, `one markered line — got: ${lines}`);
  assert.match(lines[0], /^0 \* \* \* \* flock -n /, "hourly default schedule");
  assert.match(lines[0], new RegExp(`/bin/bash \\S*/scripts/re-pin-toolkit\\.sh ${tk.box.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.doesNotMatch(lines[0], /ghp_|dp\.st\.|token|credential/i, "no credential in the cron line");
  assert.doesNotMatch(lines[0], / checkout /, "no inline git checkout in the line — the guarded arm owns it");

  const r2 = runArm([tk.box, "--interval", "120"], linuxEnv(f));
  assert.equal(r2.status, 0, `re-arm stderr: ${r2.stderr}`);
  store = readFileSync(f.store, "utf8");
  lines = store.split("\n").filter((l) => l.includes("# dsh-re-pin (arm-re-pin.sh)"));
  assert.equal(lines.length, 1, `re-arm replaced, not duplicated — got: ${lines}`);
  assert.match(lines[0], /^\*\/2 \* \* \* \* /, "--interval 120 maps to every 2 minutes");

  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("linux arm fails typed when flock is missing (exit 3, the installer's typed provisioning failure)", () => {
  const tk = toolkitFixture();
  const f = shimFixture({ noFlock: true });
  // The shim dir is the ONLY PATH entry: a Linux cell carries a real
  // system flock further down the ambient PATH (the CI red that shaped
  // this pin), so "missing" must mean absent from the whole search path
  // the script sees — not merely absent from the shim dir.
  const r = runArm([tk.box], { ...linuxEnv(f), PATH: f.shim });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /flock \(util-linux\) required/);
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("linux arm refuses a cron-inexpressible interval (not a multiple of 60)", () => {
  const tk = toolkitFixture();
  const f = shimFixture();
  const r = runArm([tk.box, "--interval", "90"], linuxEnv(f));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not expressible in cron/);
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("typed refusals: not a git checkout; a pre-#276 checkout without the guarded arm", () => {
  const f = shimFixture();
  const bare = mkdtempSync(path.join(tmpdir(), "arm-re-pin-nogit-"));
  const r1 = runArm([bare], darwinEnv(f));
  assert.equal(r1.status, 2);
  assert.match(r1.stderr, /not a git checkout/);

  const tk = toolkitFixture();
  rmSync(path.join(tk.box, "scripts", "re-pin-toolkit.sh"));
  const r2 = runArm([tk.box], darwinEnv(f));
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /no scripts\/re-pin-toolkit\.sh/);
  assert.match(r2.stderr, /v1 >= c173b02|install-worker\.sh/, "names the cure");
  assert.equal(existsSync(path.join(f.home, "Library", "LaunchAgents", "com.dsh.re-pin.plist")), false, "nothing minted on refusal");

  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

test("first-pin verdict: a clean checkout lands (exit 0 reported, arm green)", () => {
  const tk = toolkitFixture();
  const f = shimFixture();
  const r = runArm([tk.box], linuxEnv(f));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /first pin landed/);
  assert.match(r.stdout, /at v1/, "reports the pin the checkout sits at");
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});

test("first-pin verdict: a dirty checkout REFUSES loud but the arm stays green (exit 0)", () => {
  const tk = toolkitFixture();
  tk.dirty();
  const f = shimFixture();
  const r = runArm([tk.box], linuxEnv(f));
  assert.equal(r.status, 0, "a refused first pin does not fail the arm");
  assert.match(r.stderr, /first pin REFUSED/, "the refusal prints loud");
  assert.match(r.stderr, /issue #276/, "cites the guard's contract");
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(tk.dir, { recursive: true, force: true });
});
