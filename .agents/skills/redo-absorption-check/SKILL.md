---
name: redo-absorption-check
description: When redoing a PR that was closed unmerged, diff the predecessor's touched paths against merge-base..main BEFORE re-deriving — main may have partially absorbed the fix while you were queued. Compose the missing remainder onto the landed half instead of shipping a parallel cure. Use when minted "Redo at current main" tickets are older than ~an hour or main has moved since the predecessor closed.
---

# Redo absorption check (compose, don't replay)

A closed-unmerged PR is not necessarily unshipped work. Between its close and
your redo, siblings may have merged into the same problem area. Replaying the
old diff ships a parallel cure: duplicate guards, textual conflicts, and a
reviewer asking why the tree has two fixes for one defect.

## Procedure

1. **Absorption diff first**:
   `git diff <pred-merge-base>..origin/main -- <paths-the-pred-touched>` —
   read what landed. A same-symptom successor PR merged after the close
   usually carries ONE HALF of the original scope.
2. **Split the redo into landed-half vs missing-half.** For each predecessor
   goal, mark it: already on main (cite the commit), partially on main
   (say which arm), or absent. The redo diff contains ONLY the absent and
   the partial-remainder arms.
3. **Compose onto the landed half**: reference its seams instead of
   re-creating them (a guard that landed gets extended, not duplicated; a
   stage that landed gets the missing conditional, not a parallel special
   case). If the landed half's shape conflicts with the old approach, the
   landed half wins — it is already reviewed and green.
4. **Say the composition in the PR body**: one line per predecessor goal —
   "carried by <merged PR#> at <file>:<line>" vs "missing half, added here".
   Reviewers verify the delta, not the history.
5. **Run the predecessor's blocking tests at your head**, not just the new
   arms — absorption is partial, so old findings can still bite the composed
   whole.

## Pitfalls

- A superseded PR whose successor MERGED GREEN looks done — but the successor
  may have shipped only the loud half (fail-fast) while the redo ticket's
  root demand named the other half (self-heal). Check the ticket's acceptance,
  not the symptom.
- Textual conflicts at the same insertion point are a signal you are
  re-deriving absorbed work, not a reason to force-rebase the old diff.
- When the landed half is a guard WITHOUT tests, file the test gap as a
  follow-up ticket instead of silently inheriting the class.

## Relatives

- redo-carries-review-findings: the predecessor's REVIEW verdict governs what
  the redo diff must carry; this skill governs what MAIN already carries. Do
  both checks before writing the redo.
