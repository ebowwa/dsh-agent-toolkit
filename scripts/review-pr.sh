#!/usr/bin/env bash
# review-pr.sh — the adversarial review stage for the DECOUPLED worker
# (dsh-worker.sh). The decoupled twin of .github/workflows/agent-review.yml:
# same contract — the consumer repo's REVIEW.md is the rules ground truth,
# the reviewer must ground findings in the diff, and the run must END with
# a line that IS the verdict (APPROVE | REQUEST CHANGES) — but it runs
# out-of-band on the worker box instead of in a consumer Actions job.
#
# Verdict → GitHub: APPROVE ⇒ label ai-reviewed (+ remove changes-requested);
# REQUEST CHANGES ⇒ label changes-requested (+ remove ai-reviewed). Labels
# are created if missing. An absent/unparseable verdict ⇒ NO labels and a
# comment telling a human to look — the worker auto-approves nothing.
#
# Fail-closed scrubbing: every text that leaves this script (the posted
# comment) passes scrub-output.mjs; scrubber failure withholds the review.
#
# Fail-closed diff basis (issue #516): the reviewer's diff is computed from
# the RESOLVED merge-base of base and pr-merge. A merge-base lookup failure
# (a shallow checkout whose graph cannot connect the two refs) WITHHOLDS the
# diff — "(diff unavailable)" — instead of silently degrading to a two-dot
# base→pr-merge diff, which reads every sibling landing since the fork point
# as an apparent PR reversal (the PR #495 receipt).
#
# Recover, then fail closed (issue #519): the fetches below run --depth 1
# and the worker's per-task clone is --depth 1 too (dsh-worker.sh), so base
# and pr-merge arrive as disconnected shallow roots BY CONSTRUCTION on the
# standard production flow — the merge-base lookup exits 1 on essentially
# every review, and #516's fail-closed arm would withhold the diff on every
# one of them. When the lookup fails, the checkout is deepened in bounded
# steps (deepen 1, 2, 4 — cumulative shallow boundary depth 8) until the
# fork point resolves or the budget is spent; an unresolvable graph still
# ends at the SAME withheld terminal state #516 shipped — deepening buys
# availability, never different diff semantics. And when the fork point
# RESOLVES but the diff runs clean and comes back empty, that is an EMPTY
# PR and is reported as one — never as an unavailable diff (the issue #519
# adjacent nit).
#
# The fork point is a property of the PR HEAD, never of the merge preview
# (issue #651, receipts #554 + #550): GitHub builds refs/pull/N/merge against
# the base tip at LAST PR UPDATE, so on a PR whose base has moved since,
# merge-base(base, pr-merge) legitimately resolves to the PREVIEW BASE — a
# base-side commit (d2a47b3a on #554, c173b02b on #550) that the old
# narration then mislabeled as the PR's "fork point". The only fork-point
# value that may ever be narrated is a VALIDATED one:
#   <head>^                      — the head is a single commit whose parent
#                                  sits on base's line of history
#   merge-base(base_tip, head)   — otherwise
# validated against `git rev-list --parents -1` of the PR head (parent
# hashes ride the head commit object at ANY depth — no deepening needed).
# A resolved value that is neither is a TYPED error (FORK_HEAD_UNREADABLE /
# FORK_POINT_UNRESOLVED / FORK_POINT_NOT_REACHABLE — stderr + a typed token
# in the basis line), never narrated prose; the review still POSTS on the
# withheld / preview-scoped basis, because a nonzero exit here drops the
# whole review (dsh-worker.sh has no auto-retry) and the #516 availability
# doctrine holds. And before the review prompt is minted, the narrated fork
# point is CROSS-CHECKED against the diff actually shown: the branch's own
# diff from the validated fork point (the parent-diff stat on the
# head-parent arm) must agree with the shown preview diff, and the basis
# line says VERIFIED / MISMATCH (typed FORK_DIFF_MISMATCH, both stats shown)
# / UNAVAILABLE — the reviewer is never left to assume the shown stat is the
# branch's own.
#
# Freshness is computed against the PR HEAD, never the merge preview (issue
# #628, adopted verbatim from open carrier PR #630 so the two carriers
# compose instead of conflicting): GitHub constructs refs/pull/N/merge by
# merging the PR head into the CURRENT base tip, so the preview's FIRST
# PARENT is the base tip and `merge-base(base, pr-merge)` resolves to the
# base tip BY CONSTRUCTION whenever the preview is fresh — and on a stale
# preview it resolves to the OLDER preview base (the #554/#550 receipt
# shape). The freshness line below is derived from HEAD_FORK_BASE =
# merge-base(base, refs/pull/N/head): the only hash that may carry a
# "NOT advanced" claim is one proven to be that merge-base; when the shallow
# graph cannot connect base and the PR head within the deepen budget, the
# prose degrades to "freshness UNVERIFIED" — never a positive claim. The
# DIFF itself stays scoped on the merge preview (FORK_BASE→pr-merge, the
# three-dot semantics issues #516/#519 pinned): that content was correct on
# the receipts; only the fork-point narration lied.
#
# Env contract:
#   GH_TOKEN                the worker's PAT (read + comment/label on the repo)
#   DSH_SHIP_REPO           owner/repo of the PR under review
#   PR_NUM                  the PR number
#   DSH_AGENT_TOOLKIT_DIR             dsh-agent-toolkit toolkit checkout (contains scripts/)
#   DSH_WORKTREE            the per-task clone (review-pr.sh fetches the PR
#                           merge ref + base into it itself)
#   DSH_REVIEW_MODEL        provider/model for the reviewer (default zai/glm-5.3)
#   DSH_REVIEW_RULES_FILE   repo-relative rules path (default REVIEW.md; read
#                           from the PR's BASE ref, so the PR cannot edit its
#                           own grading contract)
#   DSH_REVIEW_OUT          where the reviewer's raw output lands
#                           (default ${RUNNER_TEMP:-/tmp}/dsh-review-output.txt)
#   DSH_RUN_ID              run identifier for the posted header
#   DSH_RUNNER_NAME         worker name for the posted header
#
# Exit: 0 review completed and posted (any verdict); 2 usage / rules
# contract missing; 3 scrubber failed; 4 no verdict (posted, unlabeled).

