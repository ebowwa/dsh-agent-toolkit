# gh/git techniques (the proven forms)

Each of these was independently derived by an agent under time pressure; they are now one lookup. All battle-tested in fleet runs (2026-08-24 transcripts).

## Parent-commit checks — worktree, not stash

```bash
git worktree add ../parent <sha>   # head stays intact in your checkout
cd ../parent && <run the new tests>
git worktree remove ../parent
```
Stash-based variants lose your in-progress state on conflict; worktrees never touch it.

## Stash-bisect (test A vs B without branches)

```bash
git stash push -q -- <files>       # remove the fix
<run tests — expect the failures>
git stash pop                      # restore
```

## PAT git push (header, never the URL — URLs leak tokens in errors)

```bash
BASIC="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ${BASIC}"
# and to REMOVE the checkout's ephemeral token:
git config --local --unset-all http.https://github.com/.extraheader
```

## Clone/fetch discipline for CI-scale repos

```bash
git clone --depth 5 --branch <dominant> <url>     # 5-deep covers the parent check
git fetch --depth=1 origin <branch>               # refresh one branch cheaply
```
Full clones of big repos can time out; depth is almost always enough (you need parent + head, not history).

## API pagination (gh api)

`gh api` pages at 30 by default, 100 max: append `--paginate` for full lists, or `?per_page=100`. A "missing" item past page one is the classic silent-truncation bug.

## Merge-shape awareness

The tower merges with `merge_method: merge` (merge commits — siblings' PR branches stay valid). Squash rewrites history and orphans sibling PRs; never advise squash for tower-landing repos.

## `gh run watch` — the one sanctioned wait

When a single short run (<2m) genuinely gates your next action: `gh run watch <id> --exit-status` (blocks, exits non-zero on failure). Anything longer: trigger, verify queued, exit.
