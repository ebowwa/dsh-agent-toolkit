# Agent contract (`.agents/`)

The standing instructions every dsh lane agent inherits while working this
fleet. Enforcement is prompt assembly: `scripts/run-dsh-agent.sh` stamps
the standing contracts below into EVERY task it builds — dispatched worker
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

## Standing contract: issue relationships (issue #115)

Owner decision 2026-09-26: agents must use GitHub issue Relationships.
Every ticket an agent files carries its relationships; a filed ticket
whose GraphQL read shows no edges is a contract violation.

### Verified API (GraphQL only)

REST endpoints 404 — GraphQL only. Reads on Issue: `relatesTo`, `blockedBy`, `blocking`, `subIssues`, plus `parent` for a sub-issue.
Mutations take issue NODE IDs, not numbers. Resolve one first:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}' \
  -f o=OWNER -f r=REPO -F n=NUMBER --jq .data.repository.issue.id
```

| Mutation | Input (verified schema shape) | Edge |
|---|---|---|
| `addSubIssue` | `issueId: ID!`, `subIssueId: ID` **or** `subIssueUrl: String`, `replaceParent: Boolean` | parent → sub-issue |
| `addBlockedBy` | `issueId: ID!`, `blockingIssueId: ID!` | issue blocked by blocker |
| `addRelatesTo` | `issueId: ID!`, `relatedIssueId: ID!` | relates-to |
| `removeSubIssue` / `removeBlockedBy` / `removeRelatesTo` | same ids | undo |
| `reprioritizeSubIssue` | a parent's sub-issue ordering | ordering |

Receipts 2026-09-26 (this repo, scratch issues #116/#117, both closed):
`addSubIssue(input:{issueId:<116 id>, subIssueUrl:#117-url})`,
`addBlockedBy(input:{issueId:<117 id>, blockingIssueId:<116 id>})`,
`addRelatesTo(input:{issueId:<117 id>, relatedIssueId:<116 id>})` — the
GraphQL read of #117 returned `parent.number=116`, `blockedBy=[116]`,
`relatesTo=[116]`.

Boundary (verified live on PR #120, both input positions): the
relationships mutations resolve Issue nodes only — a PR id is rejected
(`Could not resolve to Issue node`). A pull request carries its edge as
its closing reference in the body (`Closes #N`); the relationship rules
above apply to ISSUES an agent files.

### The linking rules

1. **PART TICKETS** (issue #114 decomposition): file each part as a
   **sub-issue** of the parent claim issue
   (`addSubIssue(input:{issueId:<parent id>, subIssueUrl:<part issue URL>})`);
   when the sequence matters, chain
   `addBlockedBy(input:{issueId:<later id>, blockingIssueId:<earlier id>})`
   — B blocked by A.
2. **DISCOVERIES** (issue #113 `found:` tickets): `addRelatesTo` the
   issue/claim where you observed the finding —
   `addRelatesTo(input:{issueId:<found id>, relatedIssueId:<source id>})`.
3. **REDOS / follow-ons**: any redo or continuation ticket
   `addRelatesTo` its predecessor —
   `addRelatesTo(input:{issueId:<redo id>, relatedIssueId:<predecessor id>})`.
4. **EXIT SUMMARY**: the parts table gains a **relationship column** —
   every filed ticket lists its parent/edges (`sub-issue of #N`,
   `blocked by #M`, `relatesTo #K`). Verifiable: a GraphQL read of the
   ticket returns exactly those edges.

The prompt assembly stamps this contract into every task it builds too
(structural + behavioral pins: `tests/relationships-contract.test.mjs`).

### Tower-side note (cross-repo, factory#60 adjacency)

The tower's mechanical "Redo at current main" issues (FleetTower) ship
orphaned too — the same linking belongs in the redo machinery. Noted for
the factory#60 work or a follow-up; out of scope for this repo's
implementation.

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
- `tests/agent-contract.test.mjs` — pins the discovery-protocol driver
  block, its unconditional placement in prompt assembly, and the
  exit-summary shape.
- `tests/relationships-contract.test.mjs` — pins the issue-relationships
  driver block (placement + the three verified mutation shapes) and keeps
  this doc in agreement with it.
