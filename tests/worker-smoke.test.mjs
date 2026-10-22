// worker-smoke.test.mjs — smoke tests for scripts/dsh-worker.sh.
//
// The worker cannot be integration-tested hermetically (it clones real
// repos and talks to the real API), so this suite pins what CAN be pinned
// offline: --once on an EMPTY queue sweeps cleanly and exits 0 (the gh
// shim answers label-create + an empty issues list), and the worker fails
// loudly (exit 2) without its required env — it must never silently stand
// still with a missing token or repo list.
//
// Issue #527 pins: a rate-limited (or garbage) poll must degrade to an
// EMPTY result — never an uncaught JSON.parse throw killing the worker
// (870 crash-loop receipts), and the throttle must back off QUIETLY across
// the per-minute cron sweeps (state on disk, not in-process): one line when
// the throttle starts, escalating probe waits, one line when it clears.
//
// Issue #530 pins: trusted_task's issue-body parse is guarded INSIDE the
// node script (the #528 poll_field / #529 pr_field shape carried to the
// claim path). A garbage `gh issue view` stdout — gh's error text riding
// stdout under a 403/429 — must degrade to an EMPTY task with ONE
// diagnostic line on the worker log (never an uncaught JSON.parse, never a
// silent close), and a malformed body on an already-claimed item must NOT
// leave it stuck under `dsh/running`: the typed no-trusted-comment path
// replies and removes the running label.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-smoke-test-"));
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const ghLog = path.join(logs, "gh.log");
  // A stub gh: answer label ops silently, and an EMPTY queue for the
  // issues-list poll (no pending dsh/queued items).
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
case " $* " in
  *"issues?state=open"*) exit 0 ;;   # empty queue
  *) exit 0 ;;
