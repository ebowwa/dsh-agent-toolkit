#!/usr/bin/env node
// pr-verification.mjs — per-PR aggregation of the gate-verify channel
// (issue #326), the consultable surface for whatever weighs independent
// verification into a merge decision.
//
// Why this exists (issue #326): the fleet mints every PR under one shared
// account, so `gh pr review --approve` is structurally impossible for any
// agent ("Review can not approve your own pull request"). An agent that
// ran the gates on a sibling PR posts a comment carrying a line-strict
// `gate-verify: pass|fail` marker (scripts/gate-verify.mjs); this script
// walks the PR's comments AND formal review bodies in order (issue #560:
// a `gh pr review --comment` body is not an issue comment) and reports
// the LAST marker with its
// provenance — machine-consumable, so "a second agent independently
// verified this branch" stops being comment noise.
//
// Consumers:
//   - scripts/merge-guard.sh with MERGE_GUARD_VERIFY=on (opt-in): refuses
//     to merge unless this reports pass.
//   - scripts/review-pr.sh: prior markers surface to the adversarial
//     reviewer as CLAIMS TO CHECK, never as truth.
//
// Provenance, not bodies: a PR comment is unscrubbed agent text, so this
// tool emits only the verdict word + comment id / author / URL — the body
// itself never passes through stdout (fail-closed against the scrub rule;
// the receipts live on GitHub where the URL points).
//
// Usage: node pr-verification.mjs <pr-number|url|branch> [--json]
//   stdout (plain): pass <comment-url> <author>
//                   fail <comment-url> <author>
//                   none
//   stdout (--json): {"verdict":"pass|fail|none","pr":N,"head":"<sha>",
//                     "url":"<pr-url>","markers":<count>,
//                     "comment":{"id":N,"author":"login","url":"..."}|null}
//   exit:  0 pass — a passing verification exists to weigh;
//          1 no passing verification (a fail marker, or none) — the
//            stdout token names which; the caller decides what that means;
//          2 unresolvable (no gh, PR unresolvable, comments API failed) —
//            typed reason on stderr; fail-closed, never readable as pass.
//
// Env contract:
//   PR_VERIFICATION_GH  gh binary to use (default `command -v gh`) — the
//                       merge-guard seam, so a stubbed/real gh resolves the
//                       same way for both and tests stay hermetic.
//   GH_TOKEN            pass through to gh, as usual.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const unresolvable = msg => {
  console.error(`pr-verification: REFUSED (unresolvable) — ${msg}`);
  process.exit(2);
};

const argv = process.argv.slice(2);
const JSON_MODE = argv.includes("--json");
const target = argv.find(a => a !== "--json");
if (!target) {
  console.error("pr-verification: usage: node pr-verification.mjs <pr-number|url|branch> [--json]");
  process.exit(2);
}

const GH = process.env.PR_VERIFICATION_GH || "gh";
const gh = args => spawnSync(GH, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const probe = spawnSync(GH, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  // Missing/not executable (spawn error) or a broken gh — refuse, never
  // read a comment absence as "no verification happened".
  unresolvable(`gh not usable at '${GH}' (${probe.error?.code ?? `exit ${probe.status}`}) — set PR_VERIFICATION_GH`);
}

// 1. Resolve the PR (number, head SHA, url) — the url also yields owner/repo
//    for the comments API, the merge-guard pattern.
const view = gh(["pr", "view", target, "--json", "number,headRefOid,url"]);
let pr = null;
try { pr = JSON.parse(view.stdout); } catch { /* falls through to the guard below */ }
if (view.status !== 0 || !pr || !pr.number || !pr.headRefOid || !pr.url) {
  unresolvable(`cannot resolve PR ${target}: ${(view.stderr || view.stdout || "").trim().slice(0, 200)}`);
}
const repoPath = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url);
if (!repoPath) unresolvable(`cannot parse owner/repo from PR url '${pr.url}'`);
const [owner, repo] = repoPath.slice(1);

