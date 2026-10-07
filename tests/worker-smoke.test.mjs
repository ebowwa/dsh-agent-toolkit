// worker-smoke.test.mjs — smoke tests for scripts/dsh-worker.sh.
//
// The worker cannot be integration-tested hermetically (it clones real
// repos and talks to the real API), so this suite pins what CAN be pinned
// offline: --once on an EMPTY queue sweeps cleanly and exits 0 (the gh
// shim answers label-create + an empty issues list), and the worker fails
// loudly (exit 2) without its required env — it must never silently stand
// still with a missing token or repo list.

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

// --- trusted_task's issue-body parse degrades loudly, never crashes (issue #530)
//
// The claim path re-derives trust AFTER the item is claimed, so a garbage
// `gh issue view` stdout (gh's error text riding stdout under a 403/429)
// must degrade to an EMPTY task — the caller's typed "no trusted /dsh
// comment" path — with ONE diagnostic line on stderr (the worker log),
// and the shell must survive under the worker's `set -euo pipefail`.
// The pin runs the REAL function, extracted verbatim from the script
// (a rename or move fails the extraction loudly), under the same `set
// -euo pipefail` the worker runs with.
const trustedTaskSource = () =>
  execFileSync("bash", ["-c", `sed -n '/^trusted_task() {/,/^}/p' "${WORKER}"`], { encoding: "utf8" });

const runTrustedTask = (issueViewStub) => { // → { status, stderr, task }
  const dir = mkdtempSync(path.join(tmpdir(), "trusted-task-pin-"));
  try {
    const shim = path.join(dir, "shim");
    mkdirSync(shim, { recursive: true });
    writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
case "$*" in
  *"issues/530/comments"*) exit 0 ;;                # no trusted comments
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
    `printf 'gh: API rate limit exceeded (HTTP 403)'; exit 0`,
  );
  assert.equal(status, 0, stderr); // set -euo pipefail survives the garbage body
  assert.equal(task, ""); // the typed no-trusted-comment path, not a crash
  assert.match(stderr, /not JSON/); // the degrade is on the record (worker log)
  assert.match(stderr, /issue #530/);
});

test("trusted_task: a trusted /dsh issue body still yields the task text (issue #530 positive control)", () => {
  const { status, stderr, task } = runTrustedTask(
    `printf '%s' '{"body":"/dsh ship the fix","title":"found: x","authorAssociation":"OWNER"}'; exit 0`,
  );
  assert.equal(status, 0, stderr);
  assert.equal(task, "ship the fix");
  assert.doesNotMatch(stderr, /not JSON/);
});

test("trusted_task: a FAILED gh issue view degrades to an empty task, shell survives (issue #530)", () => {
  const { status, task } = runTrustedTask(`exit 1`);
  assert.equal(status, 0); // the `|| true` + `[ -n ]` belt around the gh call
  assert.equal(task, "");
});