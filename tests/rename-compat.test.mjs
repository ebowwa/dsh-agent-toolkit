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
import { copyFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
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

// --- the COMPOSED worker→child legacy path (review round on this PR) -------
//
// The worker-level shim resolves the retired name and then spawns
// ship-changes.sh / post-reply.sh / review-pr.sh WITHOUT re-stating the dir
// in those invocations' env-prefixes — the children can only inherit the
// resolution if the worker EXPORTS it. A plain shell variable never crosses
// a process boundary, so the ONLY way the legacy name reaches the worker is
// the deployed cron shape (`set -a; . env; set +a` — install-worker.sh) —
// which exports the retired name to the children too. Before the worker-side
// `export`, that composed path still completed (every child re-derived the
// dir from the retired name through its own shim, printing its own warning);
// what was broken was the CONTRACT: the children depended on the retired
// name propagating, not on the worker's resolution. These tests pin both
// halves: the worker's shim must EXPORT the resolution (source pin + env
// probes on every child hop), and the composed legacy pipeline must run
// end-to-end through the REAL child scripts.

// This lane's `git` may be the dsh scrub shim (a script whose shebang needs
// PATH); the composed fixture bakes the REAL git into its PATH shim so the
// shim's passthrough arm cannot recurse through itself.
const REAL_GIT = process.env.GIT_SCRUB_REAL || "/usr/bin/git";
const BASH = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();

test("worker composed: a legacy-only env file still drives ship→reply→review, and the shim's resolution travels to every child — the worker's shim must export it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-composed-"));
  const bare = path.join(dir, "origin.git");
  const shims = path.join(dir, "shim");
  const toolkit = path.join(dir, "toolkit"); // what the retired name points at
  const data = path.join(dir, "data");
  const probes = path.join(dir, "probes");
  const ghLog = path.join(dir, "gh.log");
  mkdirSync(shims, { recursive: true });
  mkdirSync(path.join(toolkit, "scripts"), { recursive: true });
  mkdirSync(probes, { recursive: true });

  // Fixture origin: one base commit carrying REVIEW.md (review-pr's rules
  // fallback reads it from the worktree when the base ref has none) plus a
  // refs/pull/999/merge so the review stage's merge fetch resolves against
  // the local store.
  const seed = path.join(dir, "seed");
  git(["init", "-q", "-b", "master", seed]); // pin the branch: init.defaultBranch differs per lane and the review stage fetches refs/heads/<baseRefName>
  git(["config", "user.name", "tester"], { cwd: seed });
  git(["config", "user.email", "tester@example.com"], { cwd: seed });
  writeFileSync(path.join(seed, "REVIEW.md"), "# rules contract fixture\n");
  writeFileSync(path.join(seed, "a.txt"), "base content\n");
  git(["add", "."], { cwd: seed });
  git(["commit", "-q", "-m", "base"], { cwd: seed });
  git(["init", "--bare", "-q", "-b", "master", bare]); // pin HEAD to the pushed branch: an unresolved HEAD fails the store worktree add exactly like an empty repo
  git(["push", "-q", bare, "master"], { cwd: seed });
  const base = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  git(["--git-dir", bare, "update-ref", "refs/pull/999/merge", base]);

  // gh shim: the queue poll yields ONE queued issue; the ack lookup yields 0;
  // the comments endpoint returns a trusted /dsh trigger (deliberately raw
  // JSON — this test pins dir RESOLUTION across the worker's child hops, not
  // the trust pipeline's jq shapes); the PR facts answer the review stage's
  // reads; everything else answers empty-success.
  writeFileSync(path.join(shims, "gh"), `#!/usr/bin/env bash
echo "gh: \$*" >> "${ghLog}"
case " \$* " in
  *"labels=dsh/queued"*) echo '{"number":42,"is_pr":false}' ;;
  *"labels=dsh/review"*|*"labels=dsh/task"*) ;;
  *"dsh:ack"*) echo 0 ;;
  *"/issues/42/comments"*) echo '[{"id":555,"body":"/dsh ship a fix","user":{"login":"alice","type":"User"},"author_association":"OWNER"}]' ;;
  *" issue view "*) echo '{"title":"fixture","body":"body"}' ;;
  *" pr create "*) echo "https://github.com/owner/repo/pull/999" ;;
  *" --json number "*) echo 999 ;;
  *" pr view "*) echo '{"baseRefName":"master","headRefName":"dsh/agent-branch","title":"fixture pr"}' ;;
  *"/contents/REVIEW.md"*) exit 1 ;;
  *) exit 0 ;;
esac
`);
  // git shim: point every github.com clone at the fixture bare; everything
  // else passes through to the REAL git (absolute path — this shim dir leads
  // the child PATH).
  writeFileSync(path.join(shims, "git"), `#!/usr/bin/env bash
args=()
for a in "\$@"; do
  case "\$a" in https://github.com/*) a="${bare}";; esac
  args+=("\$a")
done
exec "${REAL_GIT}" "\${args[@]}"
`);
  // flock exists only on util-linux boxes; the store lock is a no-op here.
  writeFileSync(path.join(shims, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["gh", "git", "flock"]) spawnSync("chmod", ["+x", path.join(shims, f)]);

  // The child surfaces under $DSH_AGENT_TOOLKIT_DIR are WRAPPERS around the
  // REAL scripts (stubbed only where the real thing leaves the box: driver,
  // push-credential resolver). Each wrapper records whether the worker's
  // shim resolution arrived in its ENVIRONMENT — the F1 contract: a child
  // must not depend on the retired name propagating — then delegates to the
  // real script. The stub driver dirties the worktree (the shipper must have
  // something to commit) and ends with a parseable verdict line (the review
  // hop must complete its label contract).
  for (const [f, tag] of [["ship-changes.sh", "ship"], ["post-reply.sh", "reply"], ["review-pr.sh", "review"]]) {
    writeFileSync(path.join(toolkit, "scripts", f), `#!/usr/bin/env bash
if [ -n "\${DSH_AGENT_TOOLKIT_DIR:-}" ]; then echo 1 >> "${probes}/${tag}.env"; else echo 0 >> "${probes}/${tag}.env"; fi
exec bash "${path.join(ROOT, "scripts", f)}" "\$@"
`);
    spawnSync("chmod", ["+x", path.join(toolkit, "scripts", f)]);
  }
  for (const f of ["scrub-output.mjs", "review-verdict.mjs"]) {
    copyFileSync(path.join(ROOT, "scripts", f), path.join(toolkit, "scripts", f));
  }
  writeFileSync(path.join(toolkit, "scripts", "run-dsh-agent.sh"), `#!/usr/bin/env bash
echo "stub driver ran" >> a.txt
echo "stub driver: work done"
echo "## Verdict: APPROVE"
`);
  writeFileSync(path.join(toolkit, "scripts", "resolve-push-token.sh"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["run-dsh-agent.sh", "resolve-push-token.sh"]) {
    spawnSync("chmod", ["+x", path.join(toolkit, "scripts", f)]);
  }

  // The deployed env-file shape: the legacy name only, sourced exactly the
  // way the cron line sources it (install-worker.sh: `set -a; . env; set +a`).
  const envFile = path.join(dir, "worker.env");
  writeFileSync(envFile, `DSH_BOT_DIR="${toolkit}"\n`);

  try {
    const res = spawnSync(BASH, ["-c", `set -a; . "${envFile}"; set +a; exec bash "${WORKER}" --once`], {
      encoding: "utf8",
      env: baseEnv({
        GH_TOKEN: "fake-token",
        DSH_WORKER_REPOS: "owner/repo",
        DSH_WORKER_DATA_ROOT: data,
        DSH_WORKER_DASHBOARD: "0",
        PATH: `${shims}${path.delimiter}${process.env.PATH}`,
      }),
      timeout: 90000,
    });
    assert.equal(res.status, 0, `worker sweep must succeed (got exit ${res.status}):\n${res.stderr}`);
    assert.match(res.stderr, /DSH_BOT_DIR is retired/, "the worker shim must warn loud, never silent");

    // Items run in a background subshell that outlives the sweep — the item
    // is complete when its slot lock is gone (the trap removes it on exit),
    // not merely when the first artifact appears.
    const runs = path.join(data, "runs");
    const slots = path.join(data, "items");
    const deadline = Date.now() + 45000;
    let rundir = "";
    while (Date.now() < deadline) {
      rundir = (existsSync(runs) ? readdirSync(runs) : [])
        .map((d) => path.join(runs, d))
        .find((d) => existsSync(path.join(d, "review-output.txt"))) || "";
      const busy = (existsSync(slots) ? readdirSync(slots) : []).some((f) => f.endsWith(".lock"));
      if (rundir && !busy) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const log = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
    assert.ok(rundir,
      `the review stage never ran — the children did not resolve the dir.\ngh log:\n${log}\nworker stderr:\n${res.stderr}`);
    assert.match(log, /pr create/, "the shipper child must resolve the dir and open the PR");
    assert.match(readFileSync(path.join(rundir, "review-output.txt"), "utf8"), /stub driver/,
      "the review child must resolve the dir and run its driver");
    assert.match(`${res.stdout}${res.stderr}`, /verdict APPROVE/,
      "the review hop must complete on the composed path");
    assert.doesNotMatch(`${res.stdout}${res.stderr}`, /DSH_AGENT_TOOLKIT_DIR unset/,
      "no child may die at the dir gate on the composed legacy path");
    // F1's contract, observed in vivo: every leaf child must receive the
    // worker's RESOLUTION in its environment — never re-derive it from the
    // retired name (a plain shim assignment does not travel; only an export
    // does).
    for (const tag of ["ship", "reply", "review"]) {
      const p = path.join(probes, `${tag}.env`);
      assert.ok(existsSync(p), `the ${tag} hop never ran`);
      assert.equal(readFileSync(p, "utf8").trim(), "1",
        `the ${tag} child must see DSH_AGENT_TOOLKIT_DIR in its env (the worker's shim must export the resolution)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker source: the legacy-name shim EXPORTS the resolution — a plain assignment dies at the first child gate (review F1)", () => {
  const src = read("scripts", "dsh-worker.sh");
  const line = src.split("\n").find((l) => l.trim() === 'DSH_AGENT_TOOLKIT_DIR="$DSH_BOT_DIR"' || l.trim() === 'export DSH_AGENT_TOOLKIT_DIR="$DSH_BOT_DIR"');
  assert.ok(line, "the worker shim must assign DSH_AGENT_TOOLKIT_DIR from the retired name");
  assert.match(line, /^\s*export /,
    "the shim's resolution must be exported: the worker spawns ship/reply/review without re-stating the dir, so a plain assignment reaches no child");
});

test("review-pr: only the retired DSH_BOT_DIR set still gets past the dir gate, loudly (the direct-caller shim)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rename-compat-review-"));
  const shims = path.join(dir, "shim"); // a prepared dir with NO gh: constructs gh absence hermetically (blessed form — runtime-interpolated, no system dir, ambient not re-included)
  const rules = path.join(dir, "rules.md");
  mkdirSync(shims, { recursive: true });
  writeFileSync(rules, "# rules contract fixture\n");
  try {
    // The gate AFTER the dir shim is the gh check — reaching "gh unavailable"
    // proves the shim resolved the dir and the `:?` gate passed.
    const res = spawnSync(BASH, [path.join(ROOT, "scripts", "review-pr.sh")], {
      encoding: "utf8",
      env: baseEnv({
        GH_TOKEN: "fake-token",
        DSH_SHIP_REPO: "owner/repo",
        PR_NUM: "42",
        DSH_WORKTREE: dir,
        DSH_REVIEW_OUT: path.join(dir, "review-output.txt"),
        DSH_REVIEW_RULES_FILE: rules,
        DSH_BOT_DIR: ROOT, // retired name only
        PATH: shims,
      }),
    });
    assert.match(res.stderr, /DSH_BOT_DIR is retired/, "the shim must warn loud, never silent");
    assert.match(res.stderr, /gh unavailable/,
      "the run must get PAST the dir gate (the next typed gate is the gh check)");
    assert.doesNotMatch(res.stderr, /DSH_AGENT_TOOLKIT_DIR unset/,
      "the retired name must be shimmed, not fatal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
