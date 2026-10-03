#!/usr/bin/env bash
# ship-changes.sh — the deterministic shipper, shared by the comment workflow
# (agent-comment.yml) and the out-of-band worker (dsh-worker.sh).
#
# "Deterministic shipping (never trust the model to push)": after an agent
# run, diff the repo state the agent worked on vs. the state captured before
# the run and open PRs for anything new — branches the agent pushed under
# dsh/* and local changes/commits the shipper commits itself. The model is
# never given push authority; this script is the only pusher.
#
# Runs in the caller's context: caller's repo checkout, caller's GH_TOKEN.
# In the comment workflow the caller is the Actions job; in decoupled mode
# the caller is the worker's per-task clone. Both call this exact script.
#
# Env contract (Actions names are ambient when running there; DSH_* names
# make the script runnable anywhere):
#   GH_TOKEN                required — the push + gh identity
#   DSH_SHIP_REPO           repo to ship to (default $GITHUB_REPOSITORY)
#   DSH_SHIP_BASE           the PR base branch for the freshness preflight
#                           (factory#840); unset = the remote's HEAD branch
#                           (default branch) via `git remote show origin`
#   DSH_RUN_ID              run identifier for branch naming (default $GITHUB_RUN_ID)
#   DSH_RUN_ATTEMPT         attempt counter (default ${GITHUB_RUN_ATTEMPT:-1})
#   DSH_WORKTREE            the checkout the agent worked in (default $GITHUB_WORKSPACE)
#   DSH_AGENT_TOOLKIT_DIR             dsh-agent-toolkit toolkit checkout (contains scripts/)
#   DSH_SHIP_CACHE          dir holding the BEFORE-state files this script
#                           diffs against; the caller (workflow step or
#                           worker) must have written them. Default
#                           ${RUNNER_TEMP:-/tmp}.
#   DSH_AGENT_OUTPUT        path of the tee'd agent output (already
#                           scrubbed on disk by the caller's tee — keep-dates
#                           there so prose survives; issue #152), re-scrubbed
#                           here for the PR body in KEEP_DATES mode
#                           (default $DSH_SHIP_CACHE/dsh-agent-output.txt).
#                           Fail-closed (issue #162): the re-scrub runs BEFORE
#                           the push and a scrubber failure aborts the ship
#                           (exit 3) — never a silently degraded PR body.
#   DSH_SHIP_NOTE_FILE      where the human "shipped: ..." note goes
#                           (default $DSH_SHIP_CACHE/dsh-ship-note.txt).
#   DSH_PR_NUM_FILE         optional: first reviewable PR number opened is
#                           written here (the worker's review stage reads it).
#   DSH_TASK_TITLE          optional title seed for PRs.
#   DSH_CLOSING_TICKET      optional: issue number the shipped work closes
#                           ("185" or "#185") — its milestone is stamped on
#                           the PR (issue #185). When unset, the shipper
#                           scans the PR body for "#N" issue references and
#                           carries the first referenced ticket's milestone.
#   ACK_COMMENT_ID          optional: ack comment to PATCH to "shipping".
#   REVIEW_WORKFLOW         optional: workflow filename to dispatch per PR
#                           (empty/absent = worker mode: no dispatch — the
#                           worker reviews inline).
#   EXTRA_SCRUB_HOSTS       optional comma-separated hosts for the scrubber
#                           (mapped to DSH_SCRUB_EXTRA_HOSTS like the driver
#                           does).
#
# BEFORE-state files the CALLER must have captured before the agent ran
# (identical to the workflow's old inline capture):
#   $DSH_SHIP_CACHE/dsh-before-sha            HEAD before the run
#   $DSH_SHIP_CACHE/dsh-before-dsh-branches   remote dsh/* branches before
#   $DSH_SHIP_CACHE/dsh-before-open-prs       open PR numbers before

set -uo pipefail

