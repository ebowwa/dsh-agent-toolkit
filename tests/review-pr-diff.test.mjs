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
//
// Issue #628 closes: the FRESHNESS prose can never come from
// merge-base(base, pr-merge) — GitHub builds the preview by merging the PR
// head into the CURRENT base tip, so that lookup is the base tip by
// construction and "NOT advanced" was asserted unconditionally (the #574
// false prose, whose printed hash was the base TIP while the true fork sat
// 3 base merges back). Pinned here: a REAL trial-merge-commit fixture
// (first parent = base tip), the prose keys off merge-base(base,
// refs/pull/N/head) — reporting HAS advanced with the TRUE fork hash where
// the old code claimed NOT advanced; a fork-at-tip PR earns its NOT
// advanced claim backed by a real computation; and an unresolvable head
// fork degrades to "freshness UNVERIFIED" while the DIFF itself stays
// available (the diff content was never the bug — only the prose lied).

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
const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

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
// landing c2 with sibling.txt). The PR branches from c1 (or from the base
// tip when `forkFromTip`) and adds pr-file.txt (c3); refs/pull/77/merge
// points at c3 (the trial merge is assumed clean, as GitHub reported for
// #495) — or at the base tip for emptyPR (an empty PR: pr-merge == base
// tree) — or at a REAL trial-merge commit for `trialMerge` (issue #628:
// GitHub's preview merges the PR head into the CURRENT base tip, so its
// FIRST PARENT is the base tip — the construction that makes
// merge-base(base, pr-merge) the base tip by construction).
const fixture = ({ baseAhead = 1, emptyPR = false, trialMerge = false, forkFromTip = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pr-diff-test-"));
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  git(["init", "-q", "--bare", "-b", "master", bare]);
  git(["init", "-q", "-b", "master", seed]);
  git(["config", "user.name", "tester"], { cwd: seed });
  git(["config", "user.email", "tester@example.com"], { cwd: seed });
  writeFileSync(path.join(seed, "REVIEW.md"), "# rules contract fixture\n");
  writeFileSync(path.join(seed, "a.txt"), "base content\n");
  git(["add", "-A"], { cwd: seed });
  git(["commit", "-q", "-m", "c1 fork point"], { cwd: seed });
  const fork = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  writeFileSync(path.join(seed, "sibling.txt"), "sibling-landed work\n");
  git(["add", "-A"], { cwd: seed });
  git(["commit", "-q", "-m", "c2 sibling lands on base"], { cwd: seed });
  for (let i = 2; i <= baseAhead; i++) {
    // base keeps advancing past the fork; deep enough, no deepen budget
    // within review-pr.sh's steps (1+2+4 ⇒ boundary depth 8) can reconnect
    // the graph (baseAhead=12 ≫ 8 pins the budget-exhaustion terminal).
    git(["commit", "-q", "--allow-empty", `-m base advance ${i}`], { cwd: seed });
  }
  git(["push", "-q", bare, "master"], { cwd: seed });
  const baseTip = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  git(["checkout", "-q", "-b", "pr-branch", forkFromTip ? baseTip : fork], { cwd: seed });
  writeFileSync(path.join(seed, "pr-file.txt"), "the PR's own change\n");
  git(["add", "-A"], { cwd: seed });
  git(["commit", "-q", "-m", "c3 the PR change"], { cwd: seed });
  git(["push", "-q", bare, "pr-branch:refs/heads/pr-branch"], { cwd: seed });
  const prTip = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  // Issue #628: GitHub publishes refs/pull/N/head for every open PR — the
  // freshness prose is derived from it, so the fixture mirrors that.
  git(["--git-dir", bare, "update-ref", "refs/pull/77/head", prTip]);
  if (emptyPR) {
    git(["--git-dir", bare, "update-ref", "refs/pull/77/merge", baseTip]);
  } else if (trialMerge) {
    // The REAL GitHub preview shape (issue #628): a merge commit whose
    // first parent is the CURRENT base tip — not the bare head commit the
    // pre-#628 fixture substituted, whose merge-base geometry is the
    // honest-fork one and could never reproduce the tautology.
    git(["checkout", "-q", "master"], { cwd: seed });
    git(["merge", "-q", "--no-ff", "--no-edit", "-m", "trial merge", "pr-branch"], { cwd: seed });
    git(["push", "-q", bare, "HEAD:refs/pull/77/merge"], { cwd: seed });
  } else {
    git(["--git-dir", bare, "update-ref", "refs/pull/77/merge", prTip]);
  }
  return { dir, bare, fork, baseTip, prTip };
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
  git(["clone", "-q", "--depth", "1", bare, worktree]);
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
  // Issue #628: the freshness prose keys off the PR-head merge-base, never
  // the merge preview (whose merge-base is the base tip by construction),
  // and an unresolvable head fork degrades to UNVERIFIED — no claim.
  assert.match(rp, /HEAD_FORK_BASE="\$\(git merge-base origin\/base origin\/pr-head 2>\/dev\/null \|\| true\)"/,
    "the PR's TRUE fork point is computed from refs/pull/N/head, not the preview (issue #628)");
  assert.match(rp, /refs\/pull\/\$\{PR_NUM\}\/head:refs\/remotes\/origin\/pr-head/,
    "the PR head ref is fetched (and rides the same deepen arm) alongside base and the preview");
  assert.match(rp, /freshness UNVERIFIED/,
    "an unresolvable PR-head fork degrades the prose to UNVERIFIED — the #574 acceptance shape, never a positive claim");
  assert.match(rp, /if \[ -n "\$FORK_BASE" \] && \[ -z "\$HEAD_FORK_BASE" \]; then\n  for HEAD_DEEPEN_STEP in 1 2 4; do/,
    "the head fork point gets the same guarded, bounded deepen recovery as the diff fork point");
});