// 2. Comments in ascending order (oldest first) — the LAST marker in the
//    thread is the verification's final word. Paginated: a marker on an
//    early page must never be shadowed out of the read by a long thread.
//    FORMAL REVIEW BODIES TOO (issue #560): a `gh pr review --comment
//    --body-file` submission is NOT an issue comment — its body lives on
//    repos/{owner}/{repo}/pulls/N/reviews and the issue-comments endpoint
//    above never sees it, so a verifier following the formal-review shape
//    produced a marker this aggregator silently dropped from the merge
//    decision. Both channels are walked and merged into ONE time-ordered
//    stream (created_at / submitted_at, id tiebreak) before
//    last-marker-wins is applied.
const comments = gh(["api", "--paginate", `repos/${owner}/${repo}/issues/${pr.number}/comments`]);
let list = null;
try { list = JSON.parse(comments.stdout); } catch { /* guarded below */ }
if (comments.status !== 0 || !Array.isArray(list)) {
  unresolvable(`comments API failed for ${owner}/${repo}#${pr.number}: ${(comments.stderr || "").trim().slice(0, 200)}`);
}
const reviews = gh(["api", "--paginate", `repos/${owner}/${repo}/pulls/${pr.number}/reviews`]);
let reviewList = null;
try { reviewList = JSON.parse(reviews.stdout); } catch { /* guarded below */ }
if (reviews.status !== 0 || !Array.isArray(reviewList)) {
  unresolvable(`reviews API failed for ${owner}/${repo}#${pr.number}: ${(reviews.stderr || "").trim().slice(0, 200)}`);
}
// One stream: comments (created_at) + submitted reviews (submitted_at).
// ts is the primary sort key (epoch ms; absent/invalid → 0), id the
// tiebreak. A PENDING review is not yet a submitted verdict — skipped.
const entries = [
  ...list.map(c => ({
    body: c?.body,
    id: c?.id,
    ts: Date.parse(c?.created_at ?? "") || 0,
    provenance: { id: c?.id ?? null, author: c?.user?.login ?? "unknown", url: c?.html_url ?? null },
  })),
  ...reviewList
    .filter(r => r?.state !== "PENDING")
    .map(r => ({
      body: r?.body,
      id: r?.id,
      ts: Date.parse(r?.submitted_at ?? "") || 0,
      provenance: { id: r?.id ?? null, author: r?.user?.login ?? "unknown", url: r?.html_url ?? null },
    })),
].sort((a, b) => ((a.ts ?? 0) - (b.ts ?? 0)) || ((a.id ?? 0) - (b.id ?? 0)));

// 3. Parse each body through gate-verify.mjs (line-strict); the last body
//    carrying a marker in the merged stream wins. Bodies stay on disk in a
//    temp file and are never echoed.
const dir = mkdtempSync(path.join(tmpdir(), "pr-verification-"));
try {
  const tool = path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "gate-verify.mjs");
  let last = null;
  for (const c of entries) {
    if (typeof c?.body !== "string" || c.body === "") continue;
    const f = path.join(dir, "comment.txt");
    writeFileSync(f, c.body);
    const r = spawnSync(process.execPath, [tool, f], { encoding: "utf8" });
    if (r.status !== 0) continue; // unreadable input is not a marker
    const marker = r.stdout.trim();
    if (marker === "PASS" || marker === "FAIL") {
      last = {
        verdict: marker.toLowerCase(),
        comment: { ...c.provenance },
      };
    }
  }

  // 4. Report. exit 1 = "no passing verification to weigh" (fail or none);
  //    the token on stdout is the distinction. exit 2 stays unresolvable.
  const payload = {
    verdict: last ? last.verdict : "none",
    pr: pr.number,
    head: pr.headRefOid,
    url: pr.url,
    markers: last ? 1 : 0, // count of RELEVANT (last-wins) markers; 0 = channel silent
    comment: last ? last.comment : null,
  };
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else if (last) {
    process.stdout.write(`${payload.verdict} ${payload.comment.url ?? "(no url)"} ${payload.comment.author}\n`);
  } else {
    process.stdout.write("none\n");
  }
  process.exit(last && last.verdict === "pass" ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