DSH_SHIP_REPO="${DSH_SHIP_REPO:-${GITHUB_REPOSITORY:?ship-changes: DSH_SHIP_REPO/GITHUB_REPOSITORY unset}}"
DSH_RUN_ID="${DSH_RUN_ID:-${GITHUB_RUN_ID:?ship-changes: DSH_RUN_ID/GITHUB_RUN_ID unset}}"
DSH_RUN_ATTEMPT="${DSH_RUN_ATTEMPT:-${GITHUB_RUN_ATTEMPT:-1}}"
DSH_WORKTREE="${DSH_WORKTREE:-${GITHUB_WORKSPACE:?ship-changes: DSH_WORKTREE/GITHUB_WORKSPACE unset}}"
# LEGACY-NAME SHIM (retired DSH_BOT_DIR, drift BLOCK run 34803136038): direct
# callers on pre-rename env files keep working, loudly; fail-closed unchanged.
if [ -z "${DSH_AGENT_TOOLKIT_DIR:-}" ] && [ -n "${DSH_BOT_DIR:-}" ]; then
  echo "ship-changes: DSH_BOT_DIR is retired — set DSH_AGENT_TOOLKIT_DIR (accepted for this run)" >&2
  DSH_AGENT_TOOLKIT_DIR="$DSH_BOT_DIR"
fi
DSH_AGENT_TOOLKIT_DIR="${DSH_AGENT_TOOLKIT_DIR:?ship-changes: DSH_AGENT_TOOLKIT_DIR unset}"
DSH_SHIP_CACHE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}"
DSH_AGENT_OUTPUT="${DSH_AGENT_OUTPUT:-$DSH_SHIP_CACHE/dsh-agent-output.txt}"
DSH_SHIP_NOTE_FILE="${DSH_SHIP_NOTE_FILE:-$DSH_SHIP_CACHE/dsh-ship-note.txt}"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

cd "$DSH_WORKTREE" || { echo "ship-changes: cannot cd to $DSH_WORKTREE" >&2; exit 2; }

# Run meta (written by the driver): commits and PR bodies carry the
# model + harness stamp.
DSH_META_FILE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}/dsh-run-meta.env"
DSH_STAMP=""
if [ -f "$DSH_META_FILE" ]; then
  . "$DSH_META_FILE"
  DSH_STAMP="dsh-agent-toolkit: model=${DSH_RUN_MODEL:-?} harness=dsh-${DSH_RUN_DSH_VERSION:-?} run=${DSH_RUN_ID:-_}"
fi

# gh may sit outside the runner service PATH on self-hosted cells (secondsee
# lane-lottery, 2026-08-26): probe the driver's persistent prefix + brew
# prefixes before giving up. Identical list to the driver's CELL_PROBE_DIRS.
command -v gh >/dev/null 2>&1 \
  || export PATH="${DSH_CELL_BIN:-${HOME:-/root}/.dsh-agent-toolkit-bin:${HOME:-/root}/.dsh-bot-bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.doppler/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

# Progress edit: agent phase over, shipping.
if [ -n "${ACK_COMMENT_ID:-}" ] && command -v gh >/dev/null 2>&1; then
  gh api "repos/${DSH_SHIP_REPO}/issues/comments/${ACK_COMMENT_ID}" -X PATCH \
    -f body="**dsh agent** — run: ${DSH_RUN_ID} — lane: ${DSH_RUNNER_NAME:-unknown}${DSH_STAMP:+ — ${DSH_STAMP}}

  :package: Agent finished — shipping any changes." >/dev/null 2>&1 || true
fi

NOTE=""
# Fail-closed scrub flag (issue #162): set when the PR-body pre-scrub fails;
# initialized here because `set -u` reads it on every exit path (the tail
# turns it into exit 3), including the paths that never reach the ship block.
SHIP_SCRUB_FAILED=""

