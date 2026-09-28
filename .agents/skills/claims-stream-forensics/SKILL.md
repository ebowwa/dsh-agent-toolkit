---
name: claims-stream-forensics
description: Prove where a dispatched claim actually ran — node, lane, attempts, outcomes — by projecting the fleet's claims-stream append log (latest row per ticket key), then corroborating against the issue thread, node log, and live process census before alleging any misroute, stuck claim, or re-mint. Use for placement-law audits, "which node took this?" disputes, hung/re-mint triage, and misroute tickets.
---

# Claims-stream forensics

Dispatch disputes get argued from memory: "it ran on the wrong node",
"this is a re-mint", "the claim is stuck". The fleet's claims stream is an
append log that answers all three with receipts — but only if read with its
actual shape. Audited sessions show agents quoting a single row, or the
truncated tail of a result field, as if it were the whole truth.

## Read the stream's shape first

`data/dispatch-claims.jsonl` on the tower checkout is an APPEND LOG: every
state change appends a row. One ticket key can have many rows; the LAST row
per `ticketKey` is the current truth. Never treat a row you happen to see
as the claim's state.

Latest-wins projection (any scripting language):

```python
import json
latest = {}
for line in open("data/dispatch-claims.jsonl"):
    r = json.loads(line)
    latest[r["ticketKey"]] = r          # last row wins
for r in sorted(latest.values(), key=lambda r: r["at"])[-20:]:
    print(r["at"], r["lane"], r["nodeId"], r["state"], r["repo"], r["ticketKey"])
```

Row fields that matter: `at` (UTC ISO), `lane`, `nodeId`, `state`
(`queued|claimed|done|...`), `result` (exit tail), `attempt`, `task`.

## The audit moves

1. **Placement law**: join `lane` + `nodeId` against the fleet manifest's
   OS classes. A mac-native ticket on a Linux `nodeId` (or linux-native on
   macOS) is a defect line; a lane NAME is never an OS proof. No `nodeId`
   on a `claimed` row with no later row = phantom seat — check the node
   before charging capacity.
2. **Truncation guard**: `result` fields and done-comments can be sliced
   tails (known tower class — a result ending mid-word is a crop, not the
   exit). The full exit summary may survive ONLY in the session transcript.
   Corroborate every allegation with a second channel: the issue thread
   (done marker + summary), the node's own log (spawn/exit lines), or a
   live process census. One channel is a hint; two are a receipt.
3. **Re-mint detection**: two claims on one `ticketKey` where the earlier
   exited done with a green carrier PR = the standing carrier-race class —
   file it under that class, do not re-derive the fix, and let the live
   attempt stand down onto the carrier.
4. **Stuck-claim triage**: a `claimed` row older than the time budget with
   no exit row is a CANDIDATE stuck claim, not a fact. Check transcript
   writes on the owning node and the node child process before killing or
   re-dispatching; low CPU alone can be a healthy API-bound session.

## Receipt shape

One line per claim, verbatim values, no inference:

    repo#N attempt=A node=<nodeId> lane=<lane> state=<state> at=<iso> result="<first 40 chars>…"
