---
name: cross-repo-grammar-lockstep
description: Landing the same one-line semantic change in two repos whose mirrors must stay byte-identical (factory core ↔ tower/gat, twin carrier PRs) — read the target side's own grammar, branch off the parity pin sha, and prove byte-parity before opening carriers. Use when a ticket says "mirror", "lockstep", "byte-parity", or names sibling PRs across repos for one change.
---

# Cross-repo grammar lockstep

Sighted 2026-09-28 on the FleetTower#496 `reviewClaimEvent` mirror fix: the same
semantic delta has a DIFFERENT syntactic home per side (factory core vs the tower's
gat mirror), and each side carries parity/regression pins with contiguous-substring
`toContain` assertions that dictate where new clauses may be inserted. Naively
transplanting the sibling's diff shape breaks the pins or the grammar.

## The procedure

1. **Read the TARGET side's current grammar before transplanting.** Never assume the
   sibling's line shape ports as-is; locate where the target side expresses the same
   concept today.
2. **Grep the target's parity/regression pins for contiguous-substring assertions**
   (`toContain(` with multi-line strings) — they dictate the exact insertion position
   of new clauses. Update the pin and the code in the same commit.
3. **Branch the carrier off the current PIN sha, never sibling-repo main.** Prove
   safety before any gate run: `git merge-tree <merge-base> origin/main HEAD` must be
   conflict-free.
4. **Apply mirror lines with a scripted line-edit that asserts the exact line prefix**
   (fail loud if the anchor line moved), then diff-verify the two written lines are
   byte-identical (`md5` both, compare — an `md5` in the PR body makes the lockstep
   claim checkable by reviewers).
5. **Targeted parity suite first, full gate sequence once.** Run the parity/regression
   pin files before spending the full gate minutes; run the full sequence at the ship
   tree.

## Twin-carrier bookkeeping

- Name twin PRs in each body ("open twin PRs: gat#N @ <sha>, factory#M, tower#K") so
  reviewers can verify the parity claim across sides.
- One `Closes #N` per repo's own ticket; never cross-wire the close lines.
- If one twin lands and the other goes conflicted, expect the tower landing pass to
  supersede the conflicted twin — resolve the conflict against the NEW main (which now
  contains the sibling's landed line), re-push, reopen with a dated appendix. Do not
  open a duplicate ticket; reuse the still-open one.
