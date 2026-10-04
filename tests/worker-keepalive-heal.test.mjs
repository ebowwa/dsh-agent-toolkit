// worker-keepalive-heal.test.mjs — hermetic tests for the dsh-worker.sh
// keepalive SELF-HEAL arm (issue #276, propagation).
//
// The guarded pin (scripts/pin-toolkit.sh) only helps a box whose cron
// line CALLS it — but the boxes that need it carry the OLD raw
// `checkout -q --force v1` line, and that line is what delivers the new
// worker (it re-pins the moving v1 tag). So the worker upgrades the
// line itself: heal when it sees the legacy shape, never mint where no
// keepalive exists, never touch an already-guarded line, and honor the
// DSH_WORKER_NO_KEEPALIVE_HEAL opt-out. These tests pin exactly that
// against a stubbed crontab (a store file) — the host crontab is never
// read or written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

// The legacy keepalive line exactly as install-worker.sh minted it
// between PR #104 and issue #276 (anchors the heal parses: the toolkit
// dir rides `bash <dir>/scripts/dsh-worker.sh`, the worker home rides
// `flock -n <home>/sweep.lock`). Paths are fake-but-plausible; the heal
// only rewrites strings and never touches these dirs.
const TK = "/home/box/dsh-agent-toolkit";
const WH = "/home/box/.dsh-worker";
const legacyLine = () =>
  `* * * * * flock -n ${WH}/sweep.lock /bin/bash -c 'git -C ${TK} fetch --tags --force -q && git -C ${TK} checkout -q --force v1 || true; set -a; . ${WH}/env; set +a; exec /bin/bash ${TK}/scripts/dsh-worker.sh --once >> ${WH}/worker.log 2>&1'`;
const guardedLine = () =>
  `* * * * * flock -n ${WH}/sweep.lock /bin/bash -c 'bash ${TK}/scripts/pin-toolkit.sh ${TK} ${WH}/worker.log || true; set -a; . ${WH}/env; set +a; exec /bin/bash ${TK}/scripts/dsh-worker.sh --once >> ${WH}/worker.log 2>&1'`;

const fixture = (seed) => {
  const dir = mkdtempSync(path.join(tmpdir(), "keepalive-heal-test-"));
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  // stub crontab: -l cats the store, a bare write stores stdin — the
  // ONLY crontab the worker can see (host crontab unreachable)
  const store = path.join(dir, "crontab-store");
  const calls = path.join(dir, "crontab-calls.log");
  writeFileSync(store, seed);
  writeFileSync(path.join(shim, "crontab"), `#!/usr/bin/env bash
echo "crontab $*" >> "${calls}"
if [ "$1" = "-l" ]; then cat "${store}"; exit 0; fi
cat > "${store}"
`);
  chmodSync(path.join(shim, "crontab"), 0o755);
  // stub gh: empty queue (worker-smoke pattern)
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
case " $* " in
  *"issues?state=open"*) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(path.join(shim, "gh"), 0o755);
  return { dir, store, calls,
    env: (extra = {}) => ({
      GH_TOKEN: "fake-token",
      DSH_AGENT_TOOLKIT_DIR: ROOT,
      DSH_WORKER_REPOS: "owner/repo",
      DSH_WORKER_DATA_ROOT: path.join(dir, "data"),
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

test("heals the legacy raw-pin line in place (anchors, flock, exec and env source preserved)", () => {
  const f = fixture(legacyLine());
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /upgraded to the guarded pin/, "the heal announces itself");
    const healed = readFileSync(f.store, "utf8");
    assert.ok(healed.includes(`${TK}/scripts/pin-toolkit.sh ${TK} ${WH}/worker.log`),
      "the raw force-checkout segment is replaced by the guarded pin call");
    assert.ok(!healed.includes("checkout -q --force v1"),
      "the per-minute discard path (issue #276) is GONE");
    assert.match(healed, /flock -n .*sweep\.lock/, "the flock overlap guard is preserved");
    assert.match(healed, /exec \/bin\/bash .*dsh-worker\.sh --once/, "the sweep tail is preserved");
    assert.match(healed, /\. .*\/env/, "the env source is preserved");
    assert.match(healed, /^\* \* \* \* \* /, "the schedule is untouched");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("never mints a keepalive where none exists (dev/CI cells stay untouched)", () => {
  const f = fixture("# an unrelated user crontab\n");
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /upgraded/, "no heal where there is no keepalive");
    assert.equal(readFileSync(f.store, "utf8"), "# an unrelated user crontab\n",
      "crontab byte-identical");
    assert.ok(readFileSync(f.calls, "utf8").split("\n").every((l) => l === "crontab -l" || l === ""),
      "read-only: the heal may LIST but never WRITE where no keepalive exists");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an already-guarded line is left alone (idempotent)", () => {
  const f = fixture(guardedLine());
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.env() });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /upgraded/, "guarded line needs no heal");
    assert.equal(readFileSync(f.store, "utf8"), guardedLine());
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("DSH_WORKER_NO_KEEPALIVE_HEAL=1 opts out (test seam / operator hold)", () => {
  const f = fixture(legacyLine());
  try {
    const res = spawnSync("bash", [WORKER, "--once"], {
      encoding: "utf8", env: f.env({ DSH_WORKER_NO_KEEPALIVE_HEAL: "1" }),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(f.store, "utf8"), legacyLine(),
      "the opt-out leaves the raw line for the operator");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
