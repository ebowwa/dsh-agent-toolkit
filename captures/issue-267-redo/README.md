# Captures redo: reflex-DRIVEN boot verification (issue #267 tree) — supersedes PR #271

The first attempt (PR #271, closed + scrubbed) failed its own standard twice:
it never put the Reflex engine in the loop (it passively screenshotted the
desktop), and the screenshots carried the machine's hostname and Tailscale/LAN
addresses into a public repo.

This redo fixes both:

## What ran

The composed-tree boot probe, replicated VERBATIM from
`tests/session-query-mount.test.mjs` (HERMETIC_ENV with every inference
credential stripped + `stampOverlays()` + the `spawnSync` probe), run on the
mac lane **while the Reflex engine (Gauge host, JSON/TCP 49173) polled the
window server** — before, during, and after the boot.

## Receipts (text only — no images by design)

- `reflex-transcript.jsonl` — verbatim engine command→response pairs
  (`status`, `mac-permissions`, `mac-windows` censuses), timestamped, with
  machine identifiers redacted (the engine's window titles carried the boot
  wall's hostname/IP text).
- `boot-probe.txt` — the probe's verbatim stdout/stderr + exit code.
- `verdict.json` — the acceptance evaluation.

## Verdict

- boot dies at the credential wall: **MISSING_CREDENTIAL, exit 1, 3.4s, offline** ✓
- no plugin-load failure (the alpha-line drift shape): ✓
- **no UI dialog spawned during the boot — engine-observed** (before/during/after
  window censuses; zero new windows): ✓

The credential wall holds silently on the mac lane. Nothing to drive; the
fail-closed behavior the GUI-law demands is confirmed by the engine itself.
