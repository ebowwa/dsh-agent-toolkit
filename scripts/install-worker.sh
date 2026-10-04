#!/usr/bin/env bash
# install-worker.sh — one-shot, IDEMPOTENT worker deployment for a factory
# box. The deploy-worker.yml workflow calls this ON the box (the
# self-register-factory pattern: a workflow may install a persistent
# per-user service; cron keepalive needs no sudo).
#
# What it installs:
#   1. the toolkit checkout (clone if absent) at $DSH_AGENT_TOOLKIT_INSTALL_DIR
#      (default ~/dsh-agent-toolkit);
#   2. the worker env file (0600) at $DSH_WORKER_HOME/env (default
#      ~/.dsh-worker/env) — the ONLY place the credentials ever land
#      (never the cron line, never the log);
#   3. the cron keepalive line: every minute, flock-guarded, run the
#      GUARDED re-pin (scripts/repin-toolkit.sh: fetch --tags + checkout
#      v1 that REFUSES to move HEAD while a working branch is checked
#      out or the default branch is dirty — issue #276; the pinned
#      steady state keeps the tag-only --force discipline), source the
#      env file, run one sweep. The worker's code therefore updates
#      itself only through the repo's own release gate.
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

# 1. toolkit checkout (clone when absent) and ALWAYS refresh the pin to
#    the current v1 release — a deploy must run what steady-state runs
#    (the first activation ran a stale checkout and re-failed a fixed
#    bug). The re-pin rides the SAME guarded script the cron line runs
#    (#276): a working branch checked out (or a dirty default branch)
#    makes the pin SKIP with a note instead of force-moving HEAD under
#    an in-place worker. safe.directory is set explicitly inside the
#    script: the Actions runner's per-job HOME/gitconfig handling can
#    trip git's ownership guard silently.
#    No -q on the installer's own steps: nothing here fails quietly.
#    The re-pin script is resolved BESIDE THE INSTALLER, not inside the
#    install dir: a box whose install dir still holds a pre-#276 checkout
#    (no repin-toolkit.sh in it) must still pin forward from the NEW
#    installer that does carry it.
REPIN_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/repin-toolkit.sh"
if [ ! -f "$REPIN_SCRIPT" ]; then
  echo "install-worker: repin-toolkit.sh missing beside the installer — run from a full checkout" >&2
  exit 3
fi
PIN_OK=0
if [ ! -d "$DSH_AGENT_TOOLKIT_DIR/.git" ]; then
  git clone https://github.com/ebowwa/dsh-agent-toolkit.git "$DSH_AGENT_TOOLKIT_DIR" \
    || { echo "install-worker: toolkit clone failed (egress?)" >&2; exit 3; }
fi
if PIN_NOTE=$(/bin/bash "$REPIN_SCRIPT" "$DSH_AGENT_TOOLKIT_DIR"); then
  PIN_OK=1
  echo "install-worker: $PIN_NOTE"
else
  echo "install-worker: WARNING — could not refresh the pin to v1; the toolkit runs its previous checkout (cron retries each sweep)" >&2
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
#    RE-PIN IS GUARDED (#276): the line runs scripts/repin-toolkit.sh,
#    which fetches tags and checks out v1 ONLY when the checkout is
#    unowned (detached at the pin, or a clean default branch). A working
#    branch or a dirty tree makes the re-pin SKIP with a dated note in
#    worker.log — the blind `checkout -q --force v1` this line used to
#    carry moved HEAD off a working agent's branch and cleaned the tree
#    mid-edit (the #276 receipts).
#    The pinned steady state keeps --force deliberately (2026-09-21
#    incident): a bare `checkout v1` SILENTLY KEEPS local modifications —
#    an in-place patch of settings.zai.yaml (the door switch) left every
#    box's checkout dirty, and the sweep then shadowed v1.73.0→v1.74.0
#    for hours while agent homes regenerated from the stale template.
#    --force on the DETACHED pin discards stray local edits; the template
#    channel is tag-only by design.
#    The re-pin failing degrades to running the previously pinned
#    release (the error lands in worker.log) — never a broken sweep.
# Overlap guard = flock, NOT pgrep. Every pgrep form self-matches here:
# the carrier sh -c's cmdline contains the REAL script path in the sweep
# braces, so the guard pattern always finds ITSELF (bracket tricks only
# protect the pattern's own text — live-proven twice on seed-dshbot:
# plain AND bracketed pgrep both never let a sweep run, worker.log empty
# for 25+ minutes). flock -n is the canonical cron mutual exclusion: if a
# sweep is running, this tick exits instantly; otherwise it runs.
command -v flock >/dev/null 2>&1 \
  || { echo "install-worker: flock (util-linux) required for the keepalive — provision the box" >&2; exit 3; }
# The sweep is invoked via `bash <script>` (NEVER directly): the repo
# ships scripts mode 644 — a direct invocation is "Permission denied"
# (live-proven: the keepalive fired every minute from 17:52 and died at
# exactly this word until fixed). Same for the re-pin script.
# TRANSITION ARM: a checkout pinned BEFORE this line existed has no
# repin-toolkit.sh in it — falling back to the legacy bare re-pin (the
# pre-#276 status quo) until the box pins forward must never wedge the
# box on a line whose script is absent.
LINE="* * * * * flock -n ${WORKER_HOME}/sweep.lock /bin/bash -c '{ if [ -f ${DSH_AGENT_TOOLKIT_DIR}/scripts/repin-toolkit.sh ]; then /bin/bash ${DSH_AGENT_TOOLKIT_DIR}/scripts/repin-toolkit.sh ${DSH_AGENT_TOOLKIT_DIR}; else git -C ${DSH_AGENT_TOOLKIT_DIR} fetch --tags --force -q && git -C ${DSH_AGENT_TOOLKIT_DIR} checkout -q --force v1; fi || echo repin-toolkit: degraded - fetch or checkout failed, sweep runs the previous pin; set -a; . ${WORKER_HOME}/env; set +a; exec /bin/bash ${DSH_AGENT_TOOLKIT_DIR}/scripts/dsh-worker.sh --once; } >> ${WORKER_HOME}/worker.log 2>&1'"
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
echo "  toolkit : $DSH_AGENT_TOOLKIT_DIR (pinned to the moving v1 tag per sweep, guarded — #276)"
echo "  env     : $WORKER_HOME/env (mode 600) — the only credential resting place"
echo "  cron    : keepalive armed (flock-guarded, once per minute; the re-pin skips a busy checkout)"
echo "  repos   : $WORKER_REPOS"
echo "  watch   : $WORKER_HOME/worker.log"