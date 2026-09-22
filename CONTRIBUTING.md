# Contributing

This repo is a **dsh fleet target** — dispatched tower agents and human
collaborators work here in parallel. The task contract's COMMUNICATE step
points at THIS file for the milestone beats; until it existed here, that
pointer dangled and dispatched agents worked this repo silent (tower
lifecycle pings only — measured 2026-09-22). This copy is this repo's
single source for agent communication conduct; the fleet-wide upstream
lives in ebowwa/factory's CONTRIBUTING.md.

## Communication during work (no silent agents)

An agent working on a ticket is **not a black box**.

Post ONE progress comment on the target issue/PR thread at each beat:
1. **STARTING** — one line: what you're about to do and the plan
2. **FOUND IT** — one line: what the defect actually is, with the evidence (file:line or command output)
3. **IMPLEMENTING** — one line: the approach you're taking
4. **TESTING** — one line: what you're verifying and how
5. **BLOCKED** — when stuck longer than ~10 minutes: what is blocking you and what you already tried (a blocked agent that speaks can be helped; a silent one just burns the clock)
6. **SHIPPING** — the PR link plus a 3-line summary: what changed, where it landed, the evidence it works

Use `gh issue comment N --repo R --body "..."` (the scrub shims protect
you). Beats 1-5 are one line each — no essays, just signal; only SHIPPING
gets three. A thread that goes silent for 30+ minutes is a thread where
the agent died and nobody noticed.

Repo conventions (gates, layers, toolchain) live in this repo's own
CLAUDE.md / README — this file owns only the communication conduct above.