set -euo pipefail

DSH_SHIP_REPO="${DSH_SHIP_REPO:?review-pr: DSH_SHIP_REPO unset}"
PR_NUM="${PR_NUM:?review-pr: PR_NUM unset}"
# LEGACY-NAME SHIM (retired DSH_BOT_DIR, drift BLOCK run 34803136038): direct
# callers on pre-rename env files keep working, loudly; fail-closed unchanged.
if [ -z "${DSH_AGENT_TOOLKIT_DIR:-}" ] && [ -n "${DSH_BOT_DIR:-}" ]; then
  echo "review-pr: DSH_BOT_DIR is retired — set DSH_AGENT_TOOLKIT_DIR (accepted for this run)" >&2
  DSH_AGENT_TOOLKIT_DIR="$DSH_BOT_DIR"
fi
DSH_AGENT_TOOLKIT_DIR="${DSH_AGENT_TOOLKIT_DIR:?review-pr: DSH_AGENT_TOOLKIT_DIR unset}"
DSH_WORKTREE="${DSH_WORKTREE:?review-pr: DSH_WORKTREE unset}"
DSH_REVIEW_OUT="${DSH_REVIEW_OUT:-${RUNNER_TEMP:-/tmp}/dsh-review-output.txt}"
DSH_REVIEW_RULES_FILE="${DSH_REVIEW_RULES_FILE:-REVIEW.md}"
DSH_REVIEW_MODEL="${DSH_REVIEW_MODEL:-zai/glm-5.3}"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

command -v gh >/dev/null 2>&1 || { echo "review-pr: gh unavailable" >&2; exit 1; }

# 1. PR facts + the rules contract from the BASE (the PR must not grade
#    itself — a PR that deletes REVIEW.md must not pass because it did).
#
# Guarded parse (issue #529, the PR #528 poll_field shape): under a 403/429
# the gh error body lands on stdout, so PR_JSON is non-empty GARBAGE the
# `[ -n ]` guard cannot catch — the old unguarded `JSON.parse` then threw,
# the assignment failed, and `set -e` killed review-pr.sh mid-item with a
# node stack trace, never reaching the typed exit 2. pr_field degrades a
# non-JSON body to an EMPTY field, so garbage lands on the typed
# "PR #N has no base/head" exit below instead of an uncaught throw.
pr_field() { # <json> <field> — the field value; "" when the json is not JSON (issue #529)
  printf '%s' "$1" | node -e '
    let s = "";
    try { s = require("fs").readFileSync(0, "utf8"); } catch {}
    let v;
    try { v = JSON.parse(s)[process.argv[1]]; } catch { v = ""; }
    process.stdout.write(v === null || v === undefined ? "" : String(v));' "$2" 2>/dev/null || true
}
PR_JSON="$(gh pr view "$PR_NUM" --repo "$DSH_SHIP_REPO" --json baseRefName,headRefName,title 2>/dev/null || true)"
[ -n "$PR_JSON" ] || { echo "review-pr: cannot read PR #$PR_NUM in $DSH_SHIP_REPO" >&2; exit 2; }
BASE_REF="$(pr_field "$PR_JSON" baseRefName)"
HEAD_REF="$(pr_field "$PR_JSON" headRefName)"
PR_TITLE="$(pr_field "$PR_JSON" title)"
[ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ] || { echo "review-pr: PR #$PR_NUM has no base/head" >&2; exit 2; }

