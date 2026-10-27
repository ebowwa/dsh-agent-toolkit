#!/usr/bin/env node
// approved-lane.mjs — the approved-unmerged lane guard (issue #643).
//
// The receipt (issue #643, all on this repo's history): PR #495 carried a
// review verdict "VERDICT: APPROVE · MERGE — Blocking findings: none" and
// a completed/success `gates` run on its head (667a2f7). The merge never
// happened — the run's exit custody write was lost, the tower's
// reconciliation marked the claim done and "NOT re-dispatched", and four
// days later the stale-close pass retired the PR ("branch-hygiene —
// closing: stale — idle 3.2d (> 3d)") and the head was deleted. PR #544
// died the same way. The reviewed work had NO path back to main — the
// files existed nowhere but refs/pull/495/head until #521's agent
// resurrected them by hand.
//
// The seam: "a PR is idle" and "a PR's work is approved but unlanded"
// were never DISTINGUISHED — no machine-readable surface answers it, so
// every retire/sweep/reconcile pass had to guess. This script is that
// surface, one question, first-party evidence only:
//
//   does this PR carry landing-pending approved work — a passing
//   merge-guard gates check ON its head SHA, and/or a final APPROVE
//   verdict on its review channels — that has not landed on main?
//
// Channels (all re-read from the API, none trusted from prose):
//   gates   delegated to the sibling merge-guard.sh (ONE implementation
//           of the gates-on-head semantics — completed/success ON the
//           exact head SHA, paged to exhaustion, the #434/#566/#1132
//           rules; MERGE_GUARD_CHECK passes through the environment for
//           consumer repos that name their gates job differently).
//   votes   `gh api pulls/N/reviews` — the native channel where real
//           reviewers exist (consumer repos): the last APPROVED /
//           CHANGES_REQUESTED review by submission time.
//   comment the shared-account fleet's channel (issue #326: `gh pr
//           review --approve` is structurally impossible for any fleet
//           agent, verdicts ride comment text): every PR comment parsed
//           line-strict by the sibling review-verdict.mjs — "## Verdict:
//           APPROVE" IS a verdict, "…against REVIEW.md — VERDICT:
//           APPROVE · MERGE" inside a prose line is NOT (line-strict,
//           the drift-verdict lesson). The last verdict-carrying comment
//           by creation time.
//
// Across the two verdict channels, the LATER signal wins (an exact tie
// prefers the comment — the fleet's native surface). A final REQUEST
// CHANGES vetoes: approved requires verdict APPROVE, or a silent verdict
// channel with gates green (the issue's own "and/or" — a CI-graded head
// is not an idle lane either).
//
// Consumers (issue #643's ask, "either half closes the seam"):
//   - a stale-close/retire pass: `approved` (exit 0) ⇒ skip or loud-flag
//     — an approved PR is not an idle lane;
//   - the sweep half in this repo: scripts/orphan-branch-sweep.sh
//     refuses to reap a branch whose newest closed-unmerged PR is
//     `approved` — the head is the only independent copy of the work;
//   - a custody reconciliation: `merged` vs `approved` vs `idle` IS the
//     distinction between "the claim run finished", "the work is on
//     main", and "nothing landing-pending here" — a done-mark whose PR
//     reads `approved` re-queues the landing instead of asserting "NOT
//     re-dispatched".
//
// Honesty limits (stated, not hidden): the verdict channel cannot bind a
// comment to a head SHA — a verdict posted for an older head counts
// until a newer verdict replaces it. The --json surface carries the head
// SHA plus each signal's url/timestamp so a consumer can judge
// freshness; a stale-close pass that retires on idle-math alone
// (updatedAt) resets its clock on any push, which covers the advanced-
// head case in practice.
//
// Usage: node approved-lane.mjs <pr-number|url|branch> [--json]
//   stdout (plain): approved pr#7 gates=green verdict=approve
//                   idle pr#7 gates=not-green verdict=none
//                   merged pr#7 gates=green verdict=none
//                 (number/url targets preferred — a bare branch resolves
//                  only while its PR is open)
//   stdout (--json): {"verdict":"approved|idle|merged","pr":N,
//                     "head":"<sha>","url":"<pr-url>","state":"OPEN|CLOSED|MERGED",
//                     "merged":bool,"mergedAt":iso|null,
//                     "gates":{"green":bool,"receipt":"..."},
//                     "review":{"verdict":"approve|request-changes|none",
//                               "source":"comment|review-vote|null",
//                               "id":N,"author":"login","url":"...","at":iso}}
//   exit:  0 approved — landing-pending approved work; a retire/close
//            pass must skip or loud-flag it (issue #643);
//          1 NOT an approved lane — `idle` (no approval signal; the
//            pass proceeds by its own rules) or `merged` (the work is
//            already on main; nothing to protect);
//          2 unresolvable (no gh, PR unresolvable, any channel's API
//            failed) — typed reason on stderr; fail-closed, NEVER
//            readable as idle (a pass must refuse, not retire).
//
// Provenance, not bodies (the pr-verification rule): comment and review
// text is unscrubbed agent output — this tool emits only verdict words,
// ids, authors, urls, timestamps, and merge-guard's own typed lines; a
// body never passes through stdout, plain or --json.
//
// Env contract:
//   APPROVED_LANE_GH  gh binary to use (default `command -v gh`) — the
//                     hermetic test seam (the pr-verification pattern);
//                     also handed to merge-guard.sh as MERGE_GUARD_GH
//                     unless the caller set MERGE_GUARD_GH itself.
//   MERGE_GUARD_CHECK passes through to merge-guard.sh (the #1132
//                     explicit-name assertion for consumer repos).
//   GH_TOKEN          pass through to gh, as usual.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1] ?? "."));