# ship_milestone <pr-num> <gh-pr-create args...>: milestone carry (issue
# #185) — a shipped PR inherits the CLOSING TICKET's milestone (milestones
# render on PR lists and close out with the chain). The ticket comes from
# DSH_CLOSING_TICKET when the caller knows it, else the first "#N" issue
# reference in the PR body (the closing reference). Best-effort with a
# precise warning on failure — a milestone miss must never fail a ship
# (same degrade-or-loud treatment as open_pr's review dispatch).
ship_milestone() {
  local pr_num="$1" a prev="" body refs ref ms
  shift
  command -v gh >/dev/null 2>&1 || return 0
  refs=""
  if [ -n "${DSH_CLOSING_TICKET:-}" ]; then
    refs="$(printf '%s' "$DSH_CLOSING_TICKET" | grep -oE '[0-9]+' || true)"
  fi
  for a in "$@"; do
    case "$prev" in
      --body-file) body="$(cat "$a" 2>/dev/null || true)";;
      --body)      body="$a";;
      *)           body="";;
    esac
    if [ -n "$body" ]; then
      refs="$refs $(printf '%s' "$body" | grep -oE '#[0-9]+' | tr -d '#' | head -5 || true)"
    fi
    prev="$a"
  done
  for ref in $refs; do
    ms="$(gh issue view "$ref" --repo "$DSH_SHIP_REPO" --json milestone --jq '.milestone.title' 2>/dev/null || true)"
    if [ -n "$ms" ] && [ "$ms" != "null" ]; then
      if gh pr edit "$pr_num" --repo "$DSH_SHIP_REPO" --milestone "$ms" >/dev/null 2>&1; then
        echo "milestone '$ms' set on PR #$pr_num (carried from #$ref)"
      else
        echo "::warning::milestone carry FAILED on PR #$pr_num (run: gh pr edit $pr_num --repo $DSH_SHIP_REPO --milestone \"$ms\")" >&2
      fi
      return 0
    fi
  done
}

# freshness_preflight <head-branch>: the PR-mint freshness guard
# (ebowwa/factory#840, the #830 class — a stale-base PR duplicated a mirror
# commit that had landed on main 9 minutes before the PR head was committed,
# and its as-merge tree did not compile). Before the PR opens, compare the
# head branch's merge-base against the LIVE base tip:
#
#   - fresh (merge-base == tip): nothing, silently — the common case must
#     stay zero-cost;
#   - stale (behind > 0): rebase the head onto the base tip and re-push with
#     --force-with-lease, so the tree GitHub will merge is the tree that can
#     still be gated. The rebase runs ONLY on the CURRENT branch (the caller
#     checked it out); a detached/other-branch mint skips the cure and warns.
#     A conflicted rebase aborts clean (git rebase --abort) and warns — the
#     fix round owns it, the ship never dies;
#   - same-scope overlap (a base commit since the branch point touched a file
#     the head branch also touched): a loud note even when the rebase was
#     clean — adjacent auto-merged hunks are exactly how a duplicate fix
#     compiles locally but not as-merge (#830's duplicate object keys).
#
# Degrade-safe: any unresolvable piece (no base, fetch failure, merge-base
# failure — shallow history is the usual cause) ships exactly as before with
# an UNVERIFIED-freshness warning; the guard must never fail a ship.
freshness_preflight() {
  local head_b="$1" base="${DSH_SHIP_BASE:-}" mb tip behind overlap
  if [ -z "$base" ]; then
    base="$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' || true)"
  fi
  if [ -z "$base" ]; then
    echo "freshness: base branch unresolvable — NOT verified (set DSH_SHIP_BASE)" >&2
    echo "freshness UNVERIFIED (base unresolvable)"
    return 0
  fi
  if ! git fetch origin "$base" --quiet 2>/dev/null; then
    echo "freshness: fetch of origin/$base failed — NOT verified" >&2
    echo "freshness UNVERIFIED (fetch of origin/$base failed)"
    return 0
  fi
  mb="$(git merge-base "$head_b" "origin/$base" 2>/dev/null || true)"
  tip="$(git rev-parse "origin/$base" 2>/dev/null || true)"
  if [ -z "$mb" ] || [ -z "$tip" ]; then
    echo "freshness: merge-base of $head_b vs origin/$base unresolvable (shallow clone? run git fetch --unshallow) — NOT verified" >&2
    echo "freshness UNVERIFIED (merge-base unresolvable)"
    return 0
  fi
  if [ "$mb" = "$tip" ]; then
    return 0
  fi
  behind="$(git rev-list --count "$mb..origin/$base" 2>/dev/null || echo '?')"
  overlap="$(comm -12 <(git diff --name-only "$mb" "origin/$base" 2>/dev/null | sort) <(git diff --name-only "$mb" "$head_b" 2>/dev/null | sort) | tr '\n' ' ' | sed 's/ $//')"
  if [ "$(git branch --show-current 2>/dev/null)" = "$head_b" ]; then
    if git rebase "origin/$base" >/dev/null 2>&1; then
      if git push --force-with-lease origin "$head_b" >/dev/null 2>&1; then
        echo "rebased onto origin/$base (was $behind behind)"
      else
        echo "::warning::rebased $head_b onto origin/$base but the force-with-lease re-push FAILED — remote head is stale, the PR may show the pre-rebase tree" >&2
        echo "rebased locally but re-push FAILED ($head_b was $behind behind)"
      fi
    else
      git rebase --abort >/dev/null 2>&1 || true
      echo "::warning::$head_b is $behind behind origin/$base and the rebase CONFLICTED (aborted clean) — fix round must rebase before merge" >&2
      echo "rebase CONFLICTED ($head_b was $behind behind origin/$base)"
    fi
  else
    echo "::warning::$head_b is $behind behind origin/$base and is not the checked-out branch — no rebase attempted; update before merge" >&2
    echo "stale, no rebase attempted ($head_b was $behind behind origin/$base)"
  fi
  if [ -n "$overlap" ]; then
    echo "::warning::same-scope overlap since the branch point: $overlap — base commits touched files this branch also touches; verify the PR does not duplicate already-landed work (factory#830)" >&2
    echo "same-scope overlap: $overlap"
  fi
}

