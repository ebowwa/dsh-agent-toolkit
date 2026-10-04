#!/usr/bin/env bash
# install-worker.sh — one-shot, IDEMPOTENT worker deployment for a factory
# box. The worker-deploy.yml workflow calls this ON the box (the
# self-register-factory pattern: a workflow may install a persistent
# per-user service; cron keepalive needs no sudo).
#
# What it installs:
#   1. the toolkit checkout (clone if absent) at $DSH_AGENT_TOOLKIT_INSTALL_DIR
#      (default ~/dsh-agent-toolkit);
#   2. the worker env file (0600) at $DSH_WORKER_HOME/env (default
#      ~/.dsh-worker/env) — the ONLY place the credentials ever land
#      (never the cron line, never the log);
#   3. the cron keepalive line: every minute, flock-guard, RE-PIN the
#      toolkit to the moving `v1` tag through scripts/re-pin-toolkit.sh
#      (fetch --tags + checkout v1 — the audited-release pin drift-check
#      advances — behind a refusal gate: never destroy in-flight agent
#      work sitting in the shared checkout, issue #276), source the env
#      file, run one sweep. The worker's code therefore updates itself
#      only through the repo's own release gate.
#
# Env contract (values via env; NEVER printed):
#   WORKER_GH_CRED          required — the worker PAT (TOWER_PROBE_PAT)
#   WORKER_DOPPLER_CRED     required — DOPPLER_SERVICE_TOKEN
#   WORKER_REPOS            required — DSH_WORKER_REPOS value
#                           (space-separated owner/repo list)
#   DSH_AGENT_TOOLKIT_INSTALL_DIR     toolkit location (default $HOME/dsh-agent-toolkit)
#   DSH_WORKER_HOME         worker home (default $HOME/.dsh-worker)
#
# Exit: 0 installed (or already installed); 2 missing env; 3 clone failed.

set -euo pipefail

# This script's own directory — the guarded re-pin arm ships beside it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHECK() { # <varname> — required env, typed exit 2
  local v="$1"
  if [ -z "${!v:-}" ]; then echo "install-worker: $v unset (required)" >&2; exit 2; fi
}
CHECK WORKER_GH_CRED
CHECK WORKER_DOPPLER_CRED
CHECK WORKER_REPOS

# LEGACY-NAME SHIM (retired DSH_BOT_INSTALL_DIR, drift BLOCK run 34803136038):
# provisioning automation passing the old var must keep landing on its existing
# checkout — a silently ignored var used to clone a SECOND toolkit beside the
# old one and leave the stale clone sweeping cron-era state.
DSH_AGENT_TOOLKIT_DIR="${DSH_AGENT_TOOLKIT_INSTALL_DIR:-${DSH_BOT_INSTALL_DIR:-$HOME/dsh-agent-toolkit}}"
if [ -z "${DSH_AGENT_TOOLKIT_INSTALL_DIR:-}" ] && [ -n "${DSH_BOT_INSTALL_DIR:-}" ]; then
  echo "install-worker: DSH_BOT_INSTALL_DIR is retired — set DSH_AGENT_TOOLKIT_INSTALL_DIR (accepted for this install)" >&2
fi
WORKER_HOME="${DSH_WORKER_HOME:-$HOME/.dsh-worker}"

# 1. toolkit checkout (clone when absent) and refresh the pin through
#    the GUARDED re-pin arm (issue #276): the per-minute keepalive
#    refuses to destroy in-flight agent work, and the install-time
#    refresh runs the SAME gate — a redeploy on a box whose shared
#    checkout is mid-edit must not clobber it either. A refusal (exit 3)
#    or a degradation (exit 4) warns below and leaves the previously
#    pinned release in place: the deploy still arms the guarded
#    keepalive, which re-pin-refuses loudly every sweep until the tree
#    is cleaned. safe.directory is set inside the guard's git wrapper.
#    No -q on the clone: nothing in this installer may fail quietly.
PIN_OK=0
if [ ! -d "$DSH_AGENT_TOOLKIT_DIR/.git" ]; then
  git clone https://github.com/ebowwa/dsh-agent-toolkit.git "$DSH_AGENT_TOOLKIT_DIR" \
    || { echo "install-worker: toolkit clone failed (egress?)" >&2; exit 3; }
fi
if bash "$SCRIPT_DIR/re-pin-toolkit.sh" "$DSH_AGENT_TOOLKIT_DIR"; then
  PIN_OK=1
  echo "install-worker: toolkit pinned at $(git -c safe.directory="$DSH_AGENT_TOOLKIT_DIR" -C "$DSH_AGENT_TOOLKIT_DIR" describe --tags 2>/dev/null || echo v1)"
