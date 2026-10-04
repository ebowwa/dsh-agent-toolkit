# Fleet manifest — standing node registry + placement law

The STANDING fleet context every dispatched agent plans against (issue
#114). The driver injects this file into the task prompt; a caller with a
live view of the pool overrides/extends it through `DSH_FLEET_MANIFEST`
(live resource summary — free seats, disk/ram/token budget — is runtime
data and never baked into this file). This file is authoritative over the
inline summary the driver carries; owner-edit it when the pool changes.

Last aligned with the tower registry (FleetTower `fleet.manifest.json`)
2026-10-04; the factory#60 receipts: 2026-09-26. Drift is fenced:
`scripts/fleet-manifest-drift.mjs` (a gates step) diffs this table's node
ids against the tower registry, so a pool change without this file
following fails loud instead of mis-placing work.

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

## Node registry

| Nodes | OS | Lanes served | Notes |
|---|---|---|---|
| mini-L1 | macOS | mac (native toolchain) | mac-native parts MUST land here |
| mini-L2 | macOS | big (heavy compute) | heavy-compute parts; macOS still binds per the law |
| mini-L3 | macOS | open (cheap cells) | a mac box that is never NAMED linux — lane name is not OS (the factory#60 receipt) |
| mini-L4 | macOS | open (default) | neutral/default parts on mac |
| seed-L3 | Linux | linux (cheap cells) | the only Linux node today — the only legal target for linux-native parts |
| air16-native-open | macOS | open (pull-only) | MacBook Air m1 16gb — pull-only enrollment (no ssh route from seed; heartbeat truth); carried ~half of 2026-10-04's claim rows |
| air8-native-open | macOS | open | MacBook Air m1 8gb — fresh enrollment 2026-10-01 |
| m1-8gb-air-open | macOS | open (MLX-capable) | MLX-capable cell on m1-8gb-air — enrolled via Gauge Fleet Control per gauge#47 |

All four mini lane homes live on one macOS box (m1mini16gb), so a
linux-lane whole-claim could land on macOS with no legal node to run it —
that is the factory#60 receipt this law closes. macOS nodes never run
linux-native parts, and Linux nodes never run mac-native parts — a lane
filter alone does not make a placement legal.

Beyond the mini box: seed-L3 lives on seed-node-prod (Linux), and two
pull-only MacBook Air machines serve the open lane —
macos-m1-16gb-air.local (air16-native-open) and macos-m1-8gb-air.local
(air8-native-open + m1-8gb-air-open). They carry no ssh route from seed:
enrollment and liveness flow through the tower registry's heartbeat truth
only, so their rows above are the whole planning picture.
