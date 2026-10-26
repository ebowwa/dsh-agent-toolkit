# The `dsh` runner pool — inventory, receipts, provisioning runbook

Every self-hosted runner carrying the `dsh` label in this repo. Ten of
this repo's thirteen workflows declare `runs-on: [self-hosted, dsh]`;
the required check is not one of them any more — `gates.yml` moved to
its own dedicated `gates` cell (issue #686, below), so this pool no
longer decides merge latency by itself.

## The pool

| runner | host machine | os / arch | notes |
|---|---|---|---|
| `seed-dshbot` | seed-dsh-prod | Linux / X64, 2 cores | the original runner; the same 2-core box also runs 4–6 concurrent `run-dsh-agent.sh` lanes |
| `relay-dsh` | caringmind-relay (VPS) | Linux / X64, 2 cores, idle | added by issue #685 for gates starvation; the box runs no agent lanes |

Verify live at any time:

```
gh api repos/ebowwa/dsh-agent-toolkit/actions/runners \
  --jq '.runners[] | {id, name, os, status, labels: [.labels[].name]}'
```

Two `dsh`-labeled runners on **distinct machines** is the standing pool
contract (issue #685): GitHub hands a `dsh` job to whichever matching
runner is idle, so a box that is drowning in lane load only sheds a job
if another machine can take it.

## The dedicated `gates` cell (issue #686)

`gates.yml` — the one check whose latency blocks every merge — does not
run in this pool. It schedules on a runner that carries the `gates`
label and NO `dsh` label:

| runner | host machine | os / arch | notes |
|---|---|---|---|
| `relay-gates` | the relay VPS | Linux / X64, idle | registered for issue #686 (2026-10-25); runs no agent lanes |

Measured at registration: 4 cores, ~6.3 GB free RAM, 64 GB free disk,
load ~0 — the ~15 quiet minutes issue #684 measured the suite needing
are a scheduling fact, not a hope. Provisioning followed the runbook
below (registration token over stdin, dedicated directory, systemd unit
`actions.runner.ebowwa-dsh-agent-toolkit.relay-gates.service`, the
runner-owned node bundle wired through `.path`), with one deliberate
difference: `--labels gates` — and **never also `dsh`**, or lane work
follows the required check straight back onto the cell.

The ordering here is load-bearing and the reason the label and the flip
are ONE ticket: the `runs-on` flip landed only AFTER the labeled runner
was online and idle. A flip naming a label that no runner carries parks
every merge forever — strictly worse than the starvation it replaces.
Revert guard: `tests/gates-merge-authority.test.mjs` goes red if
`gates.yml` silently moves back to `[self-hosted, dsh]`.

## Why the second runner exists (measured)

Four consecutive `gates` runs on one head sha (63f0f50, PR #683) were all
`cancelled` at the 20-minute job budget with **zero failing tests** — the
Unit tests step was still emitting passing subtests — while load1 on
seed-dsh-prod sampled 33–40 during the failures and never fell below 24.9
across the window (issue #684). The suite needs ~15 quiet minutes; the
seed runner is free whenever GitHub asks, but the *box* is saturated, so
the pool kept handing `gates` to a starved host. A cancelled required
check blocks every merge (the merge guard refuses). `gates.yml`'s
timeout-minutes bump (issue #680) treats the symptom; the second runner
on idle hardware treats the cause.

## Why the second runner is Linux on the relay VPS, not a mac box

A `dsh`-labeled runner takes the required `gates` check, so a pool member
that cannot pass the suite is a live liability: a gates run landing there
reads as a real failure and blocks merges — an unactionable infra red
(the #474 class). Measured on macos-m1-16gb-air (8-core M1, node
v22.23.4, plugin smoke deps green, 2026-10-25): the full unit suite fails
**37 of 892** tests (`# pass 846 / # fail 37 / # skipped 9`) — every
failure in the driver/wrapper suites that exec the lane shell scripts
(`run-dsh-agent.sh` stub-agent launches, doppler launch isolation, curl
shims). Those scripts assume the Linux toolchain (doppler, `gh`, modern
bash). Until the driver suites are darwin-clean, a mac box must NOT carry
the `dsh` label; the box itself is healthy — the label is the wrong fit.

## Provisioning runbook (what actually worked)

1. **Registration token** (repo admin):
   `gh api repos/ebowwa/dsh-agent-toolkit/actions/runners/registration-token --method POST --jq .token`
   — single-use, short-lived; mint it fresh for each `config.sh`.
2. **Runner binary**: `actions/runner` latest release
   (`linux-x64` / `osx-arm64` tarball), extracted to a dedicated directory
   (`/opt/actions-runner-dsh` on the relay VPS; never share a directory
   with another repo's runner — the secondsee runner lives at its own
   path on the same box).
3. **Register** with the `dsh` label; pass the token over **stdin**, not
   argv (it must not land in shell history or process lists):
   ```
   ./config.sh --unattended --url https://github.com/ebowwa/dsh-agent-toolkit \
     --token "$(cat)" --name <host>-dsh --labels dsh --work _work
   ```
4. **Toolchain**: node v22 LTS (seed-dshbot runs v22.22.3 — match the
   major), on PATH for the *service* environment. On the relay VPS node
   already lived at `/usr/local/bin`; on a mac, ship a user-space tarball
   and wire it through the runner's `.path` file (one directory per line;
   each is prepended to the job PATH — do NOT write a whole `PATH=` into
   `.env`, which can clobber the runner's own injected paths).
5. **Service**: `./svc.sh install && ./svc.sh start` — a systemd system
   service on Linux (`actions.runner.ebowwa-dsh-agent-toolkit.<name>.service`),
   a launchd agent on macOS. Verify the job is actually listening:
   `grep "Listening for Jobs" ~/actions-runner/_diag/*.log` (or the
   install dir's `_diag`), then the `gh api` read above. **Two traps that
   cost the first relay-dsh job (2026-10-25):** the Linux unit is
   generated with an EMPTY `User=` — a root-running runner refuses to run
   at all ("Must not run with sudo"), and after you fix `User=<owner>` in
   the unit + `daemon-reload` + restart, the seconds the root instance
   lived may have left a ROOT-OWNED `_work/` behind: the first job then
   instant-fails (zero steps, ~2s) with
   `UnauthorizedAccessException: Access to the path '<dir>/_work/_tool'
   is denied`. Check `ls -la` on `_work` and `chown -R` before trusting
   the first green.
6. **Pre-verify the suite BEFORE trusting the box with the required
   check** — clone the repo on the target box and run the exact gates
   steps (the `node --check` loop over `scripts/`, `node
   scripts/workflow-lint.mjs .github/workflows/*.yml`, `node
   scripts/install-plugin-smoke-deps.mjs`, then `node --test`). The air16
   measurement above is what this step is for: registration succeeds in
   seconds; a red required check is what costs days.
7. **De-register** a runner that must leave the pool:
   `gh api -X DELETE repos/ebowwa/dsh-agent-toolkit/actions/runners/<id>`
   (repo admin), or `./config.sh remove --token <removal-token>` from the
   runner directory.

Runner names follow `<host>-dsh` (host first, role second) — `relay-dsh`
on caringmind-relay, `seed-dshbot` being the historical name on
seed-dsh-prod. The dedicated cell breaks the pattern on purpose:
`relay-gates` names the label it carries, because the label IS the
contract (issue #686).