const unresolvable = msg => {
  console.error(`approved-lane: REFUSED (unresolvable) — ${msg}`);
  process.exit(2);
};

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const target = argv.find(a => a !== "--json");
if (!target) {
  console.error("approved-lane: usage: node approved-lane.mjs <pr-number|url|branch> [--json]");
  process.exit(2);
}

// Resolve gh ONCE to an absolute path: spawnSync resolves a bare name
// through PATH, but merge-guard's handoff seam tests `[ -x "$GH_BIN" ]`
// as a filesystem path — a bare name would refuse there (found live: the
// default-name handoff failed #434's executability check). The
// resolution itself is fail-closed: no gh on PATH => exit 2.
let GH = process.env.APPROVED_LANE_GH || "gh";
if (!path.isAbsolute(GH)) {
  const which = spawnSync("bash", ["-c", 'command -v "$1"', "resolve-gh", GH], { encoding: "utf8" });
  const resolved = (which.stdout || "").trim();
  if (which.status !== 0 || !resolved) {
    unresolvable(`gh '${GH}' not found on PATH (${which.error?.code ?? `exit ${which.status}`}) — set APPROVED_LANE_GH to an absolute path`);
  }
  GH = resolved;
}
const gh = args => spawnSync(GH, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const probe = spawnSync(GH, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  // A broken/missing gh is unresolvable, never "no signals" — retiring a
  // branch on a broken read is deleting blind.
  unresolvable(`gh not usable at '${GH}' (${probe.error?.code ?? `exit ${probe.status}`}) — set APPROVED_LANE_GH`);
}

// 1. Resolve the PR (number, head SHA, url, state, mergedAt — the merged
//    field IS the custody half's question: "is the work on main?").
const view = gh(["pr", "view", target, "--json", "number,headRefOid,url,state,mergedAt"]);
let pr = null;
try { pr = JSON.parse(view.stdout); } catch { /* falls through to the guard below */ }
if (view.status !== 0 || !pr || !pr.number || !pr.headRefOid || !pr.url) {
  unresolvable(`cannot resolve PR ${target}: ${(view.stderr || view.stdout || "").trim().slice(0, 200)}`);
}
const repoPath = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
if (!repoPath) unresolvable(`cannot parse owner/repo from PR url '${pr.url}'`);
const [owner, repo] = repoPath.slice(1);

// 2. Gates channel — DELEGATED to merge-guard.sh so the gates-on-head
//    semantics live in exactly one place (drift between two
//    implementations is the defect class REVIEW.md names). rc 0 = green,
//    rc 1 = not green (a typed answer, not an error), rc 2 = unresolvable
//    (propagates — a broken read is never "not green").
const guardEnv = { ...process.env, MERGE_GUARD_GH: process.env.MERGE_GUARD_GH || GH };
const guard = spawnSync(
  "bash",
  [path.join(SCRIPT_DIR, "merge-guard.sh"), "check", String(pr.number)],
  { encoding: "utf8", env: guardEnv, maxBuffer: 4 * 1024 * 1024 },
);
if (guard.status === 2) {
  unresolvable(`gates channel unresolvable via merge-guard: ${(guard.stderr || guard.stdout || "").trim().split("\n")[0]?.slice(0, 200)}`);
}
if (guard.status !== 0 && guard.status !== 1) {
  unresolvable(`merge-guard.sh exited ${guard.status} for PR #${pr.number}: ${(guard.stderr || "").trim().slice(0, 200)}`);
}
const gates = {
  green: guard.status === 0,
  receipt: ((guard.status === 0 ? guard.stdout : guard.stderr) || "").trim().split("\n")[0] || "",
};

// 3. Verdict channels. Both are read to exhaustion (paginated), oldest →
//    newest; the LAST verdict signal on each channel is that channel's
//    final word, then the later of the two channels wins.
const readSignal = (row, kind) => {
  if (kind === "vote") {
    if (row?.state === "APPROVED") return { verdict: "APPROVE", source: "review-vote" };
    if (row?.state === "CHANGES_REQUESTED") return { verdict: "REQUEST CHANGES", source: "review-vote" };
    return null; // COMMENTED / DISMISSED / PENDING carry no verdict
  }
  return null;
};

const votesResp = gh(["api", "--paginate", `repos/${owner}/${repo}/pulls/${pr.number}/reviews`]);
let votes = null;
try { votes = JSON.parse(votesResp.stdout); } catch { /* guarded below */ }
if (votesResp.status !== 0 || !Array.isArray(votes)) {
  unresolvable(`reviews API failed for ${owner}/${repo}#${pr.number}: ${(votesResp.stderr || "").trim().slice(0, 200)}`);
}

const commentsResp = gh(["api", "--paginate", `repos/${owner}/${repo}/issues/${pr.number}/comments`]);
let comments = null;
try { comments = JSON.parse(commentsResp.stdout); } catch { /* guarded below */ }
if (commentsResp.status !== 0 || !Array.isArray(comments)) {
  unresolvable(`comments API failed for ${owner}/${repo}#${pr.number}: ${(commentsResp.stderr || "").trim().slice(0, 200)}`);
}

// The comment channel reuses review-verdict.mjs's line-strict parse via a
// temp-file seam (the pr-verification pattern): the sibling stays the ONE
// implementation of "what line is a verdict", and bodies never echo.

/**
 * Reap this tool's own stale siblings before minting (the residue half of
 * the #2698 invariant). A SIGKILL runs no code, so no teardown below can
 * fire for that kill — a wedged consumer's watchdog SIGKILLs the tree — and
 * the next invocation reclaims what the killed one left. Exact prefix, an
 * age budget far past this tool's runtime, real dirs only, never throws.
 */
const STALE_MS = 60 * 60 * 1000;
const reapStaleScratch = (prefix) => {
  let names;
  try { names = readdirSync(tmpdir()); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      const p = path.join(tmpdir(), name);
      if (!statSync(p).isDirectory()) continue;
      if (now - statSync(p).mtimeMs < STALE_MS) continue;
      rmSync(p, { recursive: true, force: true });
    } catch { continue; }
  }
};
reapStaleScratch("approved-lane-");
// TEARDOWN THE CALLER CANNOT SKIP — AT THE ALLOCATION SITE. The mint lives
// INSIDE the try below and the remove-tree is the finally's body, so the
// dir dies on every exit shape that unwinds: normal fall-through, a thrown
// error, any future arm added to the try. `process.exit()` does NOT unwind
// — it would skip any finally — so the verdict arm no longer exits from
// inside the try: it records the code and exits AFTER the finally has run,
// making the removal synchronous instead of exit-hook-best-effort. That
// ordering is the point (measured history: +28 stranded dirs per suite run
// across the sibling tool, and bun's process.on('exit') firing is runtime-
// context-dependent — it fires for plain `bun script` on bun 1.3.14 but
// not inside bun test). The exit + signal hooks stay armed below as
// belt-and-suspenders for the pre-try window and signal kills; the finally
// is the arm that no longer depends on the runner's courtesy.
let dir = null;
let dirSwept = false;
const sweepDir = () => {
  if (dirSwept || !dir) return;
  dirSwept = true;
  rmSync(dir, { recursive: true, force: true });
};
process.on("exit", sweepDir);
for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  process.on(signal, () => {
    sweepDir();
    process.exit(code);
  });
}
let exitCode = 1;
try {
  dir = mkdtempSync(path.join(tmpdir(), "approved-lane-"));
  const verdictTool = path.join(SCRIPT_DIR, "review-verdict.mjs");
  let voteSignal = null;
  for (const v of votes) {
    const s = readSignal(v, "vote");
    if (!s) continue;
    const at = v.submitted_at || "";
    // Last signal wins by (submitted_at, id) — a reconsidered review
    // (approve → request changes) is the thread's final word.
    if (!voteSignal || at > voteSignal.at || (at === voteSignal.at && (v.id ?? 0) >= (voteSignal.id ?? 0))) {
      voteSignal = { ...s, at, id: v.id ?? null, author: v?.user?.login ?? "unknown", url: v?.html_url ?? null };
    }
  }

  let commentSignal = null;
  for (const c of comments) {
    if (typeof c?.body !== "string" || c.body === "") continue;
    const f = path.join(dir, "comment.txt");
    writeFileSync(f, c.body);
    const r = spawnSync(process.execPath, [verdictTool, f], { encoding: "utf8" });
    if (r.status !== 0) continue; // unreadable input is not a verdict
    const word = r.stdout.trim();
    if (word !== "APPROVE" && word !== "REQUEST CHANGES") continue;
    const s = { verdict: word, source: "comment" };
    const at = c.created_at || "";
    if (!commentSignal || at >= commentSignal.at) {
      commentSignal = { ...s, at, id: c.id ?? null, author: c?.user?.login ?? "unknown", url: c?.html_url ?? null };
    }
  }

  // Later signal wins across channels; an exact tie prefers the comment
  // (the shared-account fleet's native verdict surface, issue #326).
  let review = { verdict: "none", source: null, id: null, author: null, url: null, at: null };
  if (voteSignal && commentSignal) {
    review = commentSignal.at >= voteSignal.at ? commentSignal : voteSignal;
  } else if (commentSignal || voteSignal) {
    review = commentSignal || voteSignal;
  }
  const verdictWord = review.verdict === "APPROVE" ? "approve"
    : review.verdict === "REQUEST CHANGES" ? "request-changes" : "none";

  // 4. Decide. mergedAt first (the custody question); then the issue's
  //    own "and/or": APPROVE verdict, or gates green with a silent
  //    verdict channel; a final REQUEST CHANGES vetoes either way.
  const merged = Boolean(pr.mergedAt);
  let verdict;
  if (merged) {
    verdict = "merged";
  } else if (verdictWord === "approve") {
    verdict = "approved";
  } else if (verdictWord === "none" && gates.green) {
    verdict = "approved";
  } else {
    verdict = "idle";
  }

  const payload = {
    verdict,
    pr: pr.number,
    head: pr.headRefOid,
    url: pr.url,
    state: pr.state || "UNKNOWN",
    merged,
    mergedAt: pr.mergedAt ?? null,
    gates: { green: gates.green, receipt: gates.receipt },
    review: { verdict: verdictWord, source: review.source, id: review.id, author: review.author, url: review.url, at: review.at },
  };
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`${verdict} pr#${pr.number} gates=${gates.green ? "green" : "not-green"} verdict=${verdictWord}\n`);
  }
  exitCode = verdict === "approved" ? 0 : 1;
} finally {
  sweepDir();
}
process.exit(exitCode);
