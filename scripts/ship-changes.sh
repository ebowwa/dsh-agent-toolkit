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

# open_pr <head-branch> <title> <gh-pr-create args...>: create the PR and
# dispatch its review with the same degrade-or-loud treatment as the
# relay/reply guards — gh missing is a ::warning:: plus a precise ship note
# AFTER a successful push, never a bare 127 that leaves "branch pushed, no
# PR, no review" recorded only as a generic failure (review r2 finding 5).
open_pr() {
  local head_b="$1" title="$2" PR_OUT PR_NUM
  shift 2
  if ! command -v gh >/dev/null 2>&1; then
    echo "::warning::gh unavailable — $head_b pushed, PR NOT opened (open it from the branch); no review dispatched" >&2
    echo "pushed $head_b (gh unavailable: PR not opened)"
    return 0
  fi
  PR_OUT="$(gh pr create --repo "$DSH_SHIP_REPO" --head "$head_b" \
    --title "$title" "$@" 2>&1 || true)"
  case "$PR_OUT" in
    https://*)
      PR_NUM="$(gh pr view "$head_b" --repo "$DSH_SHIP_REPO" --json number --jq .number 2>/dev/null || true)"
      if [ -n "$PR_NUM" ] && [ -n "${DSH_PR_NUM_FILE:-}" ] && [ ! -f "$DSH_PR_NUM_FILE" ]; then
        echo "$PR_NUM" > "$DSH_PR_NUM_FILE" 2>/dev/null || true
      fi
      if [ -n "$PR_NUM" ] && [ -n "${REVIEW_WORKFLOW:-}" ]; then
        if gh workflow run "$REVIEW_WORKFLOW" --repo "$DSH_SHIP_REPO" -f pr="$PR_NUM" 2>/dev/null; then
          echo "shipped [$head_b]($PR_OUT); review dispatched"
        else
          echo "review dispatch failed for #$PR_NUM (run: gh workflow run $REVIEW_WORKFLOW -f pr=$PR_NUM)" >&2
          echo "shipped [$head_b]($PR_OUT)"
        fi
      else
        echo "shipped [$head_b]($PR_OUT)"
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