// carrier-census.test.mjs — the open-PR carrier census (issue #549).
//
// The receipt: 25 identical `/dsh` triggers on #398 kept minting full
// agent rounds while the fix sat in an open, green, mergeable carrier PR
// (#495) — the enqueue/claim path never consulted open PRs, and the #414
// dedup is agent-side prose, not machine behavior. The fix: the worker
// runs scripts/carrier-census.sh at claim time and maps the verdict:
//
//   open GREEN carrier  → typed no-op (dsh:carrier-standdown), NO agent
//                         round, no dsh/running label
//   no carrier          → mint plain
//   red/pending carrier → mint, but the task names the carrier (the
//                         census must not mask a broken carrier)
//   unresolved census   → mint plain (fail-open — a broken census must
//                         never eat a task)
//
// Three legs, mirroring the repo's test shape (behavioral script-level,
// behavioral worker-level through a stub gh, structural source pins):

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CENSUS = path.join(ROOT, "scripts", "carrier-census.sh");
const WORKER = path.join(ROOT, "scripts", "dsh-worker.sh");

// --- the stub gh -----------------------------------------------------------
// One responder for both legs: answers by endpoint shape, logs every call
// to $GH_LOG (the assertions read the log). Data payloads come from the
// fixture below; unmatched calls exit 0 silently (the worker's fetches are
// all `|| true`).

const stubGh = ({ prList = "[]", checkRuns = "{}", queue = "[]" } = {}) =>
  `#!/usr/bin/env bash
echo "gh: $*" >> "\${GH_LOG}"
case "$*" in
  *"labels=dsh/queued"*) printf '%s\\n' '${queue}' ;;
  *"pr list"*) printf '%s\\n' '${prList}' ;;
  *"check-runs"*) printf '%s\\n' '${checkRuns}' ;;
  *"issue view"*) printf '%s\\n' '{}' ;;
  *) exit 0 ;;
esac
`;

