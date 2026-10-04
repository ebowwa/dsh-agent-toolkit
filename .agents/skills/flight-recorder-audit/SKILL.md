---
name: flight-recorder-audit
description: How to read the fleet's own transcripts on the tower-state branch — locating a run's session, decoding the zstd JSONL, and the analysis lenses that found real defects (polling waste, duplicate dispatch, confusion episodes). Use when asked to evaluate what an agent (or the fleet) actually did, verify a claim about agent behavior, or hunt for new optimization levers.
---

# Flight-recorder audit

Every dispatched agent's complete generation — every reasoning chunk, tool call, and result — is archived on the `tower-state` branch under `data/sessions/run-<id>/`. "What did that agent do?" is a lookup, never a guess.

## Locate and decode

```bash
git fetch origin tower-state
git ls-tree origin/tower-state data/sessions/          # list run ids
F=$(git ls-tree -r origin/tower-state --name-only data/sessions/run-<id>/ | head -1)
stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-flight-recorder-audit-XXXXXX")"   # per-run staging (issue #364) — a fixed /tmp/s.zst is swapped by a same-box sibling auditing another revision, and the decode silently reads the wrong session's bytes
git show "origin/tower-state:$F" > "$stage/s.zst"
zstd -dc "$stage/s.zst" > "$stage/s.jsonl"             # one JSON event per line
rm -rf "$stage"                                        # cleanup rule: only the path this session minted
```

## The event vocabulary

`session`/`permission/preset`/`sandbox/mode` (envelope) · `user/message` (the task) · `reasoning-chunks` (thinking; texts in `data.texts`, join them) · `assistant/chunk` · `text-chunks` (final message pieces) · `tool/call` + `tool/result` · `step/start`/`step/end` · `todo/write` · `agent/inbox/spliced` (tower injections). Note: newer sessions key timestamps as `time0`/`seq0`; older as `time`/`seq` — read both.

## The lenses that found real defects

1. **Time allocation**: gap after each `tool/call` = execution time. Classify the slow ones — `sleep N; gh run list` is POLLING (found: 28-71% of wall-clock wasted; one agent asleep 57 of 84 minutes).
2. **Confusion markers**: scan reasoning for `wrong|misread|that's odd|wait` — then read the surrounding window. Separate working confusion (noticed → verified → dismissed in ~2 calls) from spirals (multi-minute; found: the backslash-escape episode).
3. **Claims vs reality**: find verification claims ("all N fail on parent") in reasoning, then confirm the test RUNS precede the claim. Zero unbacked claims were found when checked properly.
4. **Tool census**: name-frequency across runs exposes habit vs tool (found: 72% bash; dedicated tools unused despite being mounted).
5. **Deliberation depth**: longest contiguous reasoning block before a tool call = the architectural decisions (found: 60K-char seam-selection monologues — the fleet's hard thinking is placement, not typing).
6. **Single-source techniques**: command patterns appearing in only 1-2 runs = folklore at risk of loss (found: worktree parent-checks, stash-bisect — now skills).

## Honest-audit cautions

- Window artifacts lie: checking "3 events after a claim" found 0 backing; reconstructing the full timeline found all 10 test runs preceded it. Verify before declaring dishonesty.
- Regex folklores misfire: "16 restarts" were scratch-dir *test harnesses*, not mental restarts. Read matches in context before counting.
- Aggregate, then read: census tells you WHERE to read deeply; the deep read confirms or corrects the census.
