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
// walks the PR's comments in order and reports the LAST marker with its
// provenance — machine-consumable, so "a second agent independently
// verified this branch" stops being comment noise.
//
// Consumers:
//   - scripts/merge-guard.sh with MERGE_GUARD_VERIFY=on (opt-in): refuses
//     to merge unless this reports pass.
//   - scripts/review-pr.sh: prior markers surface to the adversarial
//     reviewer as CLAIMS TO CHECK, never as truth.
//
// Both channels (issue #560): a verdict can arrive as a PR COMMENT or as a
// formal REVIEW OBJECT (`pulls/N/reviews`) — a marker in a review body used to
// be invisible because only the comments endpoint was read. The fold is
// FleetTower's lander rule: read both channels to exhaustion, each channel's
// last marker is that channel's final word, the later channel wins (an exact
// tie keeps the comment, the shared-account fleet's native surface), and an
// unreadable channel stays fail-closed (exit 2) — never readable as "none".
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
//                     "channel":"comment|review"|null,
//                     "comment":{"id":N,"author":"login","url":"..."}|null}
//   exit:  0 pass — a passing verification exists to weigh;
//          1 no passing verification (a fail marker, or none) — the
//            stdout token names which; the caller decides what that means;
//          2 unresolvable (no gh, PR unresolvable, comments OR reviews API
//            failed) — typed reason on stderr; fail-closed, never readable
//            as pass.
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

// 2. Read BOTH verdict channels, each paginated to exhaustion (issue #560):
//    the issue-comment channel is the shared-account fleet's native surface
//    (issue #326); the reviews channel (`pulls/N/reviews`) carries the same
//    marker when the verifier posts it as a formal review OBJECT. Paginated
//    in both cases: a marker on an early page must never be shadowed out of
//    the read by a long thread.
const comments = gh(["api", "--paginate", `repos/${owner}/${repo}/issues/${pr.number}/comments`]);
let list = null;
try { list = JSON.parse(comments.stdout); } catch { /* guarded below */ }
if (comments.status !== 0 || !Array.isArray(list)) {
  unresolvable(`comments API failed for ${owner}/${repo}#${pr.number}: ${(comments.stderr || "").trim().slice(0, 200)}`);
}
list.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

const reviewsResp = gh(["api", "--paginate", `repos/${owner}/${repo}/pulls/${pr.number}/reviews`]);
let reviews = null;
try { reviews = JSON.parse(reviewsResp.stdout); } catch { /* guarded below */ }
if (reviewsResp.status !== 0 || !Array.isArray(reviews)) {
  // Fail-closed on an unreadable channel (the #326 rule): an API failure is
  // never readable as "no verification happened" — and now that the reviews
  // channel is graded too, a broken reviews read must not silently degrade
  // to the comments channel's verdict.
  unresolvable(`reviews API failed for ${owner}/${repo}#${pr.number}: ${(reviewsResp.stderr || "").trim().slice(0, 200)}`);
}
reviews.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

// 3. Parse each channel's bodies through gate-verify.mjs (line-strict); the
//    LAST body carrying a marker in a channel is that channel's final word,
//    then the later channel wins (issue #560). Bodies stay on disk in a temp
//    file and are never echoed.
const dir = mkdtempSync(path.join(tmpdir(), "pr-verification-"));
try {
  const tool = path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "gate-verify.mjs");
  const lastMarker = (rows, atKey) => {
    let found = null;
    for (const row of rows) {
      if (typeof row?.body !== "string" || row.body === "") continue;
      const f = path.join(dir, "body.txt");
      writeFileSync(f, row.body);
      const r = spawnSync(process.execPath, [tool, f], { encoding: "utf8" });
      if (r.status !== 0) continue; // unreadable input is not a marker
      const marker = r.stdout.trim();
      if (marker === "PASS" || marker === "FAIL") {
        found = {
          verdict: marker.toLowerCase(),
          // Reviews carry submitted_at, comments created_at — the channel
          // clocks the fold compares (empty when the API omitted it).
          at: typeof row[atKey] === "string" ? row[atKey] : "",
          provenance: {
            id: row.id ?? null,
            author: row?.user?.login ?? "unknown",
            url: row?.html_url ?? null,
          },
        };
      }
    }
    return found;
  };

  const fromComments = lastMarker(list, "created_at");
  const fromReviews = lastMarker(reviews, "submitted_at");

  // Later channel wins; an exact tie — or either side without a usable
  // timestamp — keeps the comment channel, which makes the pre-#560
  // single-channel behaviour byte-identical when no review carries a marker
  // (the same tie rule scripts/approved-lane.mjs uses, issue #643).
  let last = fromComments;
  let channel = fromComments ? "comment" : null;
  if (fromReviews && (!fromComments || (fromComments.at && fromReviews.at && fromReviews.at > fromComments.at))) {
    last = fromReviews;
    channel = "review";
  }

  // 4. Report. exit 1 = "no passing verification to weigh" (fail or none);
  //    the token on stdout is the distinction. exit 2 stays unresolvable.
  const payload = {
    verdict: last ? last.verdict : "none",
    pr: pr.number,
    head: pr.headRefOid,
    url: pr.url,
    markers: last ? 1 : 0, // count of RELEVANT (last-wins) markers; 0 = channel silent
    // Which channel the winning marker came from (issue #560): "comment" |
    // "review", null when neither channel carries one.
    channel,
    // Provenance, not bodies — whichever channel carried it.
    comment: last ? last.provenance : null,
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
