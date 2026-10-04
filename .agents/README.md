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

1. **Search before you file** (issue #320): run `gh search issues
   --repo <repo> --label agent-todo --state open` and check whether an
   open ticket already carries the file/line you are about to cite. If
   one does, add your receipts as a comment on THAT ticket — never
   mint a duplicate (receipt: sibling finds 95s apart, #309/#311).
2. **File an issue** in the repo where you observed it — title prefix
   `found:`, body carrying receipts: file:line, command output, and the
   claim you were working.
3. **Label it** with the todo label that repo uses (`agent-todo` where it
   exists; the closest todo label otherwise — say which you used).
4. **Reference it in the exit summary.** Every filed issue number goes on
   ONE `filed-followups:` line, exact shape:

   ```
   filed-followups: #114, #115
   ```

   comma-space separated issue refs, nothing else on the line. Filed
   nothing: omit the line entirely — never write `filed-followups: none`;
   absence is the machine-checkable signal that the diff carries no
   followups.
5. **Never fix it in the current claim** — that is scope-creep — unless
   the fix is trivial AND in-scope. The claim diff stays on-task; PRs are
   task work-products, not discoveries.
6. **Stamp the chain/sweep milestone** (issue #185): when the `found:`
   ticket belongs to a chain or sweep, the FILER sets that chain's
   milestone on it — creating the milestone if absent (name = the chain's
   anchor, e.g. `citation-sweep` or the root defect key). One call, part
   of the file step:

   ```bash
   gh issue edit N --repo R --milestone "chain-anchor"
   ```

   Siblings inherit the same milestone from then on; the milestone's
   open/closed counts are the owner-visible chain progress bar.

## Standing contract: chain/sweep milestones (issue #185)

Coordination state must not live only in flat labels and threads. Every
chain or sweep files under a GitHub **milestone** named for its anchor
(the sweep key or root defect):

1. **Filer stamps** — a newly filed ticket that belongs to a chain/sweep
   carries that milestone; absent, the filer creates it (same anchor
   name). One `gh issue edit N --repo R --milestone "anchor"` call, part
   of the file step (checklist item 6 of the discovery protocol above).
2. **Ship carries** — a shipped PR carries the closing ticket's
   milestone (`gh pr edit N --repo R --milestone "anchor"`), so the PR
   list renders chain progress and the milestone closes out with the
   chain. `scripts/ship-changes.sh` does this automatically (the closing
   ticket comes from `DSH_CLOSING_TICKET` or the PR body's `#N`
   reference); an agent pushing and opening its own PR sets it in the
   same breath as the PR.
3. **Out of scope by design**: GitHub Projects v2 (tokens lack
   `read:project`; if enabled later it is a tick-synced index, never
   per-face field writes). The authoritative queue stays the git
   claims-stream; milestones are the visibility layer only.

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

## Standing contract: ship-exit skill candidates (issue #187)

**Optional, additive.** A dispatched agent's ship-exit summary MAY carry
one or more `SKILL CANDIDATE` blocks — the fleet's skill-promotion pass
collects them into the shared skill catalog (`.dsh/skills/`), so a
procedure you derived once becomes standing fleet knowledge. The block
rides INSIDE the final result comment: thread comments are the only
durable channel a runner checkout leaves, so a block in any other surface
(assistant-only text, a local file) is lost at discard.

Each block has EXACTLY this shape — the header line, then both labeled
lines, in this order:

```
SKILL CANDIDATE: <kebab-name>
WHEN TO USE: <the triggering situation>
THE PROCEDURE: <the exact steps that worked>
```

The grammar is literal-prefix parseable:

- The header line starts `SKILL CANDIDATE: ` and the name is kebab-case
  (`[a-z0-9]+(-[a-z0-9]+)*`) — lowercase letters and digits, hyphens as
  separators, nothing else.
- Both labeled lines are REQUIRED. A header with no `WHEN TO USE:` and
  `THE PROCEDURE:` lines is a mention, not a candidate — the parser
  rejects it. Do not paraphrase the labels (`WHEN:` / `STEPS:` do not
  parse).
- The block MAY appear one or more times in the same summary; each block
  is a separate candidate.

**Pinned example of a good block** (copy the shape, not a paraphrase):