# open_pr <head-branch> <title> <gh pr create args...>: create the PR and
# dispatch its review with the same degrade-or-loud treatment as the
# relay/reply guards — gh missing is a ::warning:: plus a precise ship note
# AFTER a successful push, never a bare 127 that leaves "branch pushed, no
# PR, no review" recorded only as a generic failure (review r2 finding 5).
open_pr() {
  local head_b="$1" title="$2" PR_OUT PR_NUM FRESH
  shift 2
  if ! command -v gh >/dev/null 2>&1; then
    echo "::warning::gh unavailable — $head_b pushed, PR NOT opened (open it from the branch); no review dispatched" >&2
    echo "pushed $head_b (gh unavailable: PR not opened)"
    return 0
  fi
  # Freshness BEFORE the mint (factory#840): a stale base is cured (rebase +
  # re-push) or named loudly before the PR exists, never after.
  FRESH="$(freshness_preflight "$head_b")"
  PR_OUT="$(gh pr create --repo "$DSH_SHIP_REPO" --head "$head_b" \
    --title "$title" "$@" 2>&1 || true)"
  case "$PR_OUT" in
    https://*)
      PR_NUM="$(gh pr view "$head_b" --repo "$DSH_SHIP_REPO" --json number --jq .number 2>/dev/null || true)"
      if [ -n "$PR_NUM" ] && [ -n "${DSH_PR_NUM_FILE:-}" ] && [ ! -f "$DSH_PR_NUM_FILE" ]; then
        echo "$PR_NUM" > "$DSH_PR_NUM_FILE" 2>/dev/null || true
      fi
      if [ -n "$PR_NUM" ]; then
        ship_milestone "$PR_NUM" "$@"
      fi
      if [ -n "$PR_NUM" ] && [ -n "${REVIEW_WORKFLOW:-}" ]; then
        if gh workflow run "$REVIEW_WORKFLOW" --repo "$DSH_SHIP_REPO" -f pr="$PR_NUM" 2>/dev/null; then
          echo "shipped [$head_b]($PR_OUT); review dispatched${FRESH:+; $FRESH}"
        else
          echo "review dispatch failed for #$PR_NUM (run: gh workflow run $REVIEW_WORKFLOW -f pr=$PR_NUM)" >&2
          echo "shipped [$head_b]($PR_OUT)${FRESH:+; $FRESH}"
        fi
      else
        echo "shipped [$head_b]($PR_OUT)${FRESH:+; $FRESH}"
      fi;;
    *)
      echo "gh pr create failed for $head_b: $PR_OUT" >&2
      echo "pushed $head_b (PR create failed: $(echo "$PR_OUT" | head -n1))";;
  esac
}

