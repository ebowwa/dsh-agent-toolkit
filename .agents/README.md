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

## Standing contract: branch hygiene (issue #127)

**Zero orphan branches.** A branch whose work outlives the session without
a PR is a lost thread — nothing reviews it, nothing merges it, and the next
survey agent files it as mess (HYGIENE.md measured exactly this: gat's
16-branch `dsh/*` pile was "the single biggest messiness item in either
repo"). The repos run auto-delete-on-merge (already live everywhere;
verified on this repo: `delete_branch_on_merge=true`), so a **merged**
branch cleans itself up. The contract closes the two leak paths the
setting cannot reach:

1. **SAME-SESSION PR PER BRANCH** — every branch your work lands on gets
   its PR opened in the same session that pushed it. If your lane ships
   for you (the deterministic shipper opens the PRs), confirm the PR
   exists before you exit; if you push yourself, you create the PR. A
   pushed branch with no PR is an orphan.
2. **DELETE ON CLOSE WITHOUT MERGE** — when a PR of yours closes without
   merging (superseded, wrong approach, duplicate), delete its branch in
   the same breath (`gh pr close NUMBER --delete-branch`; fallback
   `git push origin --delete BRANCH`). Merged branches are auto-deleted by
   the repo setting — never restore one.
3. **BRANCHES-LEFT EXIT LINE** — reference every remote branch your session
   leaves behind (open PRs waiting on review) on ONE `branches-left:` line,
   exact shape:

   ```
   branches-left: dsh/issue-127-c5844082078, dsh/issue-128-nextticket
   ```

   comma-space separated branch names, nothing else on the line. Left
   nothing: omit the line entirely — never write `branches-left: none`;
   absence is the machine-checkable signal that the session left no
   branches behind.

**Acceptance — zero orphans:** at exit, every branch the session pushed is
in exactly one of three states — merged (auto-deleted by the repo setting),
deleted, or declared on the `branches-left:` line behind its open PR. A
pushed branch in none of them is a contract violation.

The prompt assembly stamps this contract into every task it builds too
(structural + behavioral pins: `tests/branch-hygiene-contract.test.mjs`).

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
- `tests/branch-hygiene-contract.test.mjs` — pins the branch-hygiene driver
  block (placement + the two leak-path rules + the acceptance sentence) and
  the `branches-left:` exit-summary shape.
