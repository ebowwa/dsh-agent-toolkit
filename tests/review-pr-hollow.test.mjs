// review-pr-hollow.test.mjs — the review stage's hollow-carrier check
// (issue #565): a PR whose head OID equals ANOTHER open PR's head OID
// carries ZERO own delta — the claim branch stacked byte-identical on its
// stacking parent's head, so the graded diff is the PARENT's unmerged
// content while the claim's receipts stay unexecuted. The receipt: PR #564
// opened with its head byte-identical to PR #562's head (8f6d203), its
// PR-level gates check graded the parent's content trivially, and DONE was
// posted with receipts that were never executed — nothing in the ship or
// review path flagged it, because a diff vs main shows the parent's work
// and the reviewer had no way to know the claim's own delta was missing.
//
// Pinned here (issue #565):
//   1. END-TO-END shared head: through the real review-pr.sh on a fixture
//      where PR 77's head OID is also PR 55's, the task text the reviewer
//      reads NAMES the shared carrier as a blocking honesty claim.
//   2. END-TO-END unique head: no other open PR shares the OID → the check
//      reports "none" — the claim must not fire on a healthy PR.
//   3. Degrade-safe: a garbage/empty pr-list body degrades to
//      "unavailable" (the issue #529 guarded-parse shape) — never a crash,
//      never a false accusation.
//   4. STRUCTURAL: the check rides the guarded pr_field read (headRefOid)
//      and is surfaced in the review task as a claim, not a verdict
//      override (labels come only from review-verdict.mjs's parse).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_PR = path.join(ROOT, "scripts", "review-pr.sh");
const read = (...p) => readFileSync(path.join(ROOT, ...p), "utf8");
const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });

const REAL_GIT = process.env.GIT_SCRUB_REAL
  || spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

const ambientPathWithoutDriverShims = (p = process.env.PATH || "") =>
  p
    .split(path.delimiter)
    .filter((dir) => !path.basename(dir).startsWith("dsh-shim."))
    .join(path.delimiter);

// Fixture origin (the review-pr-diff.test.mjs shape): base (master) = fork
// c1 + a sibling landing c2. The PR branches from c1 and adds pr-file.txt
// (c3); refs/pull/77/merge points at c3. `siblingPr` points ANOTHER branch
// (parent-branch) at the SAME c3 — two open PRs, one head OID: the hollow
// shape of the PR #564 receipt.
const fixture = ({ siblingPr = false } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pr-hollow-test-"));
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
  const baseTip = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  git(["checkout", "-q", "-b", "pr-branch", fork], { cwd: seed });
  writeFileSync(path.join(seed, "pr-file.txt"), "the PR's own change\n");
  git(["add", "-A"], { cwd: seed });
  git(["commit", "-q", "-m", "c3 the PR change"], { cwd: seed });
  git(["push", "-q", bare, "pr-branch:refs/heads/pr-branch"], { cwd: seed });
  const prTip = git(["rev-parse", "HEAD"], { cwd: seed }).stdout.trim();
  if (siblingPr) {
    // the stacking parent's branch: byte-identical head (the #564 shape)
    git(["branch", "parent-branch", prTip], { cwd: seed });
    git(["push", "-q", bare, "parent-branch:refs/heads/parent-branch"], { cwd: seed });
  }
  git(["--git-dir", bare, "update-ref", "refs/pull/77/merge", prTip]);
  return { dir, bare, prTip, baseTip };
};

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

const runReviewPr = ({ dir, bare, prTip, baseTip, siblingPr, garbageList }) => {
  const worktree = path.join(dir, "worktree");
  git(["clone", "-q", "--depth", "1", bare, worktree]);
  const shims = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(shims, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const ghLog = path.join(logs, "gh.log");
  const { toolkit, taskOut } = wrapperToolkit(dir);
  // pr list: the open-PR heads the hollow-carrier check compares against.
  // A garbage body (garbageList) exercises the guarded-parse degrade.
  const openPrs = siblingPr
    ? [{ number: 77, headRefOid: prTip }, { number: 55, headRefOid: prTip }]
    : [{ number: 77, headRefOid: prTip }, { number: 55, headRefOid: baseTip }];
  writeFileSync(path.join(shims, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "${ghLog}"
case " $* " in
  *" pr view "*) echo '{"baseRefName":"master","headRefName":"pr-branch","headRefOid":"${prTip}","title":"fixture pr"}' ;;
  *" pr list "*)
    if [ -n "\${GARBAGE_LIST:-}" ]; then echo "API rate limit exceeded (403)"; else
      echo '${JSON.stringify(openPrs)}'
    fi ;;
  *"contents/REVIEW.md"*) exit 1 ;;                     # rules fall back to the worktree copy
  *" pr checks "*) echo "fake-check  pass" ;;
  *" pr comment "*) echo "https://github.com/owner/repo/pull/77#issuecomment-1" ;;
  *) exit 0 ;;                                          # label ops, verification polling: silent success