command -v git >/dev/null 2>&1 || { echo "no git; skip"; echo "" > "$DSH_SHIP_NOTE_FILE"; exit 0; }
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
BEFORE_SHA="$(cat "$DSH_SHIP_CACHE/dsh-before-sha" 2>/dev/null || git rev-parse HEAD)"
git fetch origin --prune --quiet 2>/dev/null || true

if [ -s "$DSH_SHIP_CACHE/dsh-before-open-prs" ] && command -v gh >/dev/null 2>&1; then
  while read -r N; do
    ST="$(gh pr view "$N" --repo "$DSH_SHIP_REPO" --json state --jq .state 2>/dev/null || true)"
    case "$ST" in
      MERGED) NOTE="${NOTE:+$NOTE; }merged #$N";;
      CLOSED) NOTE="${NOTE:+$NOTE; }closed #$N";;
    esac
  done < "$DSH_SHIP_CACHE/dsh-before-open-prs"
fi

git ls-remote origin 'refs/heads/dsh/*' 2>/dev/null | awk '{print $2}' \
  | sed 's|refs/heads/||' | sort > "$DSH_SHIP_CACHE/dsh-after-dsh-branches" || true
NEW_REMOTE="$(comm -13 "$DSH_SHIP_CACHE/dsh-before-dsh-branches" "$DSH_SHIP_CACHE/dsh-after-dsh-branches" 2>/dev/null || true)"
if [ -n "$NEW_REMOTE" ]; then
  NOTE="agent pushed: $(echo "$NEW_REMOTE" | tr '\n' ' ')"
fi

for B in $(git for-each-ref refs/heads/dsh --format='%(refname:short)'); do
  if ! grep -qx "$B" "$DSH_SHIP_CACHE/dsh-after-dsh-branches" 2>/dev/null; then
    if git push -u origin "$B" 2>&1; then
      NOTE="${NOTE:+$NOTE; }$(open_pr "$B" "dsh: ${DSH_TASK_TITLE:-$B}" \
        --body "Automated PR from agent run ${DSH_RUN_ID} (branch pushed by shipper).${DSH_STAMP:+

$DSH_STAMP}")"
    fi
  fi
done

