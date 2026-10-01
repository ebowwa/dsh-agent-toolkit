# Captures: reflex-cleared boot verification for PR #267 (issue #267)

Owner directive (2026-10-01): boot the PR #267 head tree
(`bc89a6b1708e344adabf0571fb0d4d601eff47fb`, branch `dsh/issue-258-c5922965562`)
on the mac lane and try to clear the composed-tree boot test's credential
wall with the Reflex engine (Gauge host, JSON/TCP 49173). The test's skip
guard was NOT edited; the PR tree itself is untouched (this branch adds
`captures/` only, on top of the PR head).

## What ran

- `node --test tests/session-query-mount.test.mjs` on the PR head tree,
  mac lane node mini-L1, dsh CLI 0.1.0-rc.7 present, profile backend
  packages present — **6/6 pass, twice** (`tap-run1.log`, `tap-run2.log`),
  including `the composed tree BOOTS: all three plugins load, boot dies at
  the credential wall` (1.387s / 1.387s-class, no hang).
- The consult stamped the composed overlays for a live engine host
  (5 patches: dsh-reflex, session-persistence-jsonl, session-query-sqlite,
  tool-session-query) — the same shape the test stamps hermetically.

## The wall (exact failure mode)

`boot-wall-signature.txt` — verbatim: the boot exits 1 in under two seconds
with `MISSING_CREDENTIAL` raised by dsh's **credentials service** (provider
route `deepseek-official`, `DEEPSEEK_API_KEY`). It is a non-interactive,
offline, in-process error — **the wall never takes UI form**: no dialog, no
prompt, no browser handoff, by the test's own design (it strips every
inference credential precisely so the boot dies at credential resolution
without placing a live call).

## Reflex receipts (GUI law: capture before + after)

- `display-before-boot.png` / `display-during-boot.png` /
  `display-after-boot.png` — full-display captures taken immediately before
  the first test run, mid-run of a second run (capture fired while the boot
  probes were executing), and after it settled. Byte-identical PNGs: the
  display never changed across the runs.
- `windows-before.json` / `windows-during.json` / `windows-after.json` —
  the Reflex window inventory at the same three moments (paths scrubbed).
  Identical window sets (22 unique / 22 / 22): **zero windows created or
  destroyed by the boots, zero credential-shaped windows**. There was
  nothing for `reflex_click` / `reflex_ax` to act on; no Reflex handling
  action was possible or needed. The standing TCC exception was never
  approached (no consent dialog appeared).

## Cross-check on the "fails on headless Linux" premise

CI on this exact PR head (`gates` run 36803136848, the self-hosted `dsh`
cell — headless Linux): the same test is `ok 345 - the composed tree BOOTS:
all three plugins load, boot dies at the credential wall`. The wall is a
fast offline `MISSING_CREDENTIAL` death on both legs; the test is hermetic
by construction and green on both.