else
  echo "install-worker: WARNING — guarded re-pin did not land (refused or degraded — see the note above); the toolkit runs its previous checkout and the keepalive will refuse re-pins until the tree is cleaned (issue #276)" >&2
fi

# 2. env file — umask 177 so the file is born 0600; values never echoed
mkdir -p "$WORKER_HOME"
chmod 700 "$WORKER_HOME"
( umask 177
  cat > "$WORKER_HOME/env" <<EOF
GH_TOKEN=${WORKER_GH_CRED}
DOPPLER_SERVICE_TOKEN=${WORKER_DOPPLER_CRED}
DSH_AGENT_TOOLKIT_DIR="${DSH_AGENT_TOOLKIT_DIR}"
DSH_WORKER_REPOS="${WORKER_REPOS}"
${WORKER_MODEL_MAP:+DSH_WORKER_MODEL_MAP="${WORKER_MODEL_MAP}"}
EOF
)
chmod 600 "$WORKER_HOME/env"
touch "$WORKER_HOME/worker.log" 2>/dev/null || true

# 3. cron keepalive — idempotent (skipped when the line exists). The
#    credentials are NOT in the line: it sources the 0600 env file.
#    The re-pin rides scripts/re-pin-toolkit.sh, NOT inline git (issue
#    #276): the inline `checkout -q --force v1` destroyed in-flight
#    agent work in the shared checkout the moment drift-check advanced
#    the tag (two resets in ~10 minutes on seed-L3). The guard keeps
#    --force (the 2026-09-21 incident: a bare `checkout v1` silently
#    KEPT local modifications — an in-place patch of settings.zai.yaml
#    left every box's checkout dirty, and the sweep shadowed
#    v1.73.0→v1.74.0 for hours) but refuses to run it at all while the
#    tree carries tracked modifications or a working branch — a LOUD
#    worker.log refusal instead of silent destruction either way. The
#    guard's notes (and only those — success is quiet) land in
#    worker.log; `;` (never &&) so the sweep runs on every exit code.
# Overlap guard = flock, NOT pgrep. Every pgrep form self-matches here:
# the carrier sh -c's cmdline contains the REAL script path in the sweep
# braces, so the guard pattern always finds ITSELF (bracket tricks only
# protect the pattern's own text — live-proven twice on seed-dshbot:
# plain AND bracketed pgrep both never let a sweep run, worker.log empty
# for 25+ minutes). flock -n is the canonical cron mutual exclusion: if a
# sweep is running, this tick exits instantly; otherwise it runs.
command -v flock >/dev/null 2>&1 \
  || { echo "install-worker: flock (util-linux) required for the keepalive — provision the box" >&2; exit 3; }
# The sweep AND the re-pin arm are invoked via `bash <script>` (NEVER
# directly): the repo ships scripts mode 644 — a direct invocation is
# "Permission denied" (live-proven: the keepalive fired every minute
# from 17:52 and died at exactly this word until fixed).
LINE="* * * * * flock -n ${WORKER_HOME}/sweep.lock /bin/bash -c '/bin/bash ${DSH_AGENT_TOOLKIT_DIR}/scripts/re-pin-toolkit.sh ${DSH_AGENT_TOOLKIT_DIR} >> ${WORKER_HOME}/worker.log 2>&1; set -a; . ${WORKER_HOME}/env; set +a; exec /bin/bash ${DSH_AGENT_TOOLKIT_DIR}/scripts/dsh-worker.sh --once >> ${WORKER_HOME}/worker.log 2>&1'"
# The canonical-line rule: ALWAYS drop any existing dsh-worker line and
# install the current one. Append-only idempotence ships upgrades never
# (the box keeps its first, buggier line forever); rewrite-always is the
# upgrade path (two shipped lines already needed replacing: the
# self-matching pgrep, the tag-clobbering fetch).
if crontab -l 2>/dev/null | grep -F "dsh-worker.sh --once" >/dev/null 2>&1; then
  # grep -v exits 1 when the line was the ONLY crontab entry — expected,
  # not a failure (|| true on the GREP, never on the crontab write)
  { crontab -l 2>/dev/null | grep -vF "dsh-worker.sh --once" || true; } | crontab -
  echo "install-worker: previous keepalive line removed (canonical line enforced)"
fi
(crontab -l 2>/dev/null; echo "$LINE") | crontab - \
  || { echo "install-worker: crontab install failed" >&2; exit 3; }

echo "install-worker: OK"
echo "  toolkit : $DSH_AGENT_TOOLKIT_DIR (pinned to the moving v1 tag per sweep)"
echo "  env     : $WORKER_HOME/env (mode 600) — the only credential resting place"
echo "  cron    : keepalive armed (flock-guarded, once per minute)"
echo "  repos   : $WORKER_REPOS"
echo "  watch   : $WORKER_HOME/worker.log"