# .dsh-agent-toolkit is the fetched toolkit checkout, NOT agent work (workflow mode);
# the worker's clone contains no toolkit checkout at all, so the exclusion is
# harmless there. DIFF_OK tracks whether the git checks ACTUALLY ran — a
# failing git must never yield a "verified: nothing to ship" note (review
# round on PR #45: the unguarded substitutions collapsed failures to an
# empty diff and the note overclaimed verification).
DIFF_OK=1
DIRTY="$(git status --porcelain -- . ':!.dsh-agent-toolkit' 2>/dev/null)" || DIFF_OK=0
AHEAD="$(git log --oneline "$BEFORE_SHA..HEAD" 2>/dev/null | wc -l | tr -d ' ')" || DIFF_OK=0
if [ -n "$DIRTY" ] || [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null; then
  # Fail-closed PR-body scrub BEFORE any branch/commit/push/PR (issue #162:
  # the scrub used to run inside the body build AFTER the push under
  # `|| true`, so a scrubber failure silently shipped a header-only PR
  # body with the scrubber's typed error discarded by 2>/dev/null). The
  # PR body is AUTHORED PROSE (GitHub-bound): the pre-scrub keeps dates
  # (DSH_SCRUB_KEEP_DATES, issue #152 / ebowwa/FleetTower#301 class) so
  # the gh shim's own KEEP_DATES pass receives them intact instead of
  # finding a [redacted:date] placeholder it cannot restore. Credentials
  # redact in EVERY mode; the reply/review comment surfaces stay
  # default-mode by design (their scrub sites in post-reply.sh /
  # review-pr.sh — timestamps correlate working hours there).
  # A scrubber failure aborts the ship fail-closed (REVIEW.md): nothing is
  # pushed, no PR opens, the scrubber's stderr surfaces, and the script
  # exits 3 after the note. Aborting BEFORE the push is what makes the
  # abort clean — no pushed-but-PR-less branch (the open_pr
  # gh-unavailable trap's worse cousin).
  SHIP_BODY=""
  if [ -f "$DSH_AGENT_OUTPUT" ]; then
    SCRUB_ERR="$(mktemp)"
    if ! SHIP_BODY="$(DSH_SCRUB_KEEP_DATES=1 node "$DSH_AGENT_TOOLKIT_DIR/scripts/scrub-output.mjs" < "$DSH_AGENT_OUTPUT" 2>"$SCRUB_ERR")"; then
      echo "ship-changes: agent-output scrub FAILED — ship ABORTED before push (fail-closed, issue #162); scrubber stderr:" >&2
      cat "$SCRUB_ERR" >&2
      SHIP_SCRUB_FAILED=1
    fi
    rm -f "$SCRUB_ERR"
  fi
  if [ -n "$SHIP_SCRUB_FAILED" ]; then
    NOTE="${NOTE:+$NOTE; }WARNING: agent-output scrub failed — changes found but NOT shipped (fail-closed, issue #162)"
  else
    BRANCH="dsh/auto-r${DSH_RUN_ID}a${DSH_RUN_ATTEMPT}"
    git checkout -B "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"
    if [ -n "$DIRTY" ]; then
      git add -A -- . ':!.dsh-agent-toolkit'
      git commit -m "dsh: automated ship of agent run ${DSH_RUN_ID}" ${DSH_STAMP:+-m "$DSH_STAMP"} --allow-empty 2>/dev/null || true
    fi
    if git push -u origin "$BRANCH" 2>&1; then
      {
        echo "Automated PR from **dsh agent** run ${DSH_RUN_ID}."
        echo
        if [ -n "$DSH_STAMP" ]; then echo "\`${DSH_STAMP}\`"; echo; fi
        echo "**Task:** ${DSH_TASK_TITLE:-_(see run log)_}"
        echo
        echo "---"
        echo
        if [ -f "$DSH_AGENT_OUTPUT" ]; then
          # scrubbed above, BEFORE the push (fail-closed, issue #162) —
          # this block only assembles the already-scrubbed output.
          printf '%s\n' "$SHIP_BODY"
        fi
      } > "$DSH_SHIP_CACHE/dsh-pr-body.md"
      NOTE="${NOTE:+$NOTE; }$(open_pr "$BRANCH" "dsh: ${DSH_TASK_TITLE:-agent changes}" \
        --body-file "$DSH_SHIP_CACHE/dsh-pr-body.md")"
    else
      NOTE="${NOTE:+$NOTE; }WARNING: found changes but push failed"
    fi
  fi
fi

# The ship note: a REAL shipping NOTE always wins (the agent pushed /
# PRs opened — never overwrite that with an UNVERIFIED message, review
# round 2 on PR #50). When there is nothing real, only claim "verified"
# if the git checks actually ran; a failing git yields UNVERIFIED.
if [ -n "$NOTE" ]; then
  echo "ship note: $NOTE"
  echo "$NOTE" > "$DSH_SHIP_NOTE_FILE"
elif [ "${DIFF_OK:-1}" != "1" ]; then
  echo "ship note: nothing to ship — git checks could not run (UNVERIFIED)"
  echo "nothing to ship — git checks could not run (UNVERIFIED)" > "$DSH_SHIP_NOTE_FILE"
else
  echo "ship note: nothing to ship (verified: no repo-state changes, no local diff)"
  echo "nothing to ship (verified: no repo-state changes, no local diff)" > "$DSH_SHIP_NOTE_FILE"
fi

# Fail-closed scrub abort (issue #162): the note above carries the WARNING
# and the scrubber's stderr already surfaced; the nonzero exit is what makes
# the abort FATAL for the calling job (the review-pr.sh exit-3 contract) —
# the worker already treats a nonzero shipper as loud, and a green job that
# silently failed to ship is the defect class this closes.
[ -z "$SHIP_SCRUB_FAILED" ] || exit 3