const fixture = (opts = {}) => {
  const stub = stubGh(opts);
  const dir = mkdtempSync(path.join(tmpdir(), "carrier-census-test-"));
  const shim = path.join(dir, "shim");
  mkdirSync(shim, { recursive: true });
  const ghLog = path.join(dir, "gh.log");
  writeFileSync(path.join(shim, "gh"), stub);
  chmodSync(path.join(shim, "gh"), 0o755);
  return {
    dir,
    ghLog,
    readLog: () => (readFileSync(ghLog, "utf8").toString()),
    censusEnv: () => ({
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      GH_LOG: ghLog,
      GH_TOKEN: "fake-token",
    }),
    workerEnv: () => ({
      GH_TOKEN: "fake-token",
      DSH_AGENT_TOOLKIT_DIR: ROOT,
      DSH_WORKER_REPOS: "owner/repo",
      DSH_WORKER_DATA_ROOT: path.join(dir, "data"),
      DSH_WORKER_DASHBOARD: "0",
      GH_LOG: ghLog,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const census = (env) =>
  spawnSync("bash", [CENSUS, "owner/repo", "405"], { encoding: "utf8", env });

const verdictOf = (res) => {
  assert.equal(res.status, 0, `census must answer, never fail loud (stderr: ${res.stderr})`);
  return JSON.parse(res.stdout);
};

const pr = (number, ref, extra = {}) =>
  JSON.stringify({ number, title: extra.title ?? "the fix", body: extra.body ?? `Fixes #${ref}`, headRefOid: extra.head ?? `sha${number}` });

const checks = (...runs) => JSON.stringify({ check_runs: runs.map((r) => ({ name: "gates", status: "completed", conclusion: "success", ...r })) });

// --- leg 1: the census script's decision matrix ----------------------------

test("issue #549: open carrier with green head checks → verdict green, carrier named", () => {
  const f = fixture({ prList: `[${pr(495, 405)}]`, checkRuns: checks({ conclusion: "success" }) });
  try {
    const v = verdictOf(census(f.censusEnv()));
    assert.equal(v.verdict, "green");
    assert.equal(v.carrier, 495);
    assert.match(v.reason, /green/);
  } finally { f.cleanup(); }
});

test("issue #549: open carrier with a red check run → verdict red (the census must not mask a broken carrier)", () => {
  const f = fixture({ prList: `[${pr(495, 405)}]`, checkRuns: checks({ conclusion: "failure" }) });
  try {
    const v = verdictOf(census(f.censusEnv()));
    assert.equal(v.verdict, "red");
    assert.equal(v.carrier, 495);
  } finally { f.cleanup(); }
});

test("issue #549: open carrier with pending/ungraded checks → verdict pending, carrier named", () => {
  for (const checkRuns of [
    checks({ status: "in_progress", conclusion: null }),
    checks(),
  ]) {
    const f = fixture({ prList: `[${pr(495, 405)}]`, checkRuns });
    try {
      const v = verdictOf(census(f.censusEnv()));
      assert.equal(v.verdict, "pending", `checkRuns=${checkRuns}`);
      assert.equal(v.carrier, 495);
    } finally { f.cleanup(); }
  }
});

test("issue #549: no open PR references the issue → verdict none", () => {
  const f = fixture({ prList: "[]" });
  try {
    const v = verdictOf(census(f.censusEnv()));
    assert.equal(v.verdict, "none");
    assert.equal(v.carrier, null);
  } finally { f.cleanup(); }
});

test("issue #549: the ref match is a token match — a reference in the title counts, #4050 does not match issue 405", () => {
  // title-only reference counts as a carrier
  let f = fixture({ prList: `[${pr(495, 0, { title: "Fix #405 properly", body: "no body ref" })}]`, checkRuns: checks({ conclusion: "success" }) });
  try {
    assert.equal(verdictOf(census(f.censusEnv())).verdict, "green");
  } finally { f.cleanup(); }
  // a longer number sharing the prefix must never match
  f = fixture({ prList: `[${pr(495, 0, { body: "Fixes #4050" })}]`, checkRuns: checks({ conclusion: "success" }) });
  try {
    assert.equal(verdictOf(census(f.censusEnv())).verdict, "none");
  } finally { f.cleanup(); }
});

test("issue #549: multiple carriers → the LOWEST number is named (the oldest carrier is canonical)", () => {
  const f = fixture({
    prList: `[${pr(511, 405)},${pr(495, 405)},${pr(520, 405)}]`,
    checkRuns: checks({ conclusion: "success" }),
  });
  try {
    const v = verdictOf(census(f.censusEnv()));
    assert.equal(v.verdict, "green");
    assert.equal(v.carrier, 495);
  } finally { f.cleanup(); }
});

test("issue #549: the census fails OPEN — gh failure or unparseable answer → verdict unresolved, exit 0 (mint)", () => {
  // gh pr list fails (shim answers nothing — gh prints nothing and the
  // census treats an unusable answer as unresolved)
  let f = fixture({ prList: "not-json", checkRuns: "{}" });
  try {
    const res = census(f.censusEnv());
    assert.equal(res.status, 0, "fail-open: the census still answers");
    assert.equal(JSON.parse(res.stdout).verdict, "unresolved");
  } finally { f.cleanup(); }
  // carrier found, but the check-runs answer is garbage → unresolved WITH
  // the carrier named (the worker mints and still tells the agent)
  f = fixture({ prList: `[${pr(495, 405)}]`, checkRuns: "not-json" });
  try {
    const res = census(f.censusEnv());
    assert.equal(res.status, 0);
    const v = JSON.parse(res.stdout);
    assert.equal(v.verdict, "unresolved");
    assert.equal(v.carrier, 495, "a seen carrier is named even when ungradeable");
  } finally { f.cleanup(); }
});

test("issue #549: usage error → exit 2 (missing/unnumbered arguments)", () => {
  const f = fixture({});
  try {
    for (const args of [[], ["owner/repo"], ["owner/repo", "not-a-number"]]) {
      const res = spawnSync("bash", [CENSUS, ...args], { encoding: "utf8", env: f.censusEnv() });
      assert.equal(res.status, 2, `args=${JSON.stringify(args)}`);
      assert.match(res.stderr, /usage/);
    }
  } finally { f.cleanup(); }
});

// --- leg 2: the worker's verdict mapping (behavioral, through the stub) ----

const queuedIssue = JSON.stringify({ number: 405, is_pr: false });

test("issue #549: worker + open GREEN carrier → typed stand-down posted, NO dsh/running mint, no agent round", () => {
  const f = fixture({
    prList: `[${pr(495, 405)}]`,
    checkRuns: checks({ conclusion: "success" }),
    queue: queuedIssue,
  });
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.workerEnv(), timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /GREEN carrier #495 — stand-down, no agent round/);
    const log = f.readLog();
    assert.match(log, /dsh:carrier-standdown/, "the stand-down must be a TYPED no-op (marker in the posted body)");
    assert.match(log, /#495/, "the no-op names the carrier PR");
    assert.ok(!log.includes("labels[]=dsh/running"), "a stand-down must never mint (the running label is the mint)");
  } finally { f.cleanup(); }
});

test("issue #549: worker + no carrier → mint plain (no stand-down, the run proceeds past the census)", () => {
  const f = fixture({ prList: "[]", queue: queuedIssue });
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.workerEnv(), timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no open carrier — minting/);
    assert.ok(!f.readLog().includes("dsh:carrier-standdown"));
  } finally { f.cleanup(); }
});

test("issue #549: worker + red carrier → still MINTS, naming the carrier (the census must not mask a broken carrier)", () => {
  const f = fixture({
    prList: `[${pr(495, 405)}]`,
    checkRuns: checks({ conclusion: "failure" }),
    queue: queuedIssue,
  });
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.workerEnv(), timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /carrier #495 is red — minting with the carrier named in the task/);
    assert.ok(!f.readLog().includes("dsh:carrier-standdown"));
  } finally { f.cleanup(); }
});

test("issue #549: worker + unresolved census → mints plain (fail-open: a broken census never eats a task)", () => {
  const f = fixture({ prList: "not-json", queue: queuedIssue });
  try {
    const res = spawnSync("bash", [WORKER, "--once"], { encoding: "utf8", env: f.workerEnv(), timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no open carrier — minting|carrier #\d+ is unresolved — minting/);
    assert.ok(!f.readLog().includes("dsh:carrier-standdown"));
  } finally { f.cleanup(); }
});

// --- leg 3: the structural pins --------------------------------------------

test("issue #549: the worker's census seam is structurally pinned (seam, typed marker, task note)", () => {
  const w = readFileSync(WORKER, "utf8");
  // the census runs at claim time — AFTER the queued-label claim, BEFORE
  // the running label is added (the mint). The census index anchors on the
  // process_item invocation (the header doc mentions the script too), the
  // mint on the first label-add after it.
  const claim = w.indexOf('DELETE "repos/${repo}/issues/${num}/labels/$(label_enc "$QUEUE_LABEL")"');
  const censusIdx = w.indexOf('bash "$DSH_AGENT_TOOLKIT_DIR/scripts/carrier-census.sh"', claim);
  const mint = w.indexOf('labels[]="$RUN_LABEL"', censusIdx);
  assert.ok(claim !== -1 && censusIdx !== -1 && mint !== -1);
  assert.ok(claim < censusIdx && censusIdx < mint, "the census sits between the claim and the mint");
  // the typed no-op marker and the carrier-note append ride the source
  assert.match(w, /dsh:carrier-standdown/);
  assert.match(w, /CARRIER_NOTE/);
  assert.match(w, /TASK="\$\(printf '%s\\n\\n%s' "\$TASK" "\$CARRIER_NOTE"\)"/);
  // PR-thread items skip the census — a PR's own /dsh re-trigger is
  // iteration on that PR, not a new-work mint
  assert.match(w, /if \[ "\$is_pr" != "true" \]; then/);
});
