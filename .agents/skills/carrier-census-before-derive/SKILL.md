---
name: carrier-census-before-derive
description: Before planning or pushing any fix on a dispatched ticket — census for an existing carrier PR, a merged fix, or a done marker, and verify it live; ride, repair, or close instead of re-deriving. Use at pickup on ANY ticket, especially re-fired/redo tickets and any attempt N≥2.
---

# Carrier census before derive

Seven sessions in one 24h corpus independently re-derived the same
anti-duplication procedure (2026-09-28 transcript audit): dispatched agents
planning a fix without first checking whether a carrier PR, a merged fix on
main, or a prior done marker already covers the ticket. The tower's
re-fire/pile machinery makes duplicate derivation the default failure mode
of attempt N — the fix is a two-call census before any planning.

## The census (two API calls, always first)

1. **Open carriers**: `gh pr list --state open` on the target repo — scan
   for the ticket's contract branch (`dsh/issue-…-<N>-todo`) or any PR
   whose body line 1 is `Closes #N`.
2. **Landed fixes**: `gh issue view N` (state + thread) — then verify the
   cited fix at the live tip (`git fetch origin && git show
   origin/main:<file>`), never in the thread's quotes.

For every hit, verify LIVE before acting on it:

- `gh pr view --json state,mergeable,reviewDecision` + `gh pr checks`;
- the two-channel review read: `reviews[].state == CHANGES_REQUESTED` AND
  the newest review body's `## Verdict` grammar (self-reviews downgrade to
  COMMENTED with an empty reviewDecision — the state enum lies);
- `git merge-base` the carrier head against current main so the diff you
  audit is the diff that would land.

## Decision table

| Census result | Action |
|---|---|
| open carrier, green + mergeable | stand down: one done marker naming the carrier PR; no branch, no PR |
| open carrier, red / conflicted / stalled | REPAIR the carrier per its review findings — never mint a sibling |
| merged fix, issue still open | zero-diff closure: one done marker naming the merge + one fresh first-hand receipt; then `gh issue close` |
| nothing exists | derive — and state in your first beat that the census came up empty |

## Rules that repeat

- **Repair > duplicate.** A second PR for the same demand is pile growth;
  the predecessor's CHANGES_REQUESTED findings are your fix spec.
- **Links after creation.** A marker that must contain the PR link gets the
  URL only after `gh pr create` returns it — never hardcode the number.
- **Zero-diff exits name why.** When the fix already landed and no branch/PR
  will exist, the done marker says so explicitly; do not mint an empty PR.
- **Closed ≠ merged.** A closed-unmerged predecessor usually means a
  successor carrier exists — search again before re-deriving.
