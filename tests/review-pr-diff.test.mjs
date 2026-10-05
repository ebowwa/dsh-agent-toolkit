// review-pr-diff.test.mjs — the review stage's diff basis is fail-closed
// (issue #516).
//
// The bug class (PR #495 receipt): review-pr.sh's diff chain ended in
// `|| echo origin/base`, so a FAILED merge-base lookup — exactly the
// shallow-checkout case — silently degraded to a TWO-DOT base→pr-merge
// diff. A two-dot diff reads every sibling landing since the fork point as
// an apparent PR reversal: a clean 6-file PR graded as 12 files of contract
// tampering (REVIEW.md edits + merge-guard disarm it never made), and the
// symmetric risk — a REAL revert hiding among "stale-fork artifacts".
//
// Pinned here:
//   1. END-TO-END, through the real review-pr.sh on a shallow fixture: the
//      script's own `--depth 1` fetches disconnect base and pr-merge, the
//      merge-base lookup fails, and the reviewer's task text must carry the
//      WITHHELD marker — never a two-dot diff, and never either artifact
//      file (not the sibling landing that two-dot would show as a reversal,
//      and not the PR's own file either: withheld means withheld).
//   2. STRUCTURAL: the degrade arm is gone, the diff is computed from the
//      explicitly resolved merge-base (two-dot from the fork point ≡ the
//      three-dot semantics, with no fallback arm left to substitute another
//      range), and the prompt states the diff basis (fork point + whether
//      base advanced) so a withheld diff is visible, not silent.

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

// Fixture origin: base (master) = fork commit c1 (REVIEW.md + a.txt) plus a
// SIBLING landing c2 (sibling.txt) — base advanced past the fork. The PR
// branches from c1 and adds pr-file.txt (c3); refs/pull/77/merge points at
// c3 (the trial merge is assumed clean, as GitHub reported for #495).
const fixture = () => {
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
  git(["push", "-q", bare, "master"], { cwd: seed });
  git(["checkout", "-q", "-b", "pr-branch", fork], { cwd: seed });
  writeFileSync(path.join(seed, "pr-file.txt"), "the PR's own change\n");
  git(["add", "-A"], { cwd: seed });
  git(["commit", "-q", "-m", "c3 the PR change"], { cwd: seed });
  git(["push", "-q", bare, "pr-branch:refs/heads/pr-branch"], { cwd: seed });
  const prTip = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  git(["--git-dir", bare, "update-ref", "refs/pull/77/merge", prTip]);
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

test("issue #516 e2e: a shallow checkout withholds the diff — the reviewer never sees the two-dot sibling-reversal artifact", () => {
  const fx = fixture();
  try {
    const { res, taskOut, ghLog } = runReviewPr(fx);
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /\(diff unavailable/, "the diff is WITHHELD, fail-closed (issue #516)");
    assert.match(task, /fork point UNRESOLVABLE/, "the basis line names the shallow-graph cause");
    assert.doesNotMatch(task, /sibling\.txt/,
      "the two-dot artifact must never surface: the sibling landing would read as a PR reversal (the PR #495 false accusation)");
    assert.doesNotMatch(task, /pr-file\.txt/,
      "withheld means withheld: the PR's own change is absent too (fail-closed over wrong)");
    assert.match(task, /Diff basis \(issue #516\):/, "the prompt states the diff basis");
    assert.match(`${res.stdout}${res.stderr}`, /verdict APPROVE/, "the review pipeline completes on the withheld diff");
    assert.match(readFileSync(ghLog, "utf8") || "", /pr comment/, "the review was still posted (a withheld diff is not a dead review)");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #516 structural: the diff fallback can never change diff semantics again", () => {
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
});
