---
name: submodule-pin-superset-bump
description: Bump a consumer repo's submodule gitlink when the current pin might be an open-PR head rather than trunk - a naive trunk bump strands the pinned content, so prove ancestry, cherry-pick a byte-identical twin PR in the submodule, and pin the gitlink to the twin head. Use whenever a claim bumps a submodule pin and a sibling pin-bump PR may be in flight.
---

# Submodule pin superset bump (never strand the old pin's content)

Distilled from the factory gat-pin bump r2 (2026-09-28): PR #492 pinned a
regression; the redo #496 had to land as a *strict superset* of the old pin
so any merge order stays clean.

## Procedure

1. **Prove ancestry first**: `git merge-base --is-ancestor <current-pin> <target>`.
   If false, a naive trunk bump STRANDS the current pin's content — measure the
   strand (per-tree test count in the submodule before/after) so the ticket
   states the cost in evidence, not adjectives.
2. **Cherry-pick the merged content commit** onto the current pin. Rev-parse
   every touched blob against the original to prove byte-identity, then push
   as a *twin PR* in the submodule repo.
3. **Pin the consumer gitlink to the twin head** — a strict superset of the
   old pin lands clean under ANY merge order of the sibling PRs.
4. **Disclose the open-head pin** in the PR's NOT-verified section; a pin on
   an unmerged head is a fact the reviewer must see.

## Guardrails

- Two competing pin-bump PRs on the same gitlink = duplicate-carrier class:
  stand yours down against the healthier one (cite it) instead of racing.
- Always `git fetch` the submodule explicitly; a stale submodule mirror is the
  #1 cause of "phantom" content differences between the two PRs.
