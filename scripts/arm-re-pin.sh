#!/usr/bin/env bash
# arm-re-pin.sh — arm the #276 re-pin keepalive on a node that runs the
# driver WITHOUT install-worker.sh (FleetTower issue #2109).
#
# scripts/install-worker.sh deploys the whole worker package: checkout,
# env file, and the per-minute cron keepalive whose first half re-pins the
# shared toolkit checkout to the moving `v1` tag through the guarded
# scripts/re-pin-toolkit.sh. Lane boxes get that arm at provision time —
# but a node class that never runs install-worker.sh (the Hermes-profile
# macOS cells: sessions spawn from the standing driver, no worker sweep,
# no crontab) never gets a re-pin arm at all. The #2109 receipt: air16's
# deployed checkout sat 221 commits / ~11 days behind its own origin/main
# and kept installing the pre-#251 git-scrub-shim ten days after the fix
# shipped, because nothing on the box moved the checkout forward.
#
# This script arms ONLY the re-pin half — the guarded re-pin on an
# interval, NO worker sweep, NO env file, NO credentials anywhere — so a
# worker-less node can keep its deployment checkout on the moving `v1`
# release without growing a second worker drive next to its own node
# supervisor. The arm is OS-appropriate:
#
#   darwin → a per-user launchd agent ($HOME/Library/LaunchAgents/<label>
#            .plist, StartInterval), the box convention the dsh node
#            plists already follow (com.dsh.selfheal et al.);
#   linux  → a markered crontab line (flock -n guarded), the
#            install-worker.sh convention minus the worker invocation.
#
# Both arms are IDEMPOTENT: re-running replaces this arm's own unit/line
# (label / marker matched) and never duplicates. After arming, the guarded
# re-pin runs ONCE synchronously and its exit contract is reported (0
# pinned / 3 refused — live work in the checkout, the keepalive keeps
# refusing until cleaned / 4 degraded — network or checkout failure, the
# keepalive retries next interval). A refused/degraded FIRST pin does NOT
# fail the arm — the unit is correct; the checkout state is separate and
# printed loud.
#
# Defaults: hourly interval (3600s). Lane boxes re-pin per-minute because
# their worker sweep already runs then — the re-pin just rides it; a
# worker-less node heals at release cadence, and `--interval N` moves it.
#
# Usage: arm-re-pin.sh [toolkit-dir] [--interval N] [--label L] [--log F]
# Env:   DSH_AGENT_TOOLKIT_DIR  — the dir when argv[1] is absent
#        DSH_ARM_RE_PIN_OS      — force darwin|linux (test/override hook;
#                                 default: uname)
# Exit:  0 armed · 2 usage / not a checkout / guarded re-pin arm missing
#        3 linux arm lacks flock (the install-worker typed failure)
#
# The re-pin is invoked via `/bin/bash <script>` NEVER a direct exec —
# a checkout that lost the exec bit must not silently break the arm
# (the live-proven install-worker.sh receipt, keepalive "Permission
# denied" under cron).

set -uo pipefail

DIR=""
INTERVAL=3600
LABEL="com.dsh.re-pin"
LOG="$HOME/dsh-re-pin.log"

usage() {
  echo "usage: arm-re-pin.sh [toolkit-dir] [--interval N] [--label L] [--log F]" >&2
  echo "  env: DSH_AGENT_TOOLKIT_DIR (dir fallback), DSH_ARM_RE_PIN_OS (darwin|linux)" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
    --label)    LABEL="${2:?--label needs a value}"; shift 2 ;;
    --log)      LOG="${2:?--log needs a value}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         echo "arm-re-pin: unknown flag $1" >&2; usage; exit 2 ;;
    *)          if [ -z "$DIR" ]; then DIR="$1"; shift; else echo "arm-re-pin: unexpected arg $1" >&2; usage; exit 2; fi ;;
  esac
done

DIR="${DIR:-${DSH_AGENT_TOOLKIT_DIR:-}}"
if [ -z "$DIR" ]; then
  echo "arm-re-pin: no toolkit dir given (arg 1 or DSH_AGENT_TOOLKIT_DIR)" >&2
  usage
  exit 2
fi
if [ ! -d "$DIR/.git" ]; then
  echo "arm-re-pin: $DIR is not a git checkout (.git missing)" >&2
  exit 2
fi

# Absolute paths — launchd runs with no shell and no cwd assumptions, and
# a cron line is word-split, so both arms embed resolved paths only.
DIR="$(cd "$DIR" && pwd)"
RE_PIN="$DIR/scripts/re-pin-toolkit.sh"
if [ ! -f "$RE_PIN" ]; then
  echo "arm-re-pin: REFUSING — $DIR carries no scripts/re-pin-toolkit.sh (a pre-#276 pin)." >&2
  echo "  Move the checkout to a v1 release that carries the guarded arm" >&2
  echo "  (v1 >= c173b02) or run scripts/install-worker.sh first, then re-arm." >&2
  exit 2
fi
RE_PIN="$(cd "$(dirname "$RE_PIN")" && pwd)/$(basename "$RE_PIN")"

case "${DSH_ARM_RE_PIN_OS:-$(uname -s)}" in
  Darwin|darwin) OS=darwin ;;
  Linux|linux)   OS=linux ;;
  *) echo "arm-re-pin: unsupported OS '${DSH_ARM_RE_PIN_OS:-$(uname -s)}'" >&2; exit 2 ;;
esac

case "$INTERVAL" in
  ''|*[!0-9]*) echo "arm-re-pin: --interval must be a positive integer (seconds), got '$INTERVAL'" >&2; exit 2 ;;
esac

if [ "$OS" = darwin ]; then
  PLIST_DIR="${DSH_ARM_RE_PIN_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  mkdir -p "$PLIST_DIR"
  PLIST="$PLIST_DIR/$LABEL.plist"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$RE_PIN</string>
    <string>$DIR</string>
  </array>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>StandardOutPath</key><string>$LOG</string>
</dict></plist>
EOF
  # Best-effort structural lint: real on a macOS host (plutil ships with
  # the OS), skipped where the binary is absent (hermetic test lanes).
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$PLIST" >/dev/null || { echo "arm-re-pin: minted plist failed plutil -lint: $PLIST" >&2; exit 2; }
  fi
  # Idempotent (re)load: bootstrap is the modern arm; an already-loaded
  # label bootstraps EEXIST — bootout the label, bootstrap again.
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "arm-re-pin: launchctl bootstrap failed for $LABEL" >&2; exit 2; }
  fi
  if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "arm-re-pin: WARNING — $LABEL not visible in launchd print (it may still fire; check $LOG)" >&2
  fi
  echo "arm-re-pin: armed (darwin launchd) — $PLIST"
  echo "  label    : $LABEL (every ${INTERVAL}s, via /bin/bash $RE_PIN)"
else
  command -v flock >/dev/null 2>&1 || { echo "arm-re-pin: flock (util-linux) required for the keepalive — provision the box" >&2; exit 3; }
  MARKER="# dsh-re-pin (arm-re-pin.sh)"
  # cron speaks in MINUTES: map the second interval onto a schedule or
  # refuse — a sub-minute keepalive is not expressible in crontab.
  if [ "$INTERVAL" -eq 3600 ]; then
    SCHEDULE="0 * * * *"
  elif [ $((INTERVAL % 3600)) -eq 0 ]; then
    SCHEDULE="0 */$((INTERVAL / 3600)) * * *"
  elif [ $((INTERVAL % 60)) -eq 0 ]; then
    SCHEDULE="*/$((INTERVAL / 60)) * * * *"
  else
    echo "arm-re-pin: --interval $INTERVAL is not expressible in cron (minutes only) — use a multiple of 60" >&2
    exit 2
  fi
  LINE="$SCHEDULE flock -n $HOME/.dsh-re-pin.lock /bin/bash $RE_PIN $DIR >> $LOG 2>&1 $MARKER"
  # Drop THIS arm's previous line (marker-matched), keep everything else.
  { crontab -l 2>/dev/null | grep -vF "$MARKER" || true; echo "$LINE"; } | crontab - \
    || { echo "arm-re-pin: crontab install failed" >&2; exit 2; }
  echo "arm-re-pin: armed (linux cron) — schedule '$SCHEDULE'"
  echo "  line     : $LINE"
fi

# First pin, synchronous, verdict reported — never failing the arm.
PIN_RC=0
bash "$RE_PIN" "$DIR" || PIN_RC=$?
case $PIN_RC in
  0) echo "arm-re-pin: first pin landed — $DIR at $(GIT_OPTIONAL_LOCKS=0 git -c safe.directory="$DIR" -C "$DIR" describe --tags 2>/dev/null || echo v1)" ;;
  3) echo "arm-re-pin: WARNING — first pin REFUSED (live work in the checkout: tracked mods or a working branch). The arm is correct; the keepalive refuses re-pins until the tree is cleaned (issue #276 contract)." >&2 ;;
  4) echo "arm-re-pin: WARNING — first pin degraded (fetch/checkout failed); the keepalive retries next interval" >&2 ;;
  *) echo "arm-re-pin: WARNING — first pin exited $PIN_RC (unexpected); the keepalive retries next interval" >&2 ;;
esac

echo "arm-re-pin: target   : $DIR (moving v1)"
echo "arm-re-pin: log      : $LOG"
exit 0