RULES_TMP="$(mktemp)"
RULES_OK=0
# base-ref fetch via the contents API (base64) — falls back to the worktree
# (PR head) only if the base truly has no rules file.
RULES_B64="$(gh api "repos/${DSH_SHIP_REPO}/contents/${DSH_REVIEW_RULES_FILE}?ref=${BASE_REF}" --jq .content 2>/dev/null || true)"
if [ -n "$RULES_B64" ]; then
  printf '%s' "$RULES_B64" | base64 -d > "$RULES_TMP" 2>/dev/null && RULES_OK=1
fi
if [ "$RULES_OK" != "1" ] && [ -f "$DSH_WORKTREE/$DSH_REVIEW_RULES_FILE" ]; then
  cp "$DSH_WORKTREE/$DSH_REVIEW_RULES_FILE" "$RULES_TMP" && RULES_OK=1
fi
if [ "$RULES_OK" != "1" ]; then
  rm -f "$RULES_TMP"
  echo "review-pr: no $DSH_REVIEW_RULES_FILE at base $BASE_REF nor in the worktree — refusing to review without the rules contract" >&2
  exit 2
fi

# 2. The diff (merge ref vs base) into the worktree.
cd "$DSH_WORKTREE" || { echo "review-pr: cannot cd to $DSH_WORKTREE" >&2; exit 2; }
# The initial clone + fetch in the worker used env-based git config (token
# in the environment, never on argv — argv is ps-readable). The push
# credential resolve-push-token.sh wrote lives in .git/config, so these
# extra fetches can ride the same env seam and are harmless when the token
# is absent (public repos).
# BASIC auth (base64 x-access-token:TOKEN): the API-scheme header 401s on
# git http (proven live on seed-dshbot). Env-borne, never argv; the stale
# box credential helper is reset.
gh_fetch() { # <refspec:local-ref>
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="$(printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")" \
    git -c credential.helper= fetch -q --depth 1 origin "$1"
}
fetch_merge() { gh_fetch "refs/pull/${PR_NUM}/merge:refs/remotes/origin/pr-merge"; }
fetch_base()   { gh_fetch "refs/heads/${BASE_REF}:refs/remotes/origin/base"; }
# Issue #628 (adopted from carrier PR #630 verbatim): the PR's true fork
# point is a property of the PR HEAD, not of the merge preview — fetch the
# head ref too (the freshness prose and the #651 validation below are
# derived from it; the preview's merge-base is the preview base).
fetch_head()   { gh_fetch "refs/pull/${PR_NUM}/head:refs/remotes/origin/pr-head"; }
# Issue #519: widen the shallow boundary of BOTH fetched refs by <depth>
# commits — the recover arm for the disconnected graph the --depth 1
# fetches construct. Same env-borne auth seam as gh_fetch. Issue #628: the
# PR head rides the same deepen so its merge-base with base can resolve too
# — but as its OWN fetch (a git fetch is all-or-nothing across refspecs,
# and the head ref can vanish on a raced PR close): a missing head ref must
# never kill the load-bearing #519 base/preview recovery.
gh_deepen() { # <depth>
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="$(printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")" \
    git -c credential.helper= fetch -q --deepen="$1" origin \
      "refs/heads/${BASE_REF}:refs/remotes/origin/base" \
      "refs/pull/${PR_NUM}/merge:refs/remotes/origin/pr-merge" \
    && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader \
    GIT_CONFIG_VALUE_0="$(printf 'AUTHORIZATION: basic %s' "$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")" \
    git -c credential.helper= fetch -q --deepen="$1" origin \
      "refs/pull/${PR_NUM}/head:refs/remotes/origin/pr-head" \
    || true
}
fetch_merge 2>/dev/null \
  || { echo "review-pr: cannot fetch PR #$PR_NUM merge ref" >&2; rm -f "$RULES_TMP"; exit 2; }
