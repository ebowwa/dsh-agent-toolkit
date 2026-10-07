#!/usr/bin/env bash
# post-reply.sh — post (or PATCH) the agent's final answer on the thread,
# called by the out-of-band worker (dsh-worker.sh); the in-job comment
# workflow that also called it (agent-comment.yml) is removed (issue #264).
#
# Composes the reply (header + scrubbed agent output + ship note), then:
#   - if ACK_COMMENT_ID is set: PATCH that comment in place (the
#     "one living comment per task" UX — the ack comment carries the whole
#     arc: started → shipping → final);
#   - else post a fresh comment on the thread (pr or issue).
#
# The reply write is the one output that must not be droppable — when it is
# lost, the agent's entire run is unrecorded (issue #535). Every write walks
# a pinned retry ladder (60s/120s/240s — sub-minute retries are proven
# useless against a secondary rate limit), classified: only transient
# platform blocks retry, a non-transient failure (404, 422, auth) fails
# fast because no backoff cures it. A fresh-comment write that stays blocked
# through the whole GraphQL ladder falls back to the REST create-comment
# endpoint once (issue #535 receipts: REST cleared after a 240s backoff
# while GraphQL addComment stayed blocked — separate quota pools; a PR
# conversation comment IS an issue comment, so one endpoint covers both).
# Final failure is TYPED, never silent: ::error:: + exit non-zero, naming
# the preserved reply file so the answer stays recoverable.
#
# Everything user-facing is scrubbed fail-closed: if the scrubber cannot
# run, the answer is withheld, never posted raw.
#
# Env contract:
#   GH_TOKEN            required — comment write access (TOWER_PROBE_PAT in the
#                       workflow; the worker's own PAT in decoupled mode)
#   DSH_SHIP_REPO       repo to comment in (default $GITHUB_REPOSITORY)
#   TARGET_KIND         "pr" | "issue" — which gh ... comment subcommand
#   TARGET_NUM          the issue/PR number
#   DSH_AGENT_TOOLKIT_DIR         dsh-agent-toolkit toolkit checkout (contains scripts/)
#   DSH_RUN_ID          run identifier for the reply header
#                       (default $GITHUB_RUN_ID)
#   DSH_RUNNER_NAME     lane/worker name for the header
#   DSH_AGENT_OUTPUT    the agent's raw output file
#                       (default $DSH_SHIP_CACHE/dsh-agent-output.txt)
#   DSH_SHIP_NOTE       the ship note text (default: read
#                       $DSH_SHIP_CACHE/dsh-ship-note.txt when present)
#   DSH_REPLY_OUT       where the composed reply is written
#                       (default $DSH_SHIP_CACHE/dsh-reply.md)
#   DSH_SHIP_CACHE      cache dir holding the agent output + ship note
#                       (default ${RUNNER_TEMP:-/tmp})
#   ACK_COMMENT_ID      optional: the ack comment to PATCH instead of posting
#   EXTRA_SCRUB_HOSTS   optional comma-separated hosts for the scrubber
#                       (mapped to DSH_SCRUB_EXTRA_HOSTS like the driver)
#   DSH_REPLY_BACKOFF_S optional test seam: replaces every ladder wait with
#                       one fixed value; "0" removes the waits entirely while
#                       keeping the REAL bounded loop (attempts, classification,
#                       RC surfacing) — mirrors the driver's DSH_RETRY_BACKOFF_S

set -euo pipefail

DSH_SHIP_REPO="${DSH_SHIP_REPO:-${GITHUB_REPOSITORY:?post-reply: DSH_SHIP_REPO/GITHUB_REPOSITORY unset}}"
# LEGACY-NAME SHIM (retired DSH_BOT_DIR, drift BLOCK run 34803136038): direct
# callers on pre-rename env files keep working, loudly; fail-closed unchanged.
if [ -z "${DSH_AGENT_TOOLKIT_DIR:-}" ] && [ -n "${DSH_BOT_DIR:-}" ]; then
  echo "post-reply: DSH_BOT_DIR is retired — set DSH_AGENT_TOOLKIT_DIR (accepted for this run)" >&2
  DSH_AGENT_TOOLKIT_DIR="$DSH_BOT_DIR"
fi
DSH_AGENT_TOOLKIT_DIR="${DSH_AGENT_TOOLKIT_DIR:?post-reply: DSH_AGENT_TOOLKIT_DIR unset}"
DSH_RUN_ID="${DSH_RUN_ID:-${GITHUB_RUN_ID:-}}"
TARGET_KIND="${TARGET_KIND:?post-reply: TARGET_KIND unset}"
TARGET_NUM="${TARGET_NUM:?post-reply: TARGET_NUM unset}"
case "$TARGET_KIND" in pr|issue) ;; *) echo "post-reply: TARGET_KIND must be pr|issue (got '$TARGET_KIND')" >&2; exit 2;; esac
DSH_SHIP_CACHE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}"
DSH_AGENT_OUTPUT="${DSH_AGENT_OUTPUT:-$DSH_SHIP_CACHE/dsh-agent-output.txt}"
DSH_REPLY_OUT="${DSH_REPLY_OUT:-$DSH_SHIP_CACHE/dsh-reply.md}"
export DSH_SCRUB_EXTRA_HOSTS="${EXTRA_SCRUB_HOSTS:-}"

