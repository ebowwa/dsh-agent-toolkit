# Agent contract (`.agents/`)

The standing instructions every dsh lane agent inherits while working this
fleet. Enforcement is prompt assembly: `scripts/run-dsh-agent.sh` stamps
the standing contract below into EVERY task it builds — dispatched worker
tasks and legacy CI comment jobs alike — so an agent cannot work a claim
without reading it. This file is the reference text; the skills in
`skills/` carry the workflows that ride on top of it.

## Standing contract: the discovery protocol

**File what you notice, never silently scope-creep.** While working a
claim, if you observe a bug, gap, or risk OUTSIDE the claim scope:

1. **File an issue** in the repo where you observed it — title prefix
   `found:`, body carrying receipts: file:line, command output, and the
   claim you were working.
2. **Label it** with the todo label that repo uses (`agent-todo` where it
   exists; the closest todo label otherwise — say which you used).
3. **Reference it in the exit summary.** Every filed issue number goes on
   ONE `filed-followups:` line, exact shape:

   ```
   filed-followups: #114, #115
   ```

   comma-space separated issue refs, nothing else on the line. Filed
   nothing: omit the line entirely — never write `filed-followups: none`;
   absence is the machine-checkable signal that the diff carries no
   followups.
4. **Never fix it in the current claim** — that is scope-creep — unless
   the fix is trivial AND in-scope. The claim diff stays on-task; PRs are
   task work-products, not discoveries.

## Why this exists

Verified 2026-09-26 (dsh-agent-toolkit#113): lane agents observed
out-of-scope problems and stayed silent, because no instruction anywhere
in the standing contract asked for more — the only self-generated issues
were the tower mechanical loop, and PRs carried task work only.
Out-of-scope problems noticed mid-claim were either lost with the
discarded checkout or smuggled into the diff as silent scope-creep; the
protocol turns the first into a durable, labeled receipt and forbids the
second.

## Related

- [`skills/decompose-by-capability/`](skills/decompose-by-capability/SKILL.md)
  — plan the claim's PARTS and route each to the machine class that can
  run it (issue #114, the agent-side mirror of the factory#60 placement
  law); parts this cell cannot run are filed as self-contained tickets
  through this contract's filing mechanism.
- [`skills/verify-before-dismissal/`](skills/verify-before-dismissal/SKILL.md)
  — search prior session history before declaring a limitation.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — the communication conduct:
  milestone beats on the ticket thread (the discovery protocol rides the
  SHIPPING beat's summary through the `filed-followups:` line).
- `tests/agent-contract.test.mjs` — pins the driver block, its
  unconditional placement in prompt assembly, and the exit-summary shape.
