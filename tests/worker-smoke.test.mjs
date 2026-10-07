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
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
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

test("--once on a FRESH data root reaches the dashboard deep path and exits 0 (issue #540)", () => {
  const f = fixture();
  try {
    // A healthy gh whose dashboard issue EXISTS (number 42): this drives
    // dashboard_update past its empty-list bail into the deep path — the
    // slots/procs/recent reads, the meta rollup, the body edit — on a data
    // root where $DATA/runs does not exist yet (it is created lazily only
    // when an item runs). Under `set -euo pipefail` the unguarded
    // `ls -1t "$DATA/runs"` in the recent= assignment exit-1s the whole
    // sweep there (issue #540); the guard must keep the sweep green and
    // the body must still post, with the runs cell rendered as none.
    writeFileSync(path.join(f.shim, "gh"), `#!/usr/bin/env bash
[ -n "\${GH_LOG:-}" ] && echo "gh: $*" >> "$GH_LOG"
case " $* " in
  *"issue edit"*) exit 0 ;;            # dashboard body posted
  *"dsh/dashboard"*) echo 42 ;;        # the dashboard issue exists
  *"issues?state=open"*) exit 0 ;;     # empty queue polls
  *"issue list"*) echo 0 ;;            # queue/running counts
  *) exit 0 ;;
esac
`);
    spawnSync("chmod", ["+x", path.join(f.shim, "gh")]);
    const res = spawnSync("bash", [WORKER, "--once"], {
      encoding: "utf8", env: f.env({ GH_LOG: f.ghLog }),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout + res.stderr, /poll FAILED/);
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /gh: issue edit 42 /, "the dashboard body was actually posted");
    assert.match(log, /\| recent runs \| none \|/, "a fresh data root renders the runs cell as none");
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