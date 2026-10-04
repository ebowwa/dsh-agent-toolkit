#!/usr/bin/env bash
# cell-disk-guard.sh — free-space admission control + _diag-archive rotation
# for a dsh runner cell (issue ebowwa/dsh-agent-toolkit#478).
#
# The incident: the seed cell's burst pool mints ephemeral runners
# (`seed-burst-*`, ~700M each from template/) and preserves their `_diag`
# into `/home/runner/lane-burst/_diag-archive/` on every reap — 2718 archived
# dirs and climbing — while a couple of concurrent bursts push the shared
# root fs to 100%. The gates pre-step (PR #477, issue #474) fails the JOB
# loudly at a 2048 MiB floor; the SPINNER side kept minting straight through
# the same trough. This script carries the two spawner-side levers the issue
# asks for:
#
#   admit    — refuse a mint when free space is under a floor, with the SAME
#              floor semantics as the gates pre-step (default 2048 MiB, env
#              overridable; read df -kP, print the numbers, exit nonzero).
#              The burst spawner (FleetTower scripts/2o/lane-supervisor.ts,
#              issue FleetTower#1018 / PR FleetTower#1052) calls this before
#              every mint; any mint path on any cell can do the same.
#   rotate   — prune the diag archive oldest-first (keep-N + max-age) so the
#              reap-preserving post-mortems stop growing unbounded. Never
#              touches live runner bodies — it operates strictly INSIDE the
#              archive dir and refuses a dir that looks like a minted runner
#              (run.sh + config.sh at its root).
#   schedule — print the root-side systemd service+timer units and the
#              crontab fallback for the rotation (the archive is chowned
#              root:root by the spawner's reap, so the canonical schedule
#              runs as root on the box; the scheduled Actions workflow
#              cell-disk-guard.yml is the belt over that suspenders).
#
# Exit codes: 0 = fine · 1 = guard tripped (under floor / rotation blocked)
# · 2 = usage or refuse-to-operate error.

set -euo pipefail

CELL_DISK_FLOOR_DEFAULT_MB=2048   # parity with the gates pre-step's GATES_DISK_FLOOR_MB default (PR #477)
CELL_DISK_GUARD_ARCHIVE_DEFAULT="/home/runner/lane-burst/_diag-archive"
CELL_DISK_GUARD_KEEP_DEFAULT=500  # post-mortems worth of _diag dirs kept, newest first
CELL_DISK_GUARD_MAX_AGE_DAYS_DEFAULT=14

usage() {
  cat >&2 <<'EOF'
usage:
  cell-disk-guard.sh admit    [--path DIR] [--floor-mb N]
  cell-disk-guard.sh rotate   [--archive DIR] [--keep N] [--max-age-days D] [--dry-run]
  cell-disk-guard.sh schedule
env:
  CELL_DISK_FLOOR_MB           floor override for admit (default 2048 — gates parity)
  CELL_DISK_GUARD_ARCHIVE      archive dir override for rotate
  CELL_DISK_GUARD_KEEP         keep-N override (default 500)
  CELL_DISK_GUARD_MAX_AGE_DAYS age override (default 14)
  CELL_DISK_GUARD_SUDO         privilege-escalation binary for root-owned archive
                               entries (default "sudo"; set to a nonexistent path
                               to construct "no escalation available" hermetically)
exit: 0 fine · 1 guard tripped · 2 usage/refusal
EOF
  exit 2
}

free_avail_mb() { # free_avail_mb DIR -> MiB available on DIR's fs (gates-pre-step math)
  local avail_kb
  avail_kb="$(df -kP "$1" | awk 'NR==2 {print $4}')"
  [ -n "$avail_kb" ] || { echo "cell-disk-guard: df produced no avail for $1" >&2; return 2; }
  echo $((avail_kb / 1024))
}

cmd_admit() {
  local path="${CELL_DISK_GUARD_ADMIT_PATH:-$PWD}"
  local floor_mb="${CELL_DISK_FLOOR_MB:-$CELL_DISK_FLOOR_DEFAULT_MB}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --path) path="$2"; shift 2 ;;
      --floor-mb) floor_mb="$2"; shift 2 ;;
      *) echo "cell-disk-guard admit: unknown arg $1" >&2; usage ;;
    esac
  done
  [ -d "$path" ] || { echo "cell-disk-guard admit: not a directory: $path" >&2; exit 2; }
  case "$floor_mb" in ''|*[!0-9]*) echo "cell-disk-guard admit: floor must be a non-negative integer (MiB): $floor_mb" >&2; exit 2 ;; esac
  local avail_mb
  avail_mb="$(free_avail_mb "$path")"
  echo "cell free space: ${avail_mb} MiB — floor: ${floor_mb} MiB (path: $path)"
  if [ "$avail_mb" -lt "$floor_mb" ]; then
    echo "::error::cell disk under floor — ${avail_mb} MiB free < ${floor_mb} MiB floor — refuse mint (burst admission control, issue #478; prune the cell's transient burst trees, never the ~58G baseline)" >&2
    exit 1
  fi
  echo "admit: free space ${avail_mb} MiB ≥ floor ${floor_mb} MiB — mint may proceed"
}

cmd_rotate() {
  local archive="${CELL_DISK_GUARD_ARCHIVE:-$CELL_DISK_GUARD_ARCHIVE_DEFAULT}"
  local keep="${CELL_DISK_GUARD_KEEP:-$CELL_DISK_GUARD_KEEP_DEFAULT}"
  local age_days="${CELL_DISK_GUARD_MAX_AGE_DAYS:-$CELL_DISK_GUARD_MAX_AGE_DAYS_DEFAULT}"
  local dry_run=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --archive) archive="$2"; shift 2 ;;
      --keep) keep="$2"; shift 2 ;;
      --max-age-days) age_days="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) echo "cell-disk-guard rotate: unknown arg $1" >&2; usage ;;
    esac
  done
  case "$keep" in ''|*[!0-9]*) echo "cell-disk-guard rotate: --keep must be a non-negative integer: $keep" >&2; exit 2 ;; esac
  case "$age_days" in ''|*[!0-9]*) echo "cell-disk-guard rotate: --max-age-days must be a non-negative integer: $age_days" >&2; exit 2 ;; esac
  [ -n "$archive" ] || { echo "cell-disk-guard rotate: empty --archive" >&2; exit 2; }
  [ "$archive" != "/" ] || { echo "cell-disk-guard rotate: refusing to operate on /" >&2; exit 2; }
  if [ ! -d "$archive" ]; then
    echo "diag-archive: no archive dir at $archive — nothing to rotate"
    exit 0
  fi
  # BELT: never operate on a live minted runner body (template/mint layout)
  if [ -f "$archive/run.sh" ] && [ -f "$archive/config.sh" ]; then
    echo "cell-disk-guard rotate: $archive looks like a minted runner body (run.sh + config.sh at its root), not a diag archive — refusing" >&2
    exit 2
  fi

  # Candidates = entries beyond the newest KEEP (ls -t, newest first) UNION
  # entries older than MAX_AGE_DAYS (find -mtime +D is strictly older than
  # D whole days). Union + dedupe: an entry both stale and over-keep is
  # counted and removed exactly once.
  local over_keep="" stale="" cands=""
  over_keep="$(ls -1t "$archive" 2>/dev/null | tail -n +$((keep + 1)) || true)"
  stale="$(cd "$archive" && find . -mindepth 1 -maxdepth 1 -mtime +"$age_days" -print 2>/dev/null | sed 's|^\./||' || true)"
  cands="$(printf '%s\n%s\n' "$over_keep" "$stale" | sort -u | sed '/^$/d')"

  local before_kb after_kb total=0 removed=0 blocked=0 name
  before_kb="$(du -sk "$archive" 2>/dev/null | awk '{print $1}')"
  if [ -z "$cands" ]; then
    echo "diag-archive: $archive within budget (keep: $keep, max-age: ${age_days}d) — nothing to remove"
    exit 0
  fi
  total="$(printf '%s\n' "$cands" | wc -l | tr -d ' ')"
  if [ "$dry_run" -eq 1 ]; then
    echo "diag-archive dry-run: would remove $total of $(ls -1 "$archive" | wc -l | tr -d ' ') entries (keep: $keep, max-age: ${age_days}d):"
    printf '%s\n' "$cands" | head -10 | sed 's/^/  would remove: /'
    exit 0
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    rm -rf -- "${archive:?}/$name" 2>/dev/null || true
    if [ -e "${archive:?}/$name" ]; then
      # root-owned reap chown (the spawner's `chown -R root:root`) needs
      # escalation; -n keeps it non-interactive — a missing/failed sudo is a
      # BLOCKED entry, never a hang and never a silent skip
      "${CELL_DISK_GUARD_SUDO:-sudo}" -n rm -rf -- "${archive:?}/$name" 2>/dev/null || true
    fi
    if [ -e "${archive:?}/$name" ]; then
      blocked=$((blocked + 1))
      echo "diag-archive: BLOCKED — could not remove $name (root-owned? deploy the root schedule — see: cell-disk-guard.sh schedule)" >&2
    else
      removed=$((removed + 1))
    fi
  done <<EOF
$cands
EOF
  after_kb="$(du -sk "$archive" 2>/dev/null | awk '{print $1}')"
  echo "diag-archive: removed $removed of $total candidates (freed ~$(( (before_kb - after_kb) / 1024 )) MiB) — blocked: $blocked, remaining: $(ls -1 "$archive" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$blocked" -gt 0 ]; then
    echo "::error::diag-archive rotation incomplete — $blocked entries could not be removed; rotation is not landing (issue #478)" >&2
    exit 1
  fi
}

cmd_schedule() {
  cat <<'EOF'
# Root-side rotation schedule for the diag archive (issue #478): the
# spawner's reap chowns _diag-archive to root:root, so the canonical
# rotation runs as root on the box. Deploy this script beside the
# lane-supervisor (FleetTower scripts/2o/lane-supervisor.ts deploy home)
# and adjust ExecStart's path to the deployed copy.

# /etc/systemd/system/cell-disk-guard.service
[Unit]
Description=dsh cell diag-archive rotation (issue ebowwa/dsh-agent-toolkit#478)

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash /root/lane-supervisor/cell-disk-guard.sh rotate

# /etc/systemd/system/cell-disk-guard.timer
[Unit]
Description=rotate the dsh cell diag archive every 4 hours

[Timer]
OnCalendar=*-*-* 00/4:00:00
Persistent=true

[Install]
WantedBy=timers.target

# enable: systemctl daemon-reload && systemctl enable --now cell-disk-guard.timer
# crontab fallback (root):
# 15 */4 * * * /usr/bin/env bash /root/lane-supervisor/cell-disk-guard.sh rotate >> /var/log/cell-disk-guard.log 2>&1
EOF
}

case "${1:-}" in
  admit) shift; cmd_admit "$@" ;;
  rotate) shift; cmd_rotate "$@" ;;
  schedule) cmd_schedule ;;
  -h|--help|'') usage ;;
  *) echo "cell-disk-guard: unknown subcommand $1" >&2; usage ;;
esac
