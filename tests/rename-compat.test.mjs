// rename-compat.test.mjs — the dsh-bot → dsh-agent-toolkit rename must not
// break the surfaces that adopt it AUTOMATICALLY.
//
// Regression anchor: drift-check runs 34802626503 / 34803136038 (BLOCK).
// PR #87 renamed the env contract (DSH_BOT_DIR → DSH_AGENT_TOOLKIT_DIR), the
// reusable-workflow input (dsh-bot-ref → dsh-agent-toolkit-ref), the
// installer var, and the driver's cell-bin prefix — and #89 fixed the $1
// unbound-variable regression in the gh PATH guards. What remained blocking
// was the COMPAT surface: the worker fleet's cron sweep adopts the moving v1
// tag and sources its EXISTING env file, so a bare rename exits 2 on every
// deployed box within one cron minute of the tag advancing. These tests pin
// the loud-shim contract: the retired names keep working with a stderr
// warning, and the fail-closed behavior (exit 2 / `:?`) is preserved when
// NEITHER name is set. Revert the shims and this suite goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");
const POST_REPLY = path.join(ROOT, "scripts", "post-reply.sh");
const SHIPPER = path.join(ROOT, "scripts", "ship-changes.sh");
const INSTALLER = path.join(ROOT, "scripts", "install-worker.sh");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

// Base child env: inherit the AMBIENT environment minus every DSH_* var, so
// machine-specific toolchain shims (e.g. a PATH-mounted git wrapper and its
// GIT_SCRUB_REAL target) keep working here AND on a clean CI cell, while no
// ambient DSH_* state can masquerade as the contract under test.
const baseEnv = (extra = {}) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("DSH_")) delete env[k];
  return { ...env, ...extra };
};

test("worker: an env file with only the retired DSH_BOT_DIR still sweeps (exit 0), loudly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-worker-"));
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
case " $* " in
  *"issues?state=open"*) exit 0 ;;   # empty queue
  *) exit 0 ;;