// Issue #628 e2e: the REAL GitHub preview shape. The trial-merge commit's
// first parent IS the current base tip, so merge-base(base, pr-merge) —
// the old FORK_BASE — equals the base tip and the old prose asserted
// "NOT advanced" unconditionally, even though the PR forked 1+ base commits
// back (the #574 receipt, scaled to this fixture). The fixed prose must
// derive freshness from merge-base(base, refs/pull/N/head) and report the
// advancement.
test("issue #628 e2e: a REAL trial-merge preview cannot assert 'NOT advanced' — freshness keys off the PR-head fork point", () => {
  const fx = fixture({ trialMerge: true });
  try {
    const { res, taskOut } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /HAS advanced since the fork/,
      "the base HAS advanced past the PR's true fork — the tautology's unconditional 'NOT advanced' is gone");
    assert.match(task, new RegExp(`PR-head fork point ${fx.fork}`),
      "the freshness hash is the TRUE fork (merge-base of base and the PR HEAD), not the base tip the preview's geometry yields");
    assert.doesNotMatch(task, /NOT advanced since the fork/,
      "no positive unadvanced claim may survive a real trial-merge preview (the #574 false assertion)");
    assert.match(task, /diff --git a\/pr-file\.txt/,
      "the diff content is unchanged: the PR's own change over the CURRENT base (the #516/#519 semantics)");
    assert.doesNotMatch(task, /sibling\.txt/,
      "the sibling landing still never surfaces as an apparent PR reversal");
    assert.match(task, /issue #628/,
      "the basis line carries the receipt for why the preview's merge-base asserts nothing");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// Issue #628 e2e: the claim's positive arm. A PR forked AT the current base
// tip earns "NOT advanced" — but now the printed hash is PROVEN to be
// merge-base(base, refs/pull/N/head), not merely the preview's first parent.
test("issue #628 e2e: a PR forked AT the base tip earns its 'NOT advanced' claim — backed by a real merge-base(base, head) computation", () => {
  const fx = fixture({ trialMerge: true, forkFromTip: true });
  try {
    const { res, taskOut } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /NOT advanced since the fork/,
      "the base genuinely has not advanced past this PR's fork — the claim fires where it is TRUE");
    assert.match(task, new RegExp(`PR-head fork point ${fx.baseTip}`),
      "the claimed fork point is the base tip AND the proven merge-base of base and the PR head");
    assert.match(task, /diff --git a\/pr-file\.txt/,
      "the diff is still the PR's own change");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// Issue #628 e2e: the degrade arm. The preview's merge-base resolves
// instantly (the tip is its first parent), so the DIFF stays available —
// but the PR-head fork sits 12 commits deep, beyond the deepen budget, so
// the prose must claim NOTHING about freshness (the #574 acceptance shape:
// "fork point unverified" over a positive claim).
test("issue #628 e2e: an unresolvable PR-head fork degrades to 'freshness UNVERIFIED' — the diff stays, the claim does not", () => {
  const fx = fixture({ trialMerge: true, baseAhead: 12 });
  try {
    const { res, taskOut } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /freshness UNVERIFIED/,
      "the prose degrades to UNVERIFIED when the PR-head fork cannot resolve");
    assert.match(task, /PR-head fork point UNRESOLVABLE/,
      "the basis line names the shallow-graph cause for the head fork point");
    assert.doesNotMatch(task, /NOT advanced since the fork/,
      "no unadvanced claim on an unverified graph");
    assert.doesNotMatch(task, /HAS advanced since the fork/,
      "no advancement claim either — UNVERIFIED means no claim at all");
    assert.match(task, /diff --git a\/pr-file\.txt/,
      "the diff is NOT withheld: the preview fork point resolved (only the freshness claim degrades)");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
