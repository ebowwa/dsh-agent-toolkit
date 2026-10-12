// review-pr-diff.test.mjs — the review stage's diff basis is fail-closed
// (issue #516) and RECOVERS by bounded deepening before it fails closed
// (issue #519).
//
// The bug class (PR #495 receipt): review-pr.sh's diff chain ended in
// `|| echo origin/base`, so a FAILED merge-base lookup — exactly the
// shallow-checkout case — silently degraded to a TWO-DOT base→pr-merge
// diff. A two-dot diff reads every sibling landing since the fork point as
// an apparent PR reversal: a clean 6-file PR graded as 12 files of contract
// tampering (REVIEW.md edits + merge-guard disarm it never made), and the
// symmetric risk — a REAL revert hiding among "stale-fork artifacts".
//
// The residual #519 closes: the review stage's `--depth 1` fetches (and the
// worker's `--depth 1` clone) disconnect base and pr-merge BY CONSTRUCTION,
// so after #516 the fail-closed arm would withhold the diff on essentially
// EVERY production review. The recovery: when the merge-base lookup fails,
// the checkout is deepened in bounded steps until the fork point resolves
// or the small budget is spent; an unresolvable graph still ends at the
// SAME withheld terminal state. And an empty diff at a RESOLVED fork point
// is reported as an empty PR, never as an unavailable diff.
//
// Pinned here:
//   1. END-TO-END recovery: through the real review-pr.sh on a shallow
//      fixture whose fork point sits one base commit deep, the script's own
//      `--depth 1` fetches disconnect the two refs, the bounded deepen
//      resolves the fork point, and the reviewer grades the PR's OWN diff —
//      never the two-dot sibling-reversal artifact, never the withheld
//      marker.
//   2. END-TO-END budget exhaustion: a graph the deepen budget cannot
//      connect stays WITHHELD — deepening changed the budget, never the
//      fail-closed semantics (#516's contract, terminal state unchanged).
//   3. END-TO-END empty PR: the fork point resolves, both diffs run clean,
//      and the task text reports an EMPTY diff — not the old false
//      "could not be diffed at the resolved fork point".
//   4. STRUCTURAL: the degrade arm is gone, the diff is computed from the
//      explicitly resolved merge-base, deepening exists and is guarded by
//      the failed lookup (only on failure, bounded budget), and the
//      empty-diff wording is honest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_PR = path.join(ROOT, "scripts", "review-pr.sh");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
// issue #582/#621: spawnSync NEVER throws — a failed fixture-SETUP call used
// to resolve silently: a non-zero init/commit/push changed nothing the asserts
// could see, so the suite stayed green while measuring a different fixture
// topology than the one the docblock describes. Fixture CONSTRUCTION asserts
// every call: a non-zero exit (or a spawn-level error) throws with the failed
// argv + captured stderr, so fixture breakage goes red naming the exact call
// (the PR #589 gitSetup shape). Every git call in this suite IS construction —
// the review stage's own git traffic runs inside the script-under-test, behind
// the PATH git shim — so the plain unchecked helper has no remaining users.
const gitSetup = (args, opts = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  if (r.error || r.status !== 0) {
    throw new Error(
      `fixture setup failed: git ${args.join(" ")} (exit ${r.status ?? "?"})\n${r.error ?? r.stderr}`,
    );
  }
  return r;
};

// This lane's `git` may be the dsh scrub shim (a script whose shebang needs
// PATH); the fixture bakes the REAL git into its PATH shim so the shim's
// passthrough arm cannot recurse through itself (the rename-compat shape).
const REAL_GIT = process.env.GIT_SCRUB_REAL
  || spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

// The ship-changes.test.mjs lesson: when this suite runs inside a dsh
// driver child, the ambient PATH carries the driver's transient scrub-shim
// dirs (dsh-shim.<pid>) WITHOUT their env contract, and the review stage's
// git calls die loud on them. Drop exactly those dirs; keep the rest of the
// ambient PATH (tests-lint forbids hard-coding system dirs).
const ambientPathWithoutDriverShims = (p = process.env.PATH || "") =>
  p
    .split(path.delimiter)
    .filter((dir) => !path.basename(dir).startsWith("dsh-shim."))
    .join(path.delimiter);