fetch_base 2>/dev/null || true
fetch_head 2>/dev/null || true
# Issue #516: the diff fallback must never change diff SEMANTICS. The old
# chain's `|| echo origin/base` turned a FAILED merge-base lookup — exactly
# the shallow-checkout case — into a TWO-DOT base→pr-merge diff, folding
# every sibling landing since the fork point in as apparent reversals
# (PR #495: a clean 6-file PR read as 12 files of contract tampering). Fail
# closed instead, the shipper's own degrade-safe freshness shape
# (ship-changes.sh: merge-base unresolvable ⇒ NOT verified): resolve the
# merge-base explicitly; when it cannot be resolved, hand (diff unavailable)
# and say so in the prompt — never silently degrade to a two-dot diff.
FORK_BASE="$(git merge-base origin/base origin/pr-merge 2>/dev/null || true)"
# Issue #628 (adopted from carrier PR #630): HEAD_FORK_BASE is the PR's TRUE
# fork point — merge-base of the base tip and the PR HEAD ref. The preview's
# merge-base (FORK_BASE) can NEVER carry the freshness claim or be narrated
# as the fork point: fresh preview ⇒ it is the base tip by construction,
# stale preview ⇒ it is an older base-side commit — either way it is a
# property of the PREVIEW, not of the branch (the #554/#550 mislabel).
# Degrade-safe like every lookup here: empty means unresolvable, and the
# prose says UNVERIFIED rather than claiming.
HEAD_FORK_BASE="$(git merge-base origin/base origin/pr-head 2>/dev/null || true)"
HEAD_DEEPEN_STEPS=""
DEEPEN_STEPS=""
# Issue #519: the --depth 1 fetches above (and the worker's --depth 1 clone)
# disconnect base and pr-merge by construction — the lookup exits 1 on the
# standard production flow, and #516's fail-closed arm would withhold the
# diff on every review. Recover, bounded: widen the shallow boundary in
# steps until the fork point resolves or the small budget is spent (the
# common fresh-fork case resolves at the first step). A graph the budget
# still cannot connect falls through to the SAME withheld terminal state
# below — deepening changes the budget, never the fail-closed semantics.
if [ -z "$FORK_BASE" ]; then
  for DEEPEN_STEP in 1 2 4; do
    gh_deepen "$DEEPEN_STEP" 2>/dev/null || true
    FORK_BASE="$(git merge-base origin/base origin/pr-merge 2>/dev/null || true)"
    HEAD_FORK_BASE="$(git merge-base origin/base origin/pr-head 2>/dev/null || true)"
    if [ -n "$FORK_BASE" ]; then
      DEEPEN_STEPS="$DEEPEN_STEP"
      break
    fi
  done
fi
# Issue #628 (adopted from carrier PR #630): the preview's merge-base can
# resolve while the PR-head fork point is still disconnected (the preview's
# first parent is a ref already held, the head's history is not). The head
# fork point gets the SAME guarded, bounded recovery — never an unbounded
# loop; an unresolvable head fork degrades to UNVERIFIED prose and the #651
# typed error below, never to a claim.
if [ -n "$FORK_BASE" ] && [ -z "$HEAD_FORK_BASE" ]; then
  for HEAD_DEEPEN_STEP in 1 2 4; do
    gh_deepen "$HEAD_DEEPEN_STEP" 2>/dev/null || true
    HEAD_FORK_BASE="$(git merge-base origin/base origin/pr-head 2>/dev/null || true)"
    if [ -n "$HEAD_FORK_BASE" ]; then
      HEAD_DEEPEN_STEPS="$HEAD_DEEPEN_STEP"
      break
    fi
  done