esac
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  try {
    const res = spawnSync("bash", [WORKER, "--once"], {
      encoding: "utf8",
      env: {
        GH_TOKEN: "fake-token",
        DSH_BOT_DIR: ROOT, // the retired name — the deployed env files' shape
        DSH_WORKER_REPOS: "owner/repo",
        DSH_WORKER_DATA_ROOT: path.join(dir, "data"),
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(res.status, 0,
      `retired env name must be shimmed, not fatal (got exit ${res.status}):\n${res.stderr}`);
    assert.match(res.stdout, /polling owner\/repo for label 'dsh\/queued'/);
    assert.match(res.stderr, /DSH_BOT_DIR is retired/, "the shim must warn loud, never silent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker: NEITHER name set still fails typed (exit 2) — the shim never loosens the contract", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-worker-"));
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  try {
    const res = spawnSync("bash", [WORKER, "--once"], {
      encoding: "utf8",
      env: {
        GH_TOKEN: "fake-token",
        DSH_WORKER_REPOS: "owner/repo",
        DSH_WORKER_DATA_ROOT: path.join(dir, "data"),
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /DSH_AGENT_TOOLKIT_DIR unset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-reply: only the retired DSH_BOT_DIR set still composes the reply (exit 0), loudly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-reply-"));
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  try {
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8",
      env: {
        GH_TOKEN: "fake-token",
        DSH_SHIP_REPO: "owner/repo",
        TARGET_KIND: "issue",
        TARGET_NUM: "42",
        DSH_BOT_DIR: ROOT, // retired name only
        DSH_SHIP_CACHE: dir,
        DSH_AGENT_OUTPUT: path.join(dir, "dsh-agent-output.txt"),
        DSH_SHIP_NOTE: "shipped [branch](https://github.com/owner/repo/pull/999)",
        DSH_RUN_ID: "run123",
        DSH_RUNNER_NAME: "worker-t",
        DSH_REPLY_OUT: path.join(dir, "reply.md"),
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(res.status, 0,
      `retired env name must be shimmed, not fatal (got exit ${res.status}):\n${res.stderr}`);
    assert.match(readFileSync(path.join(dir, "reply.md"), "utf8"), /shipped/);
    assert.match(res.stderr, /DSH_BOT_DIR is retired/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-reply: NEITHER name set still fails closed naming the required var", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-reply-"));
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(path.join(shim, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  try {
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8",
      env: {
        GH_TOKEN: "fake-token",
        DSH_SHIP_REPO: "owner/repo",
        TARGET_KIND: "issue",
        TARGET_NUM: "42",
        DSH_SHIP_CACHE: dir,
        DSH_AGENT_OUTPUT: path.join(dir, "dsh-agent-output.txt"),
        DSH_SHIP_NOTE: "shipped",
        DSH_RUN_ID: "run123",
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DSH_AGENT_TOOLKIT_DIR unset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shipper: only the retired DSH_BOT_DIR set still ships + opens the PR (exit 0), loudly", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-ship-"));
  const bare = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  git(["init", "--bare", "-q", bare], { cwd: dir });
  git(["init", "-q", work]);
  git(["config", "user.name", "tester"], { cwd: work });
  git(["config", "user.email", "tester@example.com"], { cwd: work });
  writeFileSync(path.join(work, "a.txt"), "base content\n");
  git(["add", "a.txt"], { cwd: work });
  git(["commit", "-q", "-m", "base"], { cwd: work });
  git(["remote", "add", "origin", bare], { cwd: work });
  git(["push", "-q", "-u", "origin", "master"], { cwd: work });
  const head = git(["rev-parse", "HEAD"], { cwd: work }).stdout.trim();
  const ghLog = path.join(dir, "gh.log");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
case " $* " in
  *" pr create "*) echo "https://github.com/owner/repo/pull/999" ;;
  *" --json number "*) echo 99 ;;
  *" --json state "*) echo OPEN ;;
  *) exit 0 ;;
esac
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  try {
    writeFileSync(path.join(dir, "dsh-before-sha"), head);
    writeFileSync(path.join(dir, "dsh-before-dsh-branches"), "");
    writeFileSync(path.join(dir, "dsh-before-open-prs"), "");
    writeFileSync(path.join(dir, "dsh-agent-output.txt"), "done — fixed the bug\n");
    writeFileSync(path.join(work, "a.txt"), "base content\nagent changed it\n");
    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8",
      env: baseEnv({
        GH_TOKEN: "fake-token",
        DSH_SHIP_REPO: "owner/repo",
        DSH_RUN_ID: "testrun",
        DSH_RUN_ATTEMPT: "1",
        DSH_WORKTREE: work,
        DSH_BOT_DIR: ROOT, // retired name only
        DSH_SHIP_CACHE: dir,
        DSH_AGENT_OUTPUT: path.join(dir, "dsh-agent-output.txt"),
        DSH_SHIP_NOTE_FILE: path.join(dir, "ship-note.txt"),
        DSH_PR_NUM_FILE: path.join(dir, "pr-num"),
        DSH_TASK_TITLE: "task title",
        REVIEW_WORKFLOW: "",
        GH_LOG: ghLog,
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      }),
    });
    assert.equal(res.status, 0,
      `retired env name must be shimmed, not fatal (got exit ${res.status}):\n${res.stderr}`);
    assert.match(readFileSync(ghLog, "utf8"), /pr create/);
    assert.match(res.stderr, /DSH_BOT_DIR is retired/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shipper: NEITHER name set still fails closed naming the required var", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-ship-"));
  const work = path.join(dir, "work");
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  git(["init", "-q", work]);
  writeFileSync(path.join(shim, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  try {
    const res = spawnSync("bash", [SHIPPER], {
      encoding: "utf8",
      env: baseEnv({
        GH_TOKEN: "fake-token",
        DSH_SHIP_REPO: "owner/repo",
        DSH_RUN_ID: "testrun",
        DSH_RUN_ATTEMPT: "1",
        DSH_WORKTREE: work,
        DSH_SHIP_CACHE: dir,
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      }),
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DSH_AGENT_TOOLKIT_DIR unset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer: DSH_BOT_INSTALL_DIR lands on the EXISTING checkout — never a second clone", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-install-"));
  const home = path.join(dir, "home");
  const toolkit = path.join(dir, "toolkit");
  const shim = path.join(dir, "shim");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(toolkit, ".git"), { recursive: true });
  mkdirSync(shim, { recursive: true });
  const gitLog = path.join(dir, "git-calls.log");
  writeFileSync(path.join(shim, "git"), `#!/usr/bin/env bash
echo "git $*" >> "${gitLog}"
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "git")]);
  writeFileSync(path.join(shim, "crontab"), "#!/usr/bin/env bash\nif [ \"$1\" = \"-l\" ]; then printf ''; exit 0; fi\ncat >/dev/null\n");
  spawnSync("chmod", ["+x", path.join(shim, "crontab")]);
  writeFileSync(path.join(shim, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  spawnSync("chmod", ["+x", path.join(shim, "flock")]);
  try {
    const res = spawnSync("bash", [INSTALLER], {
      encoding: "utf8",
      env: {
        HOME: home,
        WORKER_GH_CRED: "ghp_TESTTOKEN00000000000000000000000",
        WORKER_DOPPLER_CRED: "dp.st.test.prj.slugvalue",
        WORKER_REPOS: "owner/repo",
        DSH_BOT_INSTALL_DIR: toolkit, // retired name; new name absent
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(res.status, 0,
      `retired install var must be honored (got exit ${res.status}):\n${res.stderr}`);
    // the env file must point at the EXISTING checkout, under the NEW name
    // (the installer quotes its writes — allow optional quotes)
    const envFile = readFileSync(path.join(home, ".dsh-worker", "env"), "utf8");
    const esc = toolkit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(envFile, new RegExp(`DSH_AGENT_TOOLKIT_DIR="?${esc}"?`));
    assert.match(res.stderr, /DSH_BOT_INSTALL_DIR is retired/);
    // and it must NOT have cloned a second checkout beside it
    const log = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
    assert.ok(!/\bclone\b/.test(log), `installer must adopt the existing checkout, not clone:\n${log}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driver: the cell-bin probe default still probes the LEGACY prefix (same dual fallback as the gh guards)", () => {
  const src = read("scripts", "run-dsh-agent.sh");
  const line = src.split("\n").find((l) => l.includes('CELL_PROBE_DIRS="${CELL_PROBE_DIRS:-'));
  assert.ok(line, "CELL_PROBE_DIRS default line must exist");
  assert.match(line, /^\s*CELL_PROBE_DIRS="\$\{CELL_PROBE_DIRS:-\$CELL_BIN /,
    "the new persistent prefix ($CELL_BIN) must be probed first");
  assert.match(line, /\.dsh-bot-bin/,
    "cells provisioned into the legacy prefix must be found without re-provisioning over the network");
});

test("workflows: dsh-bot-ref stays a declared alias and every checkout resolves it", () => {
  for (const wf of ["agent-comment.yml", "agent-dispatch.yml", "agent-review.yml"]) {
    const text = read(".github", "workflows", wf);
    assert.match(text, /^\s{6}dsh-bot-ref:\s*$/m, `${wf} must still declare the retired input name`);
    assert.match(text, /inputs\.dsh-agent-toolkit-ref \|\| inputs\.dsh-bot-ref \|\|/,
      `${wf} checkout must fall back to the retired name before its default`);
  }
  const thin = read(".github", "workflows", "agent-dispatch-thin.yml");
  assert.match(thin, /dsh-agent-toolkit-ref:/);
  assert.match(thin, /dsh-bot-ref:/, "the no-op compat input surface must carry BOTH names");
});