esac
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);
  return { dir, ghLog, shim,
    env: (extra = {}) => ({
      GH_TOKEN: "fake-token", DSH_AGENT_TOOLKIT_DIR: ROOT, DSH_WORKER_REPOS: "owner/repo",
      DSH_WORKER_DATA_ROOT: path.join(dir, "data"),
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

// gh-shim fixture with a caller-supplied shim script body (issue #527 pins:
// the shim body decides what the issues poll returns and with what status).
const fixtureWithShim = (shimBody) => {
  const f = fixture();
  writeFileSync(path.join(f.shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
${shimBody}
`);
  spawnSync("chmod", ["+x", path.join(f.shim, "gh")]);
  return f;
};

// One --once sweep with its own gh log; returns { status, stderr }.
const runOnce = (f, ghLog) =>
  spawnSync("bash", [WORKER, "--once"], {
    encoding: "utf8",
    env: f.env({ GH_LOG: ghLog }),
  });

test("--once on an empty queue sweeps cleanly (exit 0, polls the repo)", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [WORKER, "--once"], {
      encoding: "utf8", env: f.env(),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /polling owner\/repo for label 'dsh\/queued'/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("fails loudly (exit 2) without the required env — never runs half-configured", () => {
  const f = fixture();
  try {
    for (const missing of ["GH_TOKEN", "DSH_AGENT_TOOLKIT_DIR", "DSH_WORKER_REPOS"]) {
      const env = f.env();
      delete env[missing];
      const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env });
      assert.equal(res.status, 2, `${missing}: expected exit 2 (got ${res.status})`);
      assert.match(res.stderr, new RegExp(missing));
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("bad mode arg → usage on stderr, exit 2", () => {
  const f = fixture();
  try {
    const res = spawnSync("bash", [WORKER, "--bogus"], {
      encoding: "utf8", env: f.env(),
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("documented env example matches the worker's required vars", () => {
  const f = fixture();
  try {
    const example = readFileSync(path.join(ROOT, "config", "dsh-worker.env.example"), "utf8");
    for (const v of ["GH_TOKEN", "DSH_AGENT_TOOLKIT_DIR", "DSH_WORKER_REPOS"]) {
      assert.match(example, new RegExp(v));
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- issue #527 pins: a throttled or garbage poll never kills the worker ---

// The REAL failure shape (870 crash-loop receipts): gh prints its human
// error to stderr AND the raw pretty-printed error body to stdout (the
// --jq fallback), exits 1. The old code streamed that body into the item
// loop where `node -e 'JSON.parse(...)'` threw on line 1 (`{`) and set -e
// killed the worker (exit 1, next cron minute repeated it).
const RATE_LIMIT_SHIM = `case " $* " in
  *"issues?state=open"*)
    echo "gh: API rate limit exceeded for user ID 81942069. (HTTP 403)" >&2
    printf '{\\n\\t"message": "API rate limit exceeded for user ID 81942069.",\\n\\t"documentation_url": "https://docs.github.com/rest/rate-limit"\\n}\\n'
    exit 1 ;;
  *) exit 0 ;;
esac`;

test("rate-limited poll: empty result, exit 0, ONE throttle line, backoff stamped (was: JSON.parse crash-loop)", () => {
  const f = fixtureWithShim(RATE_LIMIT_SHIM);
  try {
    const ghLog = path.join(f.dir, "logs", "gh1.log");
    const res = runOnce(f, ghLog);
    assert.equal(res.status, 0, `worker must survive a throttle (stderr: ${res.stderr})`);
    assert.doesNotMatch(res.stderr, /SyntaxError/);
    assert.match(res.stderr, /rate-limited on owner\/repo label 'dsh\/queued'/);
    assert.match(res.stderr, /backing off 30s/);
    // exactly ONE throttle line — the review/task polls skip silently
    assert.equal((res.stderr.match(/rate-limited/g) || []).length, 1);
    // the backoff state is on disk for the NEXT cron-minute process
    const state = readFileSync(path.join(f.dir, "data", "poll-backoff.state"), "utf8").trim();
    const [untilS, streak] = state.split(" ");
    assert.ok(Number(untilS) > Math.floor(Date.now() / 1000), `backoff must be in the future: ${state}`);
    assert.equal(streak, "1");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("backoff holds across processes: the next cron-minute sweep is FULLY quiet (zero gh calls, zero lines)", () => {
  const f = fixtureWithShim(RATE_LIMIT_SHIM);
  try {
    const res1 = runOnce(f, path.join(f.dir, "logs", "gh1.log"));
    assert.equal(res1.status, 0);
    // a fresh process (the cron shape: dsh-worker.sh --once every minute)
    const ghLog2 = path.join(f.dir, "logs", "gh2.log");
    const res2 = runOnce(f, ghLog2);
    assert.equal(res2.status, 0);
    assert.equal(res2.stderr.trim(), "", "a throttled sweep must stay quiet");
    assert.equal(existsSync(ghLog2), false, "a throttled sweep must make ZERO gh calls");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("expired backoff re-probes and ESCALATES the streak (30s x streak, file-carried)", () => {
  const f = fixtureWithShim(RATE_LIMIT_SHIM);
  try {
    const stateFile = path.join(f.dir, "data", "poll-backoff.state");
    mkdirSync(path.join(f.dir, "data"), { recursive: true });
    writeFileSync(stateFile, `${Math.floor(Date.now() / 1000) - 10} 3\n`);
    const res = runOnce(f, path.join(f.dir, "logs", "gh.log"));
    assert.equal(res.status, 0);
    assert.match(res.stderr, /backing off 120s/); // 30s x streak 4
    const [, streak] = readFileSync(stateFile, "utf8").trim().split(" ");
    assert.equal(streak, "4");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("active backoff: a sweep inside the window makes no gh calls and prints nothing", () => {
  const f = fixtureWithShim(RATE_LIMIT_SHIM);
  try {
    mkdirSync(path.join(f.dir, "data"), { recursive: true });
    writeFileSync(path.join(f.dir, "data", "poll-backoff.state"), `${Math.floor(Date.now() / 1000) + 300} 2\n`);
    const ghLog = path.join(f.dir, "logs", "gh.log");
    const res = runOnce(f, ghLog);
    assert.equal(res.status, 0);
    assert.equal(res.stderr.trim(), "");
    assert.equal(existsSync(ghLog), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("healthy poll after a recorded throttle: ONE recovery line, backoff cleared", () => {
  const f = fixture(); // the empty-queue shim = a healthy gh
  try {
    mkdirSync(path.join(f.dir, "data"), { recursive: true });
    writeFileSync(path.join(f.dir, "data", "poll-backoff.state"), `${Math.floor(Date.now() / 1000) - 10} 3\n`);
    const res = runOnce(f, f.ghLog);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /poll recovered on owner\/repo label 'dsh\/queued'/);
    assert.equal(existsSync(path.join(f.dir, "data", "poll-backoff.state")), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("garbage line on a HEALTHY poll never kills the worker — the valid queue line still parses", () => {
  const f = fixtureWithShim(`case " $* " in
  *"issues?state=open"*)
    printf '{\\n\\t"message": "partial body garbage",\\n}\\n'
    printf '{"number": 7, "is_pr": false}\\n'
    exit 0 ;;
  *"labels/"*) exit 1 ;;   # DELETE label -> 404 -> claim lost (no agent run)
  *) exit 0 ;;
esac`);
  try {
    const res = runOnce(f, f.ghLog);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /SyntaxError/);
    // the valid line made it THROUGH the parser to the claim path
    // (claim-lost is one of the worker's stdout narrations)
    assert.match(res.stdout + res.stderr, /claim lost on owner\/repo #7/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- issue #530 pins: trusted_task's issue-body parse degrades loudly, never crashes ---
//
// The claim path re-derives trust AFTER the item is claimed, so a garbage
// `gh issue view` stdout (gh's error text riding stdout under a 403/429)
// must degrade to an EMPTY task — the caller's typed "no trusted /dsh
// comment" path — with ONE diagnostic line on stderr (the worker log),
// never an uncaught JSON.parse (the #527 crash shape carried to the claim
// path, the #529 sibling), and never a body that parses but is NOT the gh
// issue envelope (GitHub's own 403/429 error bodies are JSON and carry no
// authorAssociation — the silent-close arm). The pin runs the REAL function,
// extracted verbatim from the script (a rename or move fails the extraction
// loudly), under the same `set -euo pipefail` the worker runs with.
const trustedTaskSource = () =>
  execFileSync("bash", ["-c", `sed -n '/^trusted_task() {/,/^}/p' "${WORKER}"`], { encoding: "utf8" });

const runTrustedTask = (issueViewStub, commentsStub = `exit 0`) => { // → { status, stderr, task }
  const dir = mkdtempSync(path.join(tmpdir(), "trusted-task-pin-"));
  try {
    const shim = path.join(dir, "shim");
    mkdirSync(shim, { recursive: true });
    writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
case "$*" in
  *"issues/530/comments"*) ${commentsStub} ;;                    # comment reads
  *"issue view"*) ${issueViewStub} ;;
  *) exit 1 ;;
esac
`);
    spawnSync("chmod", ["+x", path.join(shim, "gh")]);
    const out = path.join(dir, "task.out");
    const script = `set -euo pipefail\n${trustedTaskSource()}\ntrusted_task owner/repo 530 false "${out}"`;
    const res = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}` },
    });
    const task = existsSync(out) ? readFileSync(out, "utf8") : null;
    return { status: res.status, stderr: res.stderr, task };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("trusted_task: a non-JSON issue body degrades to an EMPTY task, shell survives, degrade logs (issue #530)", () => {
  const { status, stderr, task } = runTrustedTask(
    `printf 'gh: API rate limit exceeded (HTTP 403)\\n'; printf 'this is not JSON {'; exit 0`,
  );
  assert.equal(status, 0, stderr); // set -euo pipefail survives the garbage body
  assert.equal(task, ""); // the typed no-trusted-comment path, not a crash
  assert.match(stderr, /is not JSON/); // the degrade is ON the record (worker log)
  assert.match(stderr, /issue #530/);
});

test("trusted_task: a JSON body that is NOT the gh issue envelope (GitHub's own 403/429 bodies) degrades loudly too (issue #530)", () => {
  const { status, stderr, task } = runTrustedTask(
    `printf '%s' '{"message":"API rate limit exceeded for user ID 81942069.","status":"403"}'; exit 0`,
  );
  assert.equal(status, 0, stderr);
  assert.equal(task, ""); // parsed-but-not-envelope: an empty task, never task text
  assert.match(stderr, /NOT the gh issue envelope/); // this arm's own diagnostic
  assert.doesNotMatch(stderr, /is not JSON/); // proves WHICH arm fired
});

test("trusted_task: a trusted /dsh issue body still yields the task text (issue #530 positive control)", () => {
  const { status, stderr, task } = runTrustedTask(
    `printf '%s' '{"body":"/dsh ship the fix","title":"found: x","authorAssociation":"OWNER"}'; exit 0`,
  );
  assert.equal(status, 0, stderr);
  assert.equal(task, "ship the fix");
  assert.doesNotMatch(stderr, /issue #530/); // no degrade diagnostic on the healthy path
});

test("trusted_task: a FAILED gh issue view degrades to an empty task, shell survives (issue #530)", () => {
  const { status, task } = runTrustedTask(`exit 1`);
  assert.equal(status, 0); // the `|| true` belt around the gh call
  assert.equal(task, "");
});

test("trusted_task: a gh error envelope on the comments read can NEVER become the task (issue #530)", () => {
  // Live shape (verified on this box): gh api prints its raw error envelope
  // to STDOUT even with --jq and exits non-zero — the old `$(gh ... || true)`
  // swallowed the rc INSIDE the substitution and made the envelope the task.
  const { status, stderr, task } = runTrustedTask(
    `exit 1`,
    `printf '%s' '{"message":"API rate limit exceeded for user ID 81942069.","status":"403"}'; exit 1`,
  );
  assert.equal(status, 0, stderr);
  assert.doesNotMatch(task ?? "", /rate limit/); // the error envelope is discarded, not tasked
});

// The issue's own demanded proof: a malformed body on an ALREADY-CLAIMED
// item (queued removed, running added) must NOT leave the ticket stranded
// under `dsh/running`. The full worker run takes the typed no-trusted
// path: reply comment POSTed + the running label DELETEd — the gh log IS
// the record the label was released.
const MALFORMED_BODY_QUEUED_ITEM_SHIM = `case " $* " in
  *"issues?state=open&labels=dsh/queued"*) printf '{"number": 7, "is_pr": false}\\n' ;;  # one queued item
  *"issues?state=open"*) exit 0 ;;                                   # review/task polls: empty
  *"label create"*) exit 0 ;;                                        # ensure_labels
  *"issues/7/labels/dsh%2Fqueued"*) exit 0 ;;                        # claim: remove queued
  *"issues/7/labels"*) exit 0 ;;                                     # claim: add running
  *"issue view"*authorAssociation*)                                  # trusted_task's body read → MALFORMED
    printf 'gh: API rate limit exceeded (HTTP 403)\\n'
    printf 'this is not JSON {' ;;
  *"issue view"*) printf '%s' '{"title":"t","body":"b"}' ;;          # fetch_context read
  *"comments?per_page=100"*) exit 0 ;;                               # empty thread context
  *"-f body="*) exit 0 ;;                                            # the no-trusted reply comment
  *"issues/7/labels/dsh%2Frunning"*) exit 0 ;;                       # close: release the running label
  *) exit 1 ;;
esac`;

test("malformed issue body on a CLAIMED item: worker exits 0, replies, and releases dsh/running — never wedged (issue #530)", () => {
  const f = fixtureWithShim(MALFORMED_BODY_QUEUED_ITEM_SHIM);
  try {
    const ghLog = path.join(f.dir, "logs", "gh530.log");
    const res = spawnSync("bash", [WORKER, "--once"], {
      encoding: "utf8",
      env: f.env({ GH_LOG: ghLog, DSH_WORKER_DASHBOARD: "0" }),
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /SyntaxError/);
    assert.match(res.stderr, /is not JSON/); // the degrade is ON the record
    assert.match(res.stderr, /issue #530/);
    assert.match(res.stdout + res.stderr, /no trusted \/dsh comment found on owner\/repo #7/);
    const log = readFileSync(ghLog, "utf8");
    // the typed close path: the reply was POSTed AND the running label was
    // DELETEd — the item is NOT left stuck under dsh/running.
    assert.match(log, /-f body=/);
    assert.match(log, /DELETE[\s\S]*labels\/dsh%2Frunning/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});