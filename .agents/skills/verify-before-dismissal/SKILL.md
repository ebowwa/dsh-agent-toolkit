---
name: verify-before-dismissal
description: Search prior session history BEFORE declaring a limitation, absence, or "not supported" — the native session_search/session_event_search/session_trace tools make verification cheaper than the dismissal that would replace it. Use whenever about to claim something cannot be done, does not exist, or was never tried.
---

# Verify before dismissal

You are about to declare a limitation: "X doesn't support Y", "there is no
code for Z", "this was never investigated". That declaration is a claim about
prior work — and prior work is searchable. Nine confirmed instances in seven
days (FleetTower #146 audit) of agents confidently re-deriving wrong answers
that earlier sessions had already investigated and disproven.

## The rule

A dismissal without a search is a guess. Run the search FIRST — it is one
tool call, cheaper than the wrong turn a false dismissal causes.

## Native tools (mounted in the dispatched profile)

The profile mounts `tool-session-query` (issue #110). Use the tools, in this
order:

1. **`session_search`** — the claim's own words, verbatim: the exact phrase
   you were about to write ("BCM43455 doesn't support 80 MHz in AP mode").
   Ranked FTS5 across the box's session history. If a prior session
   investigated the claim, this finds it with a best-match excerpt.
2. **`session_event_search`** — prior pushbacks and corrections inside a
   promising session: search the session from step 1 for the rebuttal words
   ("actually", "wrong", "fixed by", "the real cause").
3. **`session_trace`** — where the current task came from: the parent session
   that dispatched you, and any sibling attempts that may have hit the same
   wall.
4. **`session_event_read`** — the exact prior verdict, so you can cite it
   rather than summarize from a snippet.

Then write the disposition WITH the citation: "prior session
`session-<uuid>` already tested this — excerpt — so the claim is [true /
false / stale]". If the search finds nothing, the dismissal is now EARNED:
say what you searched for.

## Scope honesty

- Search covers THIS box's shared session store, and cross-session
  authorization is exact-`cwd`: sessions from other working directories (other
  lanes, other boxes) are invisible, by design. "Not found" means "not found
  in this workspace's history", never "never happened anywhere".
- Queries are literal phrases — FTS5 syntax (`OR`, `*`, quotes) is treated as
  data. Search the words, not a boolean expression.
- A capped result asks you to narrow; narrow, don't conclude.

## Fallback (tools not mounted)

If `session_search` is not in your tool registry, say so in one line and fall
back to reading the store directly: `$HOME/.dsh/sessions/<cwd-slug>/session-*/
session.jsonl.zstd` (zstd-decompress, grep for the claim). That is the
hand-parser path this skill used before issue #110 — slower, local, and no
ranking, but still a search. Still no store? Then the dismissal is earned by
absence of evidence — say that, not a flat limitation.

## Anti-pattern (what this skill replaces)

> "BCM43455 doesn't support 80 MHz in AP mode" — written without a search,
> while an earlier session on the same box had already measured it working
> with a specific hostapd config. The next agent inherits the wrong belief
> and re-runs the experiment.