fi
# ── Issue #651: fork-point VALIDATION (the resolution-side anti-graft layer) ──
# The narrated fork point must be a VALIDATED value: <head>^ when the head
# is a single commit whose parent sits on base's line of history (proven by
# merge-base(base_tip, head) == head^), else merge-base(base_tip, head).
# The parentage read needs NO deepening — `rev-list --parents -1` prints the
# head's parent hashes straight off the head commit object at any shallow
# depth (the exact command both receipts ran) — so the check is cheap and
# always available. A resolved value that is neither is a TYPED error, never
# narrated prose. The review still posts: a nonzero exit would drop the
# whole review (the worker has no auto-retry), so the typed token rides the
# basis line + stderr and the diff stays on the #516/#628 fail-closed shape.
FORK_OK=""          # the VALIDATED fork point (empty = none may be narrated)
FORK_SOURCE=""      # head-parent | merge-base — which legal arm produced it
FORK_ERR=""         # typed token when no legal value could be validated
HEAD_SHA=""
HEAD_NPARENTS=0
HEAD_PARENT1=""
HEAD_PARENTS_RAW="$(git rev-list --parents -1 origin/pr-head 2>/dev/null || true)"
if [ -n "$HEAD_PARENTS_RAW" ]; then
  set -- $HEAD_PARENTS_RAW
  HEAD_SHA="$1"
  HEAD_NPARENTS=$(( $# - 1 ))
  if [ "$HEAD_NPARENTS" -ge 1 ]; then
    HEAD_PARENT1="$2"
  fi
fi
if [ -z "$HEAD_SHA" ]; then
  FORK_ERR="FORK_HEAD_UNREADABLE"
elif [ -z "$HEAD_FORK_BASE" ]; then
  FORK_ERR="FORK_POINT_UNRESOLVED"
else
  FORK_OK="$HEAD_FORK_BASE"
  if [ "$HEAD_NPARENTS" -eq 1 ] && [ "$HEAD_FORK_BASE" = "$HEAD_PARENT1" ]; then
    # merge-base(base_tip, head) == head^ ⇒ the head is a single commit
    # sitting directly on base's line of history: the head-parent arm.
    FORK_SOURCE="head-parent"
  else
    FORK_SOURCE="merge-base"
  fi
  # The graft tripwire (the d2a47b3a/c173b02 detector): a fork point IS an
  # ancestor of the head BY DEFINITION — a resolved value that fails this
  # walk is a shallow-graft artifact and is refused, never narrated.
  if ! git rev-parse --verify --quiet "${FORK_OK}^{commit}" >/dev/null 2>&1; then
    FORK_ERR="FORK_POINT_UNRESOLVED"
    FORK_OK=""
  elif ! git merge-base --is-ancestor "$FORK_OK" origin/pr-head 2>/dev/null; then
    FORK_ERR="FORK_POINT_NOT_REACHABLE"
    FORK_OK=""
  fi
fi
if [ -n "$FORK_ERR" ]; then
  echo "review-pr: typed error $FORK_ERR: fork point refused, nothing may narrate one (issue #651 — head ${HEAD_SHA:-unreadable}, parents $HEAD_NPARENTS, candidate ${HEAD_FORK_BASE:-none})" >&2
fi
BASE_TIP="$(git rev-parse origin/base 2>/dev/null || true)"
DIFF=""
DIFF_STAT=""
DIFF_BASIS=""
DIFF_STAT_ALL=""
if [ -n "$FORK_BASE" ]; then
  # Two-dot from the RESOLVED merge-base IS the three-dot semantics
  # (base...pr-merge ≡ merge-base(base, pr-merge)→pr-merge) — computed once,
  # with no fallback arm left that could silently substitute another range.
  # RC-captured (issue #519): an EMPTY result from a clean diff is a real
  # empty diff and must stay distinguishable from a FAILED diff.
  DIFF="$(git diff "$FORK_BASE" origin/pr-merge 2>/dev/null)" \
    && DIFF_RC=0 || DIFF_RC=1
  DIFF_STAT_ALL="$(git diff --stat "$FORK_BASE" origin/pr-merge 2>/dev/null)" \
    && STAT_RC=0 || STAT_RC=1
  DIFF_STAT="$(printf '%s' "$DIFF_STAT_ALL" | tail -n 30 || true)"
  # Issue #628 (adopted from carrier PR #630): the freshness claim keys off
  # HEAD_FORK_BASE — the merge-base of base and the PR HEAD — never off
  # merge-base(base, pr-merge), which is the base tip by construction
  # whenever the preview is fresh (the #574 false prose) and an older
  # preview base when the preview is stale (the #554/#550 mislabel). Only a
  # hash PROVEN to be that merge-base may carry the claim; anything less
  # degrades to UNVERIFIED — never a positive claim.
  if [ -n "$HEAD_FORK_BASE" ] && [ -n "$BASE_TIP" ] && [ "$BASE_TIP" = "$HEAD_FORK_BASE" ]; then
    DIFF_BASIS="PR-head fork point ${HEAD_FORK_BASE} (merge-base of base and refs/pull/${PR_NUM}/head) — base has NOT advanced since the fork (the diff is the PR's own changes only; issue #628: verified against the PR HEAD — the merge preview's merge-base is the base tip by construction and asserts nothing)"
  elif [ -n "$HEAD_FORK_BASE" ] && [ -n "$BASE_TIP" ]; then
    DIFF_BASIS="PR-head fork point ${HEAD_FORK_BASE} — base tip ${BASE_TIP} HAS advanced since the fork (sibling landings sit between the fork and the tip; the diff below is the PR's own changes over the CURRENT base — judge nothing about base history here; issue #628: the merge preview's merge-base cannot see this advancement, it resolves to the base tip by construction)"
  elif [ -n "$HEAD_FORK_BASE" ]; then
    DIFF_BASIS="PR-head fork point ${HEAD_FORK_BASE} — base tip unresolvable (base fetch failed)"
  elif [ -n "$BASE_TIP" ]; then
    DIFF_BASIS="PR-head fork point UNRESOLVABLE in this shallow graph — base freshness UNVERIFIED, no advancement claim either way (issue #628: a positive claim here would be the merge-preview tautology — merge-base(base, pr-merge) is the base tip by construction); the diff below is still scoped ${FORK_BASE}→pr-merge"
  else
    DIFF_BASIS="merge-preview base ${FORK_BASE} — base tip unresolvable (base fetch failed; issue #651: the preview base is named as what it is, never narrated as the fork point)"
  fi
  # A merge-preview merge-base that is NOT the base tip means the preview
  # ref itself is stale (GitHub rebuilt it against an older tip — the #574
  # cached-ref shape, and exactly the #554/#550 receipt): say so, so the
  # diff's scope is never overstated and the preview base is never mistaken
  # for the branch's fork point.
  if [ -n "$BASE_TIP" ] && [ "$FORK_BASE" != "$BASE_TIP" ]; then
    DIFF_BASIS="$DIFF_BASIS — the merge preview is STALE (its merge-base ${FORK_BASE} predates the current tip, so the diff below is scoped to that older base, not the tip)"
  fi
  if [ -n "$DEEPEN_STEPS" ]; then
    DIFF_BASIS="$DIFF_BASIS — the shallow checkout was deepened in bounded steps to resolve this fork point (issue #519: final deepen step $DEEPEN_STEPS); anything the budget cannot still connect stays withheld"
  fi
  if [ -n "$HEAD_DEEPEN_STEPS" ]; then
    DIFF_BASIS="$DIFF_BASIS — the PR-head fork point was deepened for too (issue #628: final deepen step $HEAD_DEEPEN_STEPS)"
  fi
  # Issue #651, acceptance criterion 2: cross-check the narrated fork point
  # against the diff ACTUALLY SHOWN before the review prompt is minted. The
  # branch's own diff from the VALIDATED fork point (the parent-diff stat
  # when the head-parent arm held) must agree with the shown preview diff;
  # the basis line says which it was, and a mismatch is a TYPED token with
  # BOTH stats shown — the reviewer is never left to assume the shown stat
  # is the branch's own.
  if [ -n "$FORK_OK" ] && [ "$DIFF_RC" = "0" ] && [ "$STAT_RC" = "0" ]; then
    BRANCH_STAT_ALL="$(git diff --stat "$FORK_OK" origin/pr-head 2>/dev/null)" \
      && BRANCH_RC=0 || BRANCH_RC=1
    SHOWN_SUMMARY="$(printf '%s' "$DIFF_STAT_ALL" | tail -n 1)"
    if [ "$BRANCH_RC" = "1" ]; then
      DIFF_BASIS="$DIFF_BASIS — cross-check (issue #651) UNAVAILABLE: the branch's own diff from the validated fork point could not be computed in this shallow graph; the shown diff is NOT verified against it"
    else
      BRANCH_SUMMARY="$(printf '%s' "$BRANCH_STAT_ALL" | tail -n 1)"
      if [ "$FORK_SOURCE" = "head-parent" ]; then
        BRANCH_LABEL="parent-diff (head^ → head)"
      else
        BRANCH_LABEL="branch diff (fork point → head)"
      fi
      if [ -z "$SHOWN_SUMMARY" ] && [ -z "$BRANCH_SUMMARY" ]; then
        DIFF_BASIS="$DIFF_BASIS — cross-check (issue #651) VERIFIED: both the shown diff and the ${BRANCH_LABEL} from the validated fork point are EMPTY"
      elif [ -n "$BRANCH_SUMMARY" ] && [ "$BRANCH_SUMMARY" = "$SHOWN_SUMMARY" ]; then
        DIFF_BASIS="$DIFF_BASIS — cross-check (issue #651) VERIFIED: the shown stat equals the ${BRANCH_LABEL} from the validated fork point (${BRANCH_SUMMARY})"
      else
        DIFF_BASIS="$DIFF_BASIS — CROSS-CHECK MISMATCH (typed: FORK_DIFF_MISMATCH, issue #651): the shown stat \"${SHOWN_SUMMARY:-empty}\" does NOT equal the ${BRANCH_LABEL} from the validated fork point ${FORK_OK} (\"${BRANCH_SUMMARY:-empty}\") — same-file base landings inside the merge preview or a stale preview ref: grade the shown diff as base-relative, NOT as the branch's own changes"
        echo "review-pr: typed error FORK_DIFF_MISMATCH: shown stat '${SHOWN_SUMMARY:-}' vs ${BRANCH_LABEL} '${BRANCH_SUMMARY:-}' (issue #651)" >&2
      fi
    fi
  fi
  if [ -n "$FORK_ERR" ]; then
    DIFF_BASIS="$DIFF_BASIS — (typed: $FORK_ERR, issue #651: no VALIDATED fork point exists — no fork-point value anywhere above is trustworthy; the diff basis is the merge preview alone)"
  fi
  if [ "$DIFF_RC" = "1" ] || [ "$STAT_RC" = "1" ]; then
    # The fork RESOLVED but the diff itself failed — genuinely unavailable.
    DIFF="(diff unavailable — base and pr-merge could not be diffed at the resolved fork point)"
    DIFF_STAT="(diff stat unavailable)"
  elif [ -z "$DIFF" ] && [ -z "$DIFF_STAT_ALL" ]; then
    # Issue #519 adjacent nit: the fork point resolved and BOTH diffs ran
    # clean — an empty result is an EMPTY PR (pr-merge == base at the fork),
    # not an unavailable diff. The old text asserted a failure that never
    # happened; say the truth instead.
    DIFF="(the diff is EMPTY — pr-merge carries no tree change over the merge-preview base ${FORK_BASE}; this is an empty PR, not a withheld diff — verify the emptiness is intended)"
    DIFF_STAT="(empty diff — no file changes)"
    DIFF_BASIS="$DIFF_BASIS — the diff ran clean and is EMPTY (an empty PR, not a withheld one)"
  fi
else
  # Fail closed (issue #516, still the terminal state under #519): no
  # resolvable merge-base even after the bounded deepening above — a shallow
  # graph that cannot connect base and pr-merge within the budget. The PR's
  # own changes CANNOT be isolated, so the diff is WITHHELD, never degraded
  # to two-dot.
  DIFF="(diff unavailable — the base/pr-merge graph cannot be connected in this shallow checkout, so the PR's own changes could NOT be isolated; do NOT reconstruct them from branch names or checks output)"
  DIFF_STAT="(diff stat unavailable — same shallow-graph cause)"
  DIFF_BASIS="fork point UNRESOLVABLE (shallow graph) — the diff below is WITHHELD, not degraded; ground findings only in what is actually shown, and say the diff was unavailable rather than inferring the change"
  if [ -n "$FORK_ERR" ]; then
    DIFF_BASIS="$DIFF_BASIS — (typed: $FORK_ERR, issue #651: the PR-head fork point is unvalidated too — no fork-point value exists anywhere in this basis)"
  fi
fi
DIFF_CAP=6000
DIFF_LINES="$(printf '%s' "$DIFF" | wc -l | tr -d ' ')"
[ "${DIFF_LINES:-0}" -gt "$DIFF_CAP" ] && DIFF="$(printf '%s' "$DIFF" | head -n "$DIFF_CAP")"
GATES="$(gh pr checks "$PR_NUM" --repo "$DSH_SHIP_REPO" 2>/dev/null | head -n 15 || echo "(checks unavailable)")"
# Independent gate-verify comments (issue #326): the shared-account fleet
# cannot post approving reviews, so sibling verification rides the marker
# channel (scripts/gate-verify.mjs); pr-verification.mjs reports it
# machine-readably. Degrade-safe: a failed lookup degrades to "none" in
# the task text — never fails the review. Markers are CLAIMS the reviewer
# checks, never truth (REVIEW.md).
VERIFY="$(node "$DSH_AGENT_TOOLKIT_DIR/scripts/pr-verification.mjs" "$PR_NUM" 2>/dev/null || true)"
[ -n "$VERIFY" ] || VERIFY="none"

# 3. Compose the review task (env-borne, never raw interpolation).
TASK_FILE="$(mktemp)"
cat > "$TASK_FILE" <<EOF
You are the adversarial reviewer for PR #$PR_NUM in $DSH_SHIP_REPO.

The rules contract (REVIEW.md at the BASE ref — the PR under review cannot
edit it):
$(cat "$RULES_TMP")

PR: #$PR_NUM "$PR_TITLE" ($BASE_REF ← $HEAD_REF)

Diff basis (issue #516): $DIFF_BASIS

Diff (merge-preview base→pr-merge when resolvable — the fork point and
freshness above are computed against the PR HEAD per issues #628/#651;
truncated to $DIFF_CAP lines):
$DIFF

Diff stat:
$DIFF_STAT

Gates status on the PR:
$GATES

Independent gate-verify comments (issue #326 channel, last marker wins):
$VERIFY
A gate-verify marker is another agent's CLAIM that it ran the gates on
this PR — check it against the diff and the checks above; a claim you
cannot reproduce is a finding, and no marker ever substitutes for your
own verdict.

Review for correctness ("no swallowed exits", fail-closed scrubbing, tests
that actually construct what they claim), workflow discipline, and honesty
(overstatement is blocking, same as a bug). Fix or verify anything you
claim; an unreproducible claim is a finding. Do NOT push commits, do NOT
open PRs, do NOT comment on the PR — your final answer is posted for you.

CONTRACT (violating it discards your review): your final answer MUST END
WITH, as its very last line, exactly one of these two lines — nothing
after it, no prose, no sign-off:
## Verdict: APPROVE
## Verdict: REQUEST CHANGES
A report without that final line is a contract violation: the harness
parses no verdict, sets no labels, and forces human review — your entire
review then carries no machine weight. "## Required to merge" sections or
blocking findings in prose do NOT count; ONLY the literal Verdict line
does.
EOF

# 4. Run the reviewer (off the same driver; the worktree is at the PR merge
#    ref — the ONLY ref involved, so the reader cannot drift to another).
rc=0
DSH_MODEL="$DSH_REVIEW_MODEL" DSH_SUBAGENT_MODEL="" REPLY_TARGET="" \
  bash "$DSH_AGENT_TOOLKIT_DIR/scripts/run-dsh-agent.sh" "$(cat "$TASK_FILE")" \
  | node "$DSH_AGENT_TOOLKIT_DIR/scripts/scrub-output.mjs" > "$DSH_REVIEW_OUT" || rc=$?
rm -f "$TASK_FILE" "$RULES_TMP"
if [ "$rc" -ne 0 ]; then
  echo "review-pr: reviewer driver exited $rc — review incomplete" >&2
fi

# 5. Verdict — line-strict, fail-closed on absence.
VERDICT="$(node "$DSH_AGENT_TOOLKIT_DIR/scripts/review-verdict.mjs" "$DSH_REVIEW_OUT" 2>/dev/null || true)"

# 6. Post: scrubbed body as a PR comment, labels per verdict. Fail-closed:
#    the review comment is scrubbed output — a scrubber failure means the
#    review is NOT posted and the script exits 3 (the header's exit-3
#    contract, which the review round on PR #45 found to be dead code: the
#    placeholder text was posted instead of failing).
POST_BODY="$(mktemp)"
# the driver's meta (this review's own run) supplies the harness version
DSH_META_FILE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}/dsh-run-meta.env"
DSH_RUN_DSH_VERSION=""
[ -f "$DSH_META_FILE" ] && . "$DSH_META_FILE"
{
  echo "**dsh review (worker)** — run: ${DSH_RUN_ID:-_} — model: ${DSH_REVIEW_MODEL} — harness: dsh-${DSH_RUN_DSH_VERSION:-?}"
  echo
} > "$POST_BODY"
# OUTPUT surface (review comment): default mode redacts date shapes —
# timestamps correlate working hours (scrub-output.mjs taxonomy,
# issue #152); unlike the shipper's PR body this is not authored prose.
# Fail-closed: a scrub failure withholds the comment entirely (exit 3).
if ! node "$DSH_AGENT_TOOLKIT_DIR/scripts/scrub-output.mjs" < "$DSH_REVIEW_OUT" >> "$POST_BODY" 2>/dev/null; then
  echo "review-pr: scrubber failed — review NOT posted (fail-closed, exit 3)" >&2
  rm -f "$POST_BODY" "$RULES_TMP"
  exit 3
fi
gh pr comment "$PR_NUM" --repo "$DSH_SHIP_REPO" --body-file "$POST_BODY" 2>/dev/null \
  || echo "review-pr: comment post failed (check PAT scope on $DSH_SHIP_REPO)" >&2
rm -f "$POST_BODY"

case "$VERDICT" in
  APPROVE)
    gh label create ai-reviewed --repo "$DSH_SHIP_REPO" --force >/dev/null 2>&1 || true
    gh pr edit "$PR_NUM" --repo "$DSH_SHIP_REPO" --add-label ai-reviewed --remove-label changes-requested >/dev/null 2>&1 || true
    echo "review-pr: verdict APPROVE — labeled ai-reviewed";;
  REQUEST\ CHANGES)
    gh label create changes-requested --repo "$DSH_SHIP_REPO" --force >/dev/null 2>&1 || true
    gh pr edit "$PR_NUM" --repo "$DSH_SHIP_REPO" --add-label changes-requested --remove-label ai-reviewed >/dev/null 2>&1 || true
    echo "review-pr: verdict REQUEST CHANGES — labeled changes-requested";;
  *)
    echo "review-pr: NO VERDICT ($VERDICT) — no labels applied, human review required" >&2
    exit 4;;
esac

exit 0