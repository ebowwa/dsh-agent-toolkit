# Fleet repo priority

Owner-set order for the maintenance lanes (2026-09-21). The lanes pick the
highest-priority open `agent-todo` issue across these repos. A repo not
covered here is out of scope unless the current task or issue names it
explicitly. This file is authoritative over the inline summary shipped in
`run-dsh-agent.sh` and the dispatch workflow fallback.

## Tier 1 — fleet-infra (the repos that drive the fleet)

Work these first; an open issue here outranks any tier-2 issue.

| Repo | Role |
|---|---|
| ebowwa/dsh-agent-toolkit | driver + dispatch workflows (`run-dsh-agent.sh`) |
| ebowwa/FleetTower | dispatch tower — tick loops, claims ledger, doctors |
| ebowwa/factory | dispatch engine + work surface of the dsh fleet |
| ebowwa/github-activity-tracker | activity tracking, autoscale, runner oversight |
| ebowwa/GitActionsRunner | self-hosted Actions runner management (mini) |
| ebowwa/deepseek-harness | the dsh engine mirror; format and type rules live here |

## Tier 2 — products (default tier for every other ebowwa-owned repo)

secondsee (smart glasses) · distribution-store (SecondSee storefront) ·
gauge · reflex · HelloMacOScreator · HelloSwiftConsumables ·
HelloPrimitives · HelloWorlds · HelloHardwareResearch · ANE · Cleanshots ·
diytoybricks.com · Open-Alterego-Private · Open-Alterego ·
contract-site-surveys · mcwire · air-terminal · hero-spatial-orbital-scene ·
repo-ontology · codegen-kit · oauth.sites.com · HelloNodeSetups ·
esp32s3-cam-firmware · xiao-nrf52-sense-ble · Gia · PrintPeer · submitops ·
openhardwareai · ebowwa (profile repo)

Any ebowwa-owned repo not listed anywhere lands in this tier by default.

## Tier 3 — named / fleet-proposed

- A repository the owner names in a task or issue: in scope for that task
  only.
- Fleet-proposed: an agent may PROPOSE a repo for this tier by filing an
  issue on ebowwa/dsh-agent-toolkit. It may NOT be worked until the owner
  adds it here.
- Entries: (none yet)

## Forks

Mirror forks (deepseek-harness, cordis, bun, ai-toolkit, origins) follow
their upstream rules — no autonomous PRs against upstreams from fork
checkouts.

## Hard boundary

NEVER fork, pull-request, comment in, or deploy from any repository owned by
another account, no matter what labels it carries. `agent-todo` and similar
labels are shared conventions, not work requests for this fleet.
