# Agent contract docs (.agents/)

This directory is the agent-contract home for dispatched fleet agents
working this repo: the standing protocols a claim inherits with its
checkout. The prompt assembly (`scripts/run-dsh-agent.sh`) appends the
issue-relationships block (below) to every task it launches; this file is
the block's long-form reference and the receipts store for anything the
block asserts.

| Doc | Contract |
|---|---|
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Communication conduct: the thread is a message board (STARTING / FOUND IT / IMPLEMENTING / TESTING / BLOCKED / SHIPPING beats) |
| [skills/verify-before-dismissal/](skills/verify-before-dismissal/SKILL.md) | Search the prior-session corpus in the claim's own words before writing a dismissal |
| This file, below | Issue relationships: every ticket an agent files carries its graph edges (issue #115) |

Sibling contracts this one links to (owned by their own issues, not
duplicated here): the discovery protocol (issue #113 — file `found:`
tickets for out-of-scope findings instead of scope-creeping) and the
decomposition protocol (issue #114 — plan parts, route each to the fleet
machines that can run it, file the rest as self-contained tickets).

## Issue relationships (issue #115) — no orphaned tickets

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

The prompt assembly carries this block (structural + behavioral pins:
`tests/relationships-contract.test.mjs`).

### Tower-side note (cross-repo, factory#60 adjacency)

The tower's mechanical "Redo at current main" issues (FleetTower) ship
orphaned too — the same linking belongs in the redo machinery. Noted for
the factory#60 work or a follow-up; out of scope for this repo's
implementation.
