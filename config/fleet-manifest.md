# Fleet manifest — standing node registry + placement law

The STANDING fleet context every dispatched agent plans against (issue
#114). The driver injects this file into the task prompt; a caller with a
live view of the pool overrides/extends it through `DSH_FLEET_MANIFEST`
(live resource summary — free seats, disk/ram/token budget — is runtime
data and never baked into this file). This file is authoritative over the
inline summary the driver carries; owner-edit it when the pool changes.

Last aligned with the tower registry (FleetTower `fleet.manifest.json`)
and the factory#60 receipts: 2026-10-04 (the air machines, issue #397).
`scripts/fleet-manifest-drift.mjs` (CI:
`.github/workflows/fleet-manifest-drift.yml`) diffs the node table below
against the live tower registry — a stale copy fails loud instead of
mis-placing work.

## The placement law (factory#60 — the agent-side mirror)

- `mac-native` (swift / ios / macos-native) → mac lane, **macOS nodes ONLY**
- `linux-native` (systemd, deploys, shell, kernel) → linux lane, **Linux
  nodes ONLY** — the lane alone never satisfies an OS constraint
- `language-default` (tsx / ts / python) → linux lane BY DEFAULT; a
  macRepos-trait repo (ANE) keeps mac — **trait beats language**
- `neutral` (docs, config, reviews, triage) → open lane, any OS
- `heavy-compute` → big lane only

When more than one node can serve a part, prefer by live availability
(free pool seats, disk/ram/token budget). A node claiming N running agents
while fewer real processes exist (**ghost seats** — seed-L3, 2026-09-26: 8
phantoms) is INELIGIBLE until healed; never route onto a phantom-full
node. A dispatch/placement that cannot name its node + reason
(os-affinity | resource-preference | shared) is not a placement.

**Wrong-OS installs do not fail loudly under bun (issue #190).** npm
hard-errors a platform-mismatched MANDATORY dep (`notsup Unsupported
platform`); bun — the dep-cache default (issue #189) — silently OMITS it
with a zero exit (live repro: fsevents ^2 darwin-only on linux, bun
1.3.14 AND 1.4.2: 0 entries, no warning, exit 0). The failure model an
OS-affinity derivation must plan for is therefore **silent absence →
runtime missing-binary**, never an install-time hard-fail: a green
install proves nothing about platform coverage. The dep-cache audit names
the silently skipped mandatory deps on every restore; an OS-gated dep a
wrong-OS leg must survive belongs in `optionalDependencies`, and a leg
that NEEDS the loud failure runs `DSH_DEP_INSTALL_CMD="npm ci"`.

## Node registry

| Nodes | OS | Lanes served | Notes |
|---|---|---|---|
| mini-L1 | macOS | mac (native toolchain) | mac-native parts MUST land here |
| mini-L2 | macOS | big (heavy compute) | heavy-compute parts; macOS still binds per the law |
| mini-L3 | macOS | open (cheap cells) | a mac box that is never NAMED linux — lane name is not OS (the factory#60 receipt) |
| mini-L4 | macOS | open (default) | neutral/default parts on mac |
| seed-L3 | Linux | linux (cheap cells) | the only Linux node today — the only legal target for linux-native parts |
| air16-native-open | macOS | open | MacBook Air m1 16gb — pull-only (no ssh route from seed; heartbeat truth) |
| air8-native-open | macOS | open | MacBook Air m1 8gb — fresh enrollment 2026-10-01 |
| m1-8gb-air-open | macOS | open | MacBook Air m1 8gb — MLX-capable; enrolled via Gauge Fleet Control per gauge#47 |

All four mini lane homes live on one macOS box (m1mini16gb), so a
linux-lane whole-claim could land on macOS with no legal node to run it —
that is the factory#60 receipt this law closes. macOS nodes never run
linux-native parts, and Linux nodes never run mac-native parts — a lane
filter alone does not make a placement legal.

The three air nodes live on two further macOS boxes:
`air16-native-open` on macos-m1-16gb-air.local, and `air8-native-open` +
`m1-8gb-air-open` (the MLX-capable trait node) on macos-m1-8gb-air.local.
Both machines enrolled pull-only (no ssh route from seed; heartbeat
truth), so their live seat/disk picture reaches a dispatch only through
the `DSH_FLEET_MANIFEST` snapshot — plan against this file for the
placement law, never for live seat counts.