```
SKILL CANDIDATE: merge-adjacency-conflict-dissolve
WHEN TO USE: the branch conflicts with main only because a sibling PR landed adjacent hunks in the same files, with no semantic overlap
THE PROCEDURE: 1. git fetch origin main && git merge-base HEAD origin/main. 2. git rebase origin/main and list the conflicted files. 3. For each, git diff --name-only of the sibling PR (gh pr view N --json files) — if your changed lines are disjoint from its changed lines, take theirs wholesale: git checkout --theirs <file> is WRONG for a rebase; instead git checkout origin/main -- <file>, then re-apply only your disjoint hunks with git apply of a hand-built diff. 4. Run the targeted tests for the touched modules before the full gate. 5. Push with --force-with-lease.
```

The block does not replace any required exit-summary line — the
`filed-followups:`, `branches-left:`, and parts-table rules above are
unchanged; this is an optional extra section in the same summary.

## Standing contract: branch hygiene (issue #127)

**Zero orphan branches.** A branch whose work outlives the session without
a PR is a lost thread — nothing reviews it, nothing merges it, and the next
survey agent files it as mess (HYGIENE.md measured exactly this: gat's
16-branch `dsh/*` pile was "the single biggest messiness item in either
repo"). The repos run auto-delete-on-merge (already live everywhere;
verified on this repo: `delete_branch_on_merge=true`), so a **merged**
branch cleans itself up. The contract closes the two leak paths the
setting cannot reach — plus the same-claim collision landmine (#327):

1. **SAME-SESSION PR PER BRANCH** — every branch your work lands on gets
   its PR opened in the same session that pushed it. If your lane ships
   for you (the deterministic shipper opens the PRs), confirm the PR
   exists before you exit; if you push yourself, you create the PR. A
   pushed branch with no PR is an orphan. The PR also **carries the
   closing ticket's milestone** (issue #185 — `ship-changes.sh` stamps
   it from `DSH_CLOSING_TICKET` or the PR body's `#N` reference; when
   you open the PR yourself, set it in the same breath:
   `gh pr edit N --repo R --milestone "anchor"`).
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
4. **UNIQUE NAME + PUSH PREFLIGHT** — a minted branch name is
   collision-proofed twice. It carries a **unique suffix** (pid, claim id,
   or timestamp): `dsh/issue-127-c5844082078`, never the bare
   `dsh/issue-N-slug` two agents racing one issue derive identically
   (#327). And before the FIRST push of a minted name, run
   `git ls-remote origin <name>`: a non-empty answer means a sibling
   already owns the name — delete your unpushed local branch, re-mint
   with a fresh suffix, push that. NEVER `git pull` onto the collided
   name (it merges the sibling's work into yours) and NEVER
   `git push --force-with-lease` over it (it overwrites the sibling's
   pushed work behind an open PR); both reflexes destroy a racing claim.

**Acceptance — zero orphans:** at exit, every branch the session pushed is
in exactly one of three states — merged (auto-deleted by the repo setting),
deleted, or declared on the `branches-left:` line behind its open PR. A
pushed branch in none of them is a contract violation.

The prompt assembly stamps this contract into every task it builds too
(structural + behavioral pins: `tests/branch-hygiene-contract.test.mjs`).

## Standing contract: claim-time carrier dedup (issue #414)

**Never work a ticket a live carrier already holds.** The lane-pass claim
protocol picks a ticket by fleet priority, but that order says nothing
about whether a sibling cell already claimed it — so concurrent cells
independently race the SAME open ticket and each ships its own PR
(measured 2026-10-04 on this repo: ~60 open PRs — #361 carried 8, #330
carried 7, #358 carried 5, #385 carried 4, six more tickets carried 3
each; meanwhile genuinely unclaimed tickets sat idle — #266 sat 3 days
with zero carriers). The rule:

1. **CLAIM-TIME CARRIER CHECK** — before starting work on ticket N in
   repo R, run:

   ```bash
   gh pr list --repo R --state open --search "N in:title"
   ```

   and treat any open PR whose title or body references #N the same way.
   A carrier is LIVE while it is open, not closed-without-merge, and not
   stale (no update or review activity for a full review window).
2. **SKIP AND DECLARE** — a live carrier means ticket N is taken: skip to
   the next qualifying ticket by the same priority order, and say so in
   the exit summary — one line per skip, exact shape:

   ```
   skipped: #405 — live carrier #413
   ```

   The declaration is the receipt that the check ran; a silent skip is
   indistinguishable from never having looked.
3. **NOT the other dedup rules** — this is the CLAIM step. #320 is dedup
   before FILING a `found:` ticket (comment receipts onto the existing
   one); #321 (closed; janitor follow-on FleetTower#896) was tickets
   duplicating LANDED work. The carrier check closes the remaining hole:
   two cells both "working" one open ticket.

**Acceptance — no duplicate carriers from this session:** every ticket
this session works had zero live carrier PRs at claim time, and every
carrier-caused skip is declared in the exit summary.

The driver's claim preamble (the DEFAULT_TASK lane-pass text in
`scripts/run-dsh-agent.sh`) carries this rule into every scheduled roam;
`tests/claim-dedup-contract.test.mjs` pins both surfaces (structural +
behavioral) the way `tests/branch-hygiene-contract.test.mjs` pins #127.

## Standing contract: workdir hygiene (issues #333, #374)

**A workdir is yours only if no sibling can predict it, and only while
you can prove it.** Concurrent fleet agents on one box clone their claim
repos into throwaway workdirs, and two predictability vectors have now
destroyed in-flight work. First the shared-path class (#333): the
standard `rm -rf /tmp/<repo> && gh repo clone` recipe re-clones OVER any
sibling already at that path — silently. Then the pseudo-unique class
(#374): an agent minted `work-<issue>-<repo>-$(date +%s)`, called it
unique, and a same-issue sibling minted the SAME path inside the same
epoch second — worse, the takeover was silent: the first agent's
confirmed edits were replaced by the sibling's implementation
mid-session, and every syntax check and test run after the takeover
validated a tree that was no longer theirs (receipts: a single-entry
clone reflog stamped over an edited tree, #333, 2026-10-04 02:25:39;
`work-361-toolkit-1791109240` file mtimes 10:23:45Z/10:24:45Z over edits
confirmed at 10:21Z, #374; the concurrent-maintenance wave that makes
same-second mints the normal case is factory#869 — 14 identical-prompt
agents on one box). The contract:

1. **MINT A RANDOM WORKDIR PER CLAIM** — a timestamp is NOT uniqueness.
   Uniqueness comes from a random component a sibling cannot guess:

   ```bash
   workdir="$(mktemp -d "${TMPDIR:-/tmp}/dsh-<repo>-XXXXXX")"
   gh repo clone OWNER/REPO "$workdir" && cd "$workdir"
   ```

   (A `$HOME`-anchored census dir works the same way:
   `mktemp -d "$HOME/dsh-node/work-<issue>-<repo>-XXXXXX"`.) The bare
   `$(date +%s)` suffix is banned — it collides for same-issue siblings
   within one second, the #327 branch-mint lesson applied to directories
   — and the shared-path clone recipe (`rm -rf /tmp/<repo> && gh repo
   clone ...`) is banned outright: `rm -rf` is legal only inside a dir
   YOUR session minted, never on a predictable path another agent could
   hold.
2. **RE-ENTER ONLY A PATH YOU RECORDED** — a workdir is re-entered via
   the exact path your own session minted and recorded (the shell
   variable, your notes), NEVER via glob reuse
   (`ls -d work-<issue>-* | head -1`): a matching dir can be a sibling's
   live tree at ANY time, not just the same epoch second, and landing
   there silently replaces your edits mid-session — the #374 takeover
   receipt. A dir you did not mint is not yours.
3. **THE OWNER-MARKER BELT** — mint stamps ownership, edit batches verify
   it. At mint, write a marker inside the workdir:

   ```bash
   printf 'session=%s\nclaim=%s\n' "$$" "$ISSUE" \
     > "$workdir/.dsh-workdir-owner"
   ```

   Before each edit batch, re-check the marker matches YOUR session. A
   tree whose marker is not yours — or a dir you didn't mint, marker or
   not — is a takeover in progress: stop, do not edit, file it, mint
   fresh. This is the belt for rule 2's suspenders: it catches the reuse
   vectors no naming discipline can close.

**Acceptance — structurally impossible collisions:** two same-box
siblings working the same issue can never share a worktree — neither
names a path the other could guess (random mint), neither lands in a dir
the other minted (recorded-path re-entry), and any takeover that slips
the first two rules is detected before the next edit batch (owner
marker). The prompt assembly stamps this contract into every task it
builds too (structural + behavioral pins:
`tests/workdir-collision-contract.test.mjs`).

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
- `tests/branch-hygiene-contract.test.mjs` — pins the branch-hygiene driver
  block (placement + the two leak-path rules + the acceptance sentence) and
  the `branches-left:` exit-summary shape.
- `tests/workdir-collision-contract.test.mjs` — pins the workdir-hygiene
  driver block (placement + random-mint/re-entry/marker rules) and keeps
  the corpus free of epoch-mint and glob-reuse recipes (issues #333, #374).
