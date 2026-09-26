# Contributing

This repo is a **dsh fleet target** — dispatched tower agents and human
collaborators work here in parallel. The task contract's COMMUNICATE step
points at THIS file for the milestone beats; until it existed here, that
pointer dangled and dispatched agents worked this repo silent (tower
lifecycle pings only — measured 2026-09-22). This copy is this repo's
single source for agent communication conduct; the fleet-wide upstream
lives in ebowwa/factory's CONTRIBUTING.md.

## Communication during work (the thread is a message board)

An agent working on a ticket is **not a black box**.

**Running commentary — the default cadence.** Post as you go: what you
are reading, what surprised you, hypotheses as they form, decisions and
why, dead ends you backed out of. Several short posts an hour beat one
summary at the end; if ~10 minutes of active work produced no post, say
what you are doing. Between posts, check for new comments from humans on
your thread and answer them — a message board is a conversation, not a
broadcast.

**Anchor beats — always present in the stream:**
1. **STARTING** — one line: what you're about to do and the plan
2. **FOUND IT** — one line: what the defect actually is, with the evidence (file:line or command output)
3. **IMPLEMENTING** — one line: the approach you're taking
4. **TESTING** — one line: what you're verifying and how
5. **BLOCKED** — when stuck longer than ~10 minutes: what is blocking you and what you already tried (a blocked agent that speaks can be helped; a silent one just burns the clock)
6. **SHIPPING** — the PR link plus a 3-line summary: what changed, where it landed, the evidence it works; when the discovery protocol below fired, the summary carries the `filed-followups:` line; when the session leaves remote branches behind (open PRs waiting on review), it also carries the `branches-left:` line (issue #127 — zero-orphan branch hygiene)

Use `gh issue comment N --repo R --body "..."` (the scrub shims protect
you). A thread that goes silent for 30+ minutes is a thread where
the agent died and nobody noticed.

## Discovery protocol (file what you notice, never silently scope-creep)

Working a claim is not a bubble: you are the only witness to the
out-of-scope bugs, gaps, and risks you walk past (issue #113). While
working a claim, if you observe one:

1. **File an issue** in the repo where you observed it — title prefix
   `found:`, body carrying receipts (file:line, command output, the claim
   you were working).
2. **Label it** with the todo label that repo uses (`agent-todo` where it
   exists; the closest todo label otherwise — say which you used).
3. **Reference it in the exit summary** — every filed issue number goes on
   ONE `filed-followups:` line (exact shape `filed-followups: #114, #115`;
   filed nothing — omit the line entirely, never write
   `filed-followups: none`).
4. **Do NOT fix it in the current claim** — that is scope-creep — unless
   it is trivial AND in-scope. The claim's diff stays on-task; PRs are
   task work-products, not discoveries.

The driver stamps this contract into every task it assembles
(`scripts/run-dsh-agent.sh`), so every lane agent inherits it; the
reference text lives in [.agents/README.md](.agents/README.md) and the
exit-summary shape is pinned by `tests/agent-contract.test.mjs`.

Repo conventions (gates, layers, toolchain) live in this repo's own
CLAUDE.md / README — this file owns only the communication conduct above.
