> Fleet-scope note (generated copy): this skill was written for the github-activity-tracker factory/fleet checkout. References to "the factory", "the tower", or specific branch names describe that deployment — substitute your own workspace's equivalents when working elsewhere.

# Ship and exit

Your work is done when it is PUSHED and the marker is posted — not when the review finishes. The tower's reconcile observes run conclusions, thread markers, and merged branches; an agent holding a runner to watch a queue is a measured defect (one agent slept 57 of its 84 minutes polling; another died at its 120m timeout mid-poll with everything already shipped).

## The protocol

0. Gates green locally BEFORE the push (2026-08-26, the 152-run day): run `bun run lint && bun run typecheck && bun run test && bun run arch` in your checkout first. The same sequence runs on the gates lane in ~60s — a red push is a red gates run, a derived fail ticket, a fix round, and a sibling conflict, all to discover in one minute what you could have discovered at the desk. Yesterday's evidence: every non-main red was a WIP-branch Tests failure, all cheaper locally. The one sanctioned exception: pushing a deliberately-red repro branch when the ticket itself demands it — say so in the PR body.
1. Ship: branch pushed, PR open (or fix pushed to the existing PR branch)
2. Do NOT fire the review workflow yourself — the tower's landing pass re-fires the review on its own clock (native claims on the dispatch transport; the review workflow only where that shell is still deployed). Your fire would race the tower's and stack duplicate review agents.
3. (was the fire-verify step — retired: the tower owns review fires and observes conclusions)
4. Post the marker (if your ticket has a thread): EXACTLY ONE comment containing `dsh-tower:done:<ticket-key>` plus the PR link. No thread → no marker; your PR head branch IS the landing signal (never rename or delete it).
5. EXIT with your factual summary.

## What the tower observes (so you don't have to)

- Workflow conclusions (a dead run resolves your ticket immediately — the dead-run probe)
- Thread markers (the landing evidence)
- MERGED PR branches (the only branch signal that counts — an open PR means still-in-flight)
- Review verdicts on the next cycle

## Never

- Never `sleep N; gh run list` in a loop. If you catch yourself polling, exit.
- Never wait on ANE's serial runner — its queue can be an hour; that hour is the tower's to spend, not yours.
- Never rename/delete your contract branch — the ledger keys landing evidence to it.