esac
`);
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
      DSH_RUN_ID: "review-pr-hollow-test",
      STUB_TASK_OUT: taskOut,
      PR_VERIFICATION_GH: "/nonexistent/gh-for-test",
      GARBAGE_LIST: garbageList ? "1" : "",
      PATH: `${shims}${path.delimiter}${ambientPathWithoutDriverShims()}`,
    },
  });
  return { res, taskOut, ghLog };
};

test("issue #565 e2e: a head OID shared with another open PR surfaces as a blocking claim in the review task", () => {
  const fx = fixture({ siblingPr: true });
  try {
    const { res, taskOut } = runReviewPr({ ...fx, siblingPr: true });
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /Hollow-carrier check \(issue #565\):/,
      "the check is part of the review task the reviewer grades");
    assert.match(task, /#55/,
      "the shared carrier is NAMED — the reviewer learns the diff above is PR #55's content");
    assert.match(task, /blocking honesty\s+finding/,
      "the shared head is framed as blocking (the #564 receipt class)");
    assert.match(`${res.stdout}${res.stderr}`, /verdict APPROVE/,
      "the verdict still belongs to the reviewer's own line — surfacing is not an override");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #565 e2e: a unique head OID reports none — the claim never fires on a healthy PR", () => {
  const fx = fixture({ siblingPr: false });
  try {
    const { res, taskOut } = runReviewPr({ ...fx, siblingPr: false });
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /Hollow-carrier check \(issue #565\):/);
    assert.match(task, /none/,
      "no other open PR shares the head — the check says so and stops");
    assert.doesNotMatch(task, /#55/,
      "a healthy PR's sibling is never branded a shared carrier");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #565 e2e: a garbage pr-list body degrades to unavailable — never a crash, never a false claim", () => {
  const fx = fixture({ siblingPr: false });
  try {
    // GARBAGE_LIST makes the shim answer pr list with a rate-limit body —
    // the exact non-JSON stdout the #529 guarded-parse rule exists for
    const { res, taskOut } = runReviewPr({ ...fx, siblingPr: false, garbageList: true });
    assert.equal(res.status, 0, `review stage must complete (got ${res.status}):\n${res.stderr}`);
    const task = readFileSync(taskOut, "utf8");
    assert.match(task, /unavailable \(open-PR head lookup failed\)/,
      "the degrade is typed and reviewer-visible");
    assert.doesNotMatch(task, /#55/,
      "a failed lookup accuses nobody");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("issue #565 structural: the carrier read is guarded and the claim rides the task text, not the verdict", () => {
  const rp = read("scripts", "review-pr.sh");
  assert.match(rp, /baseRefName,headRefName,headRefOid,title/,
    "headRefOid rides the guarded PR-facts read (issue #529 shape)");
  assert.match(rp, /HEAD_OID="\$\(pr_field "\$PR_JSON" headRefOid\)"/);
  assert.match(rp, /Hollow-carrier check \(issue #565\):/,
    "the claim is composed into the reviewer's task text");
  assert.match(rp, /unavailable \(open-PR head lookup failed\)/,
    "the degrade is typed, never an empty string");
  // labels come ONLY from review-verdict.mjs's line-strict parse — the
  // hollow claim must not bypass the verdict pipeline
  assert.ok(rp.indexOf("HOLLOW_CARRIER") < rp.indexOf("review-verdict.mjs"),
    "the check feeds the task, the verdict pipeline stays downstream and untouched");
});