// Fixture origin: base (master) = fork commit c1 (REVIEW.md + a.txt) plus
// `baseAhead` base-side landings past the fork (default 1: the SIBLING
// landing c2 with sibling.txt). The PR branches from c1 and adds
// pr-file.txt (c3); refs/pull/77/merge points at c3 (the trial merge is
// assumed clean, as GitHub reported for #495) — or at the base tip for
// emptyPR (an empty PR: pr-merge == base tree).
const fixture = ({ baseAhead = 1, emptyPR = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pr-diff-test-"));
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  gitSetup(["init", "-q", "--bare", "-b", "master", bare]);
  gitSetup(["init", "-q", "-b", "master", seed]);
  gitSetup(["config", "user.name", "tester"], { cwd: seed });
  gitSetup(["config", "user.email", "tester@example.com"], { cwd: seed });
  writeFileSync(path.join(seed, "REVIEW.md"), "# rules contract fixture\n");
  writeFileSync(path.join(seed, "a.txt"), "base content\n");
  gitSetup(["add", "-A"], { cwd: seed });
  gitSetup(["commit", "-q", "-m", "c1 fork point"], { cwd: seed });
  const fork = gitSetup(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  writeFileSync(path.join(seed, "sibling.txt"), "sibling-landed work\n");
  gitSetup(["add", "-A"], { cwd: seed });
  gitSetup(["commit", "-q", "-m", "c2 sibling lands on base"], { cwd: seed });
  for (let i = 2; i <= baseAhead; i++) {
    // base keeps advancing past the fork; deep enough, no deepen budget
    // within review-pr.sh's steps (1+2+4 ⇒ boundary depth 8) can reconnect
    // the graph (baseAhead=12 ≫ 8 pins the budget-exhaustion terminal).
    gitSetup(["commit", "-q", "--allow-empty", `-m base advance ${i}`], { cwd: seed });
  }
  gitSetup(["push", "-q", bare, "master"], { cwd: seed });
  const baseTip = gitSetup(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  gitSetup(["checkout", "-q", "-b", "pr-branch", fork], { cwd: seed });
  writeFileSync(path.join(seed, "pr-file.txt"), "the PR's own change\n");
  gitSetup(["add", "-A"], { cwd: seed });
  gitSetup(["commit", "-q", "-m", "c3 the PR change"], { cwd: seed });
  gitSetup(["push", "-q", bare, "pr-branch:refs/heads/pr-branch"], { cwd: seed });
  const prTip = gitSetup(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  gitSetup(["--git-dir", bare, "update-ref", "refs/pull/77/merge", emptyPR ? baseTip : prTip]);
  return { dir, bare };
};

// The wrapper toolkit: review-pr.sh resolves its stage scripts off
// $DSH_AGENT_TOOLKIT_DIR, so the driver is a STUB (it dumps the task text
// it was handed — the exact bytes the reviewer would read) and the node
// stages are the real ones.
const wrapperToolkit = (dir) => {
  const toolkit = path.join(dir, "toolkit", "scripts");
  mkdirSync(toolkit, { recursive: true });
  const taskOut = path.join(dir, "reviewer-task.txt");
  writeFileSync(path.join(toolkit, "run-dsh-agent.sh"), `#!/usr/bin/env bash
printf '%s' "$1" > "\${STUB_TASK_OUT:?STUB_TASK_OUT unset}"
echo "stub driver ran"
echo "## Verdict: APPROVE"
`);
  for (const f of ["scrub-output.mjs", "review-verdict.mjs", "pr-verification.mjs"]) {
    copyFileSync(path.join(ROOT, "scripts", f), path.join(toolkit, f));
  }
  for (const f of ["run-dsh-agent.sh"]) spawnSync("chmod", ["+x", path.join(toolkit, f)]);
  return { toolkit: path.join(dir, "toolkit"), taskOut };
};

const runReviewPr = ({ dir, bare }) => {
  const worktree = path.join(dir, "worktree");
  // The production trigger, verbatim: a shallow checkout. (On the local
  // transport the review stage's --depth 1 fetches then graft base and
  // pr-merge into disconnected roots — verified: `git merge-base` exits 1
  // here, the exact #495 failure.)
  gitSetup(["clone", "-q", "--depth", "1", bare, worktree]);
  const shims = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(shims, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const ghLog = path.join(logs, "gh.log");
  const { toolkit, taskOut } = wrapperToolkit(dir);
  writeFileSync(path.join(shims, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "${ghLog}"
case " $* " in
  *" pr view "*) echo '{"baseRefName":"master","headRefName":"pr-branch","title":"fixture pr"}' ;;
  *"contents/REVIEW.md"*) exit 1 ;;                     # rules fall back to the worktree copy
  *" pr checks "*) echo "fake-check  pass" ;;
  *" pr comment "*) echo "https://github.com/owner/repo/pull/77#issuecomment-1" ;;
  *) exit 0 ;;                                          # label ops, verification polling: silent success
esac
`);
  // git shim: point github.com remotes at the fixture bare; everything else
  // passes through to the REAL git (the review stage's fetches ride this).
  writeFileSync(path.join(shims, "git"), `#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in https://github.com/*) a="${bare}";; esac
  args+=("$a")
done
exec "${REAL_GIT}" "\${args[@]}"
`);
  for (const f of ["gh", "git"]) spawnSync("chmod", ["+x", path.join(shims, f)]);
  const res = spawnSync("bash", [REVIEW_PR], {
    encoding: "utf8",
    timeout: 90000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DSH_"))),
      GH_TOKEN: "fake-token",
      DSH_SHIP_REPO: "owner/repo",
      PR_NUM: "77",
      DSH_AGENT_TOOLKIT_DIR: toolkit,
      DSH_WORKTREE: worktree,
      DSH_REVIEW_OUT: path.join(logs, "review-output.txt"),
      DSH_RUN_ID: "review-pr-diff-test",
      STUB_TASK_OUT: taskOut,
      // merge-guard seam: verification polling never leaves the box here
      PR_VERIFICATION_GH: "/nonexistent/gh-for-test",
      PATH: `${shims}${path.delimiter}${ambientPathWithoutDriverShims()}`,
    },
  });
  return { res, taskOut, ghLog };
};

test("issue #519 e2e: the bounded deepen RECOVERS the fork point on the production shallow flow — the reviewer grades the PR's own diff", () => {
  const fx = fixture(); // base is 1 commit past the fork: disconnected at depth 1, resolvable at depth 2
  try {
    const { res, taskOut, ghLog } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /diff --git a\/pr-file\.txt/,
      "the fork point resolved: the reviewer grades the PR's OWN change (issue #519 recovery)");
    assert.doesNotMatch(task, /sibling\.txt/,
      "the two-dot artifact must never surface: the sibling landing would read as a PR reversal (the PR #495 false accusation)");
    assert.doesNotMatch(task, /\(diff unavailable/,
      "the diff is NOT withheld on the standard production flow — that withholding-on-every-review is the #519 residual");
    assert.match(task, /deepened in bounded steps/,
      "the basis line discloses the deepen recovery (reviewer-visible provenance)");
    assert.match(task, /HAS advanced since the fork/,
      "the basis line still reports base advancement past the fork");
    assert.match(task, /Diff basis \(issue #516\):/, "the prompt states the diff basis");
    assert.match(`${res.stdout}${res.stderr}`, /verdict APPROVE/, "the review pipeline completes on the recovered diff");
    assert.match(readFileSync(ghLog, "utf8") || "", /pr comment/, "the review was still posted");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #519 e2e: a graph the deepen budget cannot connect stays WITHHELD — deepening never changed the fail-closed semantics", () => {
  // base is 12 commits past the fork; the bounded steps (1+2+4 ⇒ boundary
  // depth 8) cannot reach the fork, so the #516 terminal state must fire.
  const fx = fixture({ baseAhead: 12 });
  try {
    const { res, taskOut } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /\(diff unavailable/, "the diff is WITHHELD, fail-closed (issue #516 terminal, intact under #519)");
    assert.match(task, /fork point UNRESOLVABLE/, "the basis line names the shallow-graph cause");
    assert.doesNotMatch(task, /sibling\.txt/,
      "the two-dot artifact must never surface: withheld means never a two-dot diff");
    assert.doesNotMatch(task, /pr-file\.txt/,
      "withheld means withheld: the PR's own change is absent too (fail-closed over wrong)");
    assert.doesNotMatch(task, /deepened in bounded steps/,
      "the recovery never fired here — no deepen provenance may be claimed on an unresolved graph");
    assert.match(task, /Diff basis \(issue #516\):/, "the prompt states the diff basis");
    assert.match(`${res.stdout}${res.stderr}`, /verdict APPROVE/, "the review pipeline completes on the withheld diff");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #519 e2e: an empty diff at a RESOLVED fork point is reported as an empty PR — never as an unavailable diff", () => {
  const fx = fixture({ emptyPR: true }); // merge ref == base tip: pr-merge carries no tree change
  try {
    const { res, taskOut } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /the diff is EMPTY/,
      "the honest empty-PR message (the #519 adjacent nit)");
    assert.doesNotMatch(task, /could not be diffed at the resolved fork point/,
      "the diffs RAN CLEAN here — the old text asserted a failure that never happened");
    assert.doesNotMatch(task, /\(diff unavailable/,
      "an empty diff is not an unavailable diff");
    assert.match(task, /an empty PR, not a withheld one/,
      "the basis line tells the reviewer which case this is");
    assert.match(`${res.stdout}${res.stderr}`, /verdict APPROVE/, "the review pipeline completes on the empty diff");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #516/#519 structural: the diff fallback can never change diff semantics again, and deepening is guarded + bounded", () => {
  const rp = read("scripts", "review-pr.sh");
  // The pin grades CODE, not prose: the script's comment quotes the retired
  // bug verbatim as the receipt — strip full-line comments first.
  const code = rp.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.ok(!code.includes("|| echo origin/base"),
    "the `|| echo origin/base` two-dot degrade arm is gone (the #495 bug)");
  assert.match(rp, /FORK_BASE="\$\(git merge-base origin\/base origin\/pr-merge 2>\/dev\/null \|\| true\)"/,
    "the merge-base is resolved explicitly, degrade-safe (the ship-changes.sh freshness shape)");
  assert.match(rp, /git diff "\$FORK_BASE" origin\/pr-merge/,
    "the diff is computed from the RESOLVED fork point — two-dot from the merge-base IS the three-dot semantics, with no fallback arm left to substitute another range");
  assert.match(rp, /HAS advanced since the fork/, "the basis line reports base advancement past the fork");
  assert.match(rp, /NOT advanced since the fork/, "the basis line reports an unadvanced base");
  assert.match(rp, /could NOT be isolated/, "the withheld message names what cannot be done");
  // Issue #519: the recovery exists, is guarded by the FAILED lookup, and
  // is bounded — deepen only ever runs when the fork point did not resolve,
  // and the budget is a small fixed step list, never an unbounded loop.
  assert.match(rp, /git -c credential\.helper= fetch -q --deepen="\$1" origin/,
    "the deepen arm widens the shallow boundary through the same auth seam as the depth-1 fetches");
  assert.match(rp, /if \[ -z "\$FORK_BASE" \]; then\n  for DEEPEN_STEP in 1 2 4; do/,
    "deepening is guarded by the failed merge-base lookup and bounded to a fixed small budget");
  assert.match(rp, /DEEPEN_STEPS="\$DEEPEN_STEP"/,
    "the basis line can name the deepen step that resolved the fork point (visible provenance)");
  // The #519 adjacent nit: rc-captured diffs make empty honest.
  assert.match(rp, /the diff is EMPTY/,
    "an empty diff at a resolved fork point is reported as an empty PR");
  assert.match(rp, /could not be diffed at the resolved fork point/,
    "the unavailable wording survives — but only for a diff that actually FAILED");
});
