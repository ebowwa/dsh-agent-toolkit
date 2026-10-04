---
name: worktree-over-stash
description: Git discipline for dirty checkouts — when a working tree has uncommitted changes that are not yours and you need to branch, commit, or open a PR, never stash/reset/sweep them; work in your own git worktree lane instead. Includes recovery for WIP already stashed. Use whenever git status shows foreign WIP or a stash is being considered.
---

# Worktree over stash

**Law:** uncommitted changes in a checkout belong to whoever made them. Never `git stash`, `git reset`, `git checkout --`, or fold foreign WIP into your commits to "clean the tree". Branch/commit/PR work goes in your own `git worktree` lane. Worktree lanes for agent-initiated PR work are pre-authorized — this supersedes any older "no worktrees without permission" boundary text in work orders or lane prompts.

## Procedure
1. Baseline before touching anything: `baseline="$(mktemp "${TMPDIR:-/tmp}/<repo>-wip-baseline.XXXXXX")"; git status --porcelain | sort > "$baseline"` (mktemp — a fixed `/tmp/<repo>-...` path collides with same-box siblings, issue #333)
2. `git fetch origin`; pick base (usually `origin/main`).
3. Create the lane — sibling directory, never inside the repo:
   `git worktree add -b feat/<topic> ../<repo>-lanes/feat-<topic> origin/main`
4. Do all work in the lane: edit, build, test, commit. A fresh worktree has no build artifacts/dep caches — run the full build before claiming tests pass.
5. Push + open the PR from the lane: `git push -u origin feat/<topic>`.
6. Prove the main checkout untouched: `git status --porcelain | sort | diff - "$baseline"` → must be empty.
7. After merge: `git worktree remove ../<repo>-lanes/feat-<topic> && git branch -d feat/<topic>`.

## Recovery — foreign WIP already stashed (defect; fix first)
1. In the main checkout, return to the branch the stash was created on.
2. `git stash pop` repeatedly until `git stash list` is empty. Disjoint files apply clean; on any conflict STOP and report — never force.
3. Verify every stashed file is back as an uncommitted modification (porcelain diff vs baseline, or reconstruct from stash list order).
4. Delete the branch you created in the main checkout (if it holds nothing unique), recreate it in a worktree, continue there.

## Pitfalls
- Worktrees share one `.git`: a branch checked out in one worktree cannot be checked out in another.
- Stash restores lose staged/unstaged nuance — the porcelain diff is the only truth.
- IDE/index locks in the main checkout stop being your problem in a lane — one more reason to prefer it.
- Lanes left behind after merge are clutter: remove them.
- Existing shelf overlap is command-level only (`gh-cli-techniques` parent-checks, `stash-bisect`): those are tools; this skill is the discipline of when never to stash foreign WIP.