# gh may sit outside the runner service PATH on self-hosted cells (secondsee
# lane-lottery, 2026-08-26): probe the driver's persistent prefix + brew
# prefixes before giving up (the gh-relevant subset of the driver's
# CELL_PROBE_DIRS — the driver additionally probes bun's install dir for the
# agent session, issue #522, and publishes every addition to GITHUB_PATH,
# which this later step already inherits).
# The reply is the user-facing output channel, so a missing gh downgrades to
# a warning instead of a bare 127.
command -v gh >/dev/null 2>&1 \
  || export PATH="${DSH_CELL_BIN:-${HOME:-/root}/.dsh-agent-toolkit-bin:${HOME:-/root}/.dsh-bot-bin}:/opt/homebrew/bin:/usr/local/bin:$HOME/.doppler/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
command -v gh >/dev/null 2>&1 || {
  echo "::warning::gh unavailable — reply NOT posted to the thread; the agent's answer is in the run log/worker output ($DSH_AGENT_OUTPUT)"
  exit 0
}

# Run meta (written by the driver): every reply stamps the actual model
# and harness version — never a hardcoded label.
DSH_META_FILE="${DSH_SHIP_CACHE:-${RUNNER_TEMP:-/tmp}}/dsh-run-meta.env"
DSH_STAMP="dsh-agent"
if [ -f "$DSH_META_FILE" ]; then
  . "$DSH_META_FILE"
  DSH_STAMP="model: ${DSH_RUN_MODEL:-?} · harness: dsh-${DSH_RUN_DSH_VERSION:-?}"
fi
{
  echo "**dsh agent** — run: ${DSH_RUN_ID:-_} — lane: ${DSH_RUNNER_NAME:-unknown} — ${DSH_STAMP}"
  echo
  if [ -f "$DSH_AGENT_OUTPUT" ]; then
    # OUTPUT surface (reply comment): default mode redacts date shapes —
    # timestamps correlate working hours (scrub-output.mjs taxonomy,
    # issue #152). This pass is LOAD-BEARING for dates: the decoupled
    # worker's tee now keeps dates on the record (the PR body is prose),
    # so without this default-mode scrub the raw date would leak into the
    # posted comment. Credentials redact in every mode either way.
    node "$DSH_AGENT_TOOLKIT_DIR/scripts/scrub-output.mjs" < "$DSH_AGENT_OUTPUT" 2>/dev/null \
      || echo "_(agent output withheld: scrubber unavailable)_"
  else
    echo "_(agent output file missing: $DSH_AGENT_OUTPUT)_"
  fi
  if [ -n "${DSH_SHIP_NOTE:-}" ]; then
    echo
    echo "**Shipped:** $DSH_SHIP_NOTE"
  elif [ -s "$DSH_SHIP_CACHE/dsh-ship-note.txt" ]; then
    echo
    echo "**Shipped:** $(cat "$DSH_SHIP_CACHE/dsh-ship-note.txt")"
  fi
} > "$DSH_REPLY_OUT"

# --- THROTTLE-WAVE RETRY ON THE REPLY WRITE (issue #535) --------------------
# A GitHub secondary rate limit (HTTP 403 "temporarily blocked from content
# creation") or the GraphQL "was submitted too quickly" block loses a single
# unguarded write — and the reply is the one output that must not be lost.
# Ladder: 4 attempts, waits 60s/120s/240s (sub-minute retries NEVER cleared
# the block in the issue #535 receipts). Only the transient classes below
# retry; anything else fails fast on attempt 1.

# Classifies a write failure as transient (echoes the class name) or not
# (non-zero). The class list is the platform-block family: rate limits,
# abuse-detection content blocks, 5xx, raw network blips. A 404, a 422
# validation error, or a credentials failure matches nothing and fails fast
# — no backoff cures the environment it would re-enter.
reply_transient_class() {
  case "$1" in
    *"secondary rate limit"*) echo "secondary rate limit";;
    *"submitted too quickly"*) echo "submitted-too-quickly block";;
    *"temporarily blocked"*) echo "content-creation block";;
    *"rate limit"*) echo "rate limit";;
    *"Bad Gateway"*|*"bad gateway"*|*"Service Unavailable"*|*"service unavailable"*|*"Gateway Time"*|*"gateway time"*|*"internal server error"*|*"Internal Server Error"*) echo "server error";;
    *"Could not resolve host"*|*"Connection refused"*|*"connection refused"*|*"Connection reset"*|*"connection reset"*|*"timed out"*|*"Timed out"*) echo "network error";;
    *) return 1;;
  esac
}

