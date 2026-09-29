---
name: cross-repo-grammar-lockstep
description: Land the same semantic one-line change in a sibling repo's byte-parity mirror (core copied between repos, shared grammar/doc pins) without breaking parity — read each side's current grammar before transplanting, respect the parity tests' substring assertions, branch from the consumed pin sha, and verify the two written lines are byte-identical. Use for "land the same change in the sibling repo's core in lockstep" tickets.
---

# Cross-repo grammar lockstep (same delta, different syntactic home)

Distilled from a factory↔FleetTower core-mirror claim (2026-09-29): the same
rule change lives at different line positions and in different phrasings per
side, and the parity tests pin contiguous substrings — a transplant that reads
well on one side breaks the other side's pins.

## Procedure

1. **Read the TARGET side's current grammar first.** Never copy-paste the
   source side's lines. The same semantic delta has a different syntactic home
   per side (ordering, heading, sentence shape).
2. **Grep the target's parity/regression pins for contiguous-substring
   assertions** (`toContain`, snapshot lines). They dictate WHERE a new clause
   may be inserted — between two pinned substrings is safe, inside one is not.
3. **Branch the carrier off the current pin sha, not the sibling's main.** The
   mirror only promises byte-parity at the consumed pin. Prove the branch is
   safe against the pin's merge-base before any gate run:

       git merge-tree $(git merge-base origin/main HEAD) origin/main HEAD

4. **Apply mirror lines with a scripted line-edit that asserts the exact line
   prefix** (e.g. python replacing a line only if it starts with the expected
   text), then diff-verify the two written lines are byte-identical modulo the
   intended delta. A silent near-miss here is the whole bug class.
5. **Targeted parity suite first, full gate sequence once** — the pins fail
   fast and tell you the insertion position; the full suite is for the receipt.

## Guardrails

- If the two repos' grammars have already drifted beyond the pin (the target
  side's section was rewritten), stop and file the drift instead of forcing the
  lockstep — a forced transplant manufactures a third variant.
- Commit the source-side and target-side hunks as separate commits so review
  can diff each side against its own prior text.