# One write attempt: stdout flows through (the fresh-comment URL reaches the
# worker log), stderr is captured into REPLY_LAST_ERR for classification.
reply_attempt() {
  REPLY_LAST_ERR="$( { "$@" 2>&1 1>&3 3>&-; } 3>&1 )"
  return $?
}

# reply_write_retry <label> <cmd...> — walks the pinned ladder. Emits the
# typed ::error:: on transient exhaustion (naming the preserved reply file)
# and sets REPLY_FINAL_SIG (non-empty iff the final failure was transient);
# a non-transient failure returns the raw rc on attempt 1, REPLY_FINAL_SIG empty.
reply_write_retry() {
  local label="$1"; shift
  local -a waits
  if [ -n "${DSH_REPLY_BACKOFF_S:-}" ]; then
    waits=("$DSH_REPLY_BACKOFF_S" "$DSH_REPLY_BACKOFF_S" "$DSH_REPLY_BACKOFF_S")
  else
    waits=(60 120 240)
  fi
  local attempt rc=0 sig=""
  for attempt in 1 2 3 4; do
    if reply_attempt "$@"; then
      if [ "$attempt" -gt 1 ]; then
        echo "post-reply: $label landed on attempt $attempt" >&2
      fi
      REPLY_FINAL_SIG=""
      return 0
    else
      # the capture MUST live in the else branch: `rc=$?` AFTER the fi
      # reads the if construct's own status (0 on a failed condition), not
      # the write's — the silent-exit-0 class this ladder exists to prevent
      rc=$?
    fi
    sig="$(reply_transient_class "$REPLY_LAST_ERR" || true)"
    if [ -z "$sig" ]; then
      echo "::error::post-reply: $label FAILED with a NON-transient error (attempt ${attempt}/4) — no backoff and no retry cures this class, failing fast; the composed reply is PRESERVED at ${DSH_REPLY_OUT}" >&2
      printf '%s\n' "$REPLY_LAST_ERR" >&2
      REPLY_FINAL_SIG=""
      return "$rc"
    fi
    if [ "$attempt" -lt 4 ]; then
      echo "post-reply: $label hit a transient platform block (${sig}) — attempt ${attempt}/4, retrying in ${waits[$((attempt-1))]}s (issue #535: sub-minute retries never clear it):" >&2
      printf '%s\n' "$REPLY_LAST_ERR" >&2
      sleep "${waits[$((attempt-1))]}"
    fi
  done
  echo "::error::post-reply: $label FAILED after 4 attempts (transient platform block never cleared: ${sig}) — the composed reply is PRESERVED at ${DSH_REPLY_OUT}; post it manually, never re-run the whole task for this" >&2
  printf '%s\n' "$REPLY_LAST_ERR" >&2
  REPLY_FINAL_SIG="$sig"
  return "$rc"
}

# reply_rest_fallback <primary_rc> — the GraphQL→REST channel switch,
# reached only when the fresh-comment ladder FAILED. A TRANSIENT exhaustion
# switches channels (issue #535 receipts: REST cleared after a 240s backoff
# while GraphQL addComment stayed blocked through the same wave — separate
# quota pools; a PR conversation comment IS an issue comment, so the one
# REST create endpoint covers both TARGET_KINDs). A NON-transient failure
# propagates the primary rc unchanged — fail fast stays fail fast, no
# channel switch can cure a 404. The fallback walks the same ladder.
reply_rest_fallback() {
  local rc="$1"
  if [ -z "${REPLY_FINAL_SIG:-}" ]; then
    return "$rc"
  fi
  echo "post-reply: GraphQL channel stayed blocked through the whole ladder — falling back to the REST create-comment channel (issue #535)" >&2
  reply_write_retry "REST create-comment" \
    gh api "repos/${DSH_SHIP_REPO}/issues/${TARGET_NUM}/comments" \
      -F body="@$DSH_REPLY_OUT"
}

if [ -n "${ACK_COMMENT_ID:-}" ]; then
  # edit the ack comment in place — one comment per task. No POST fallback:
  # a fresh comment would break the one-comment-per-task UX, and the typed
  # error below preserves the reply file either way. (>/dev/null keeps the
  # PATCH response body out of the log — the original behavior.)
  reply_write_retry "ack comment PATCH" \
    gh api "repos/${DSH_SHIP_REPO}/issues/comments/${ACK_COMMENT_ID}" -X PATCH \
      -F body="@$DSH_REPLY_OUT" >/dev/null
elif [ "$TARGET_KIND" = "pr" ]; then
  rc=0
  reply_write_retry "pr comment" \
    gh pr comment "$TARGET_NUM" --repo "$DSH_SHIP_REPO" --body-file "$DSH_REPLY_OUT" || rc=$?
  [ "$rc" -eq 0 ] || reply_rest_fallback "$rc"
else
  rc=0
  reply_write_retry "issue comment" \
    gh issue comment "$TARGET_NUM" --repo "$DSH_SHIP_REPO" --body-file "$DSH_REPLY_OUT" || rc=$?
  [ "$rc" -eq 0 ] || reply_rest_fallback "$rc"
fi