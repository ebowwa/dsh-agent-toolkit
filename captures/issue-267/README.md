# Captures: reflex-cleared boot verification for PR #267 (issue #267) — REDACTED

Owner directive (2026-10-01): boot the PR #267 head tree and try to clear the
composed-tree boot test's credential wall with the Reflex engine. This branch
added `captures/` only — no code change.

## Redaction (2026-10-04)

The original artifacts (3× full-desktop PNG captures, 3× window-list JSONs,
2× TAP logs) were **removed from this branch**: the captures show the machine's
boot wall including its hostname and Tailscale/LAN addresses, and the window
lists fingerprint installed software — content that must not sit in a public
repository.

The verification itself is still receipted:

- `boot-wall-signature.txt` — the verbatim wall-probe output (text only; it is
  the reflex-cleared receipt: wall reached in <2s, no UI dialog spawned, no
  live call placed, credential wall held).
- SHA-256 of the removed artifacts, as tamper-evident proof of existence:

  | artifact | sha256 |
  |---|---|
  | display-during-boot.png | `62301803ab59742373b22ef239d6a9d17eaf18446f949cbb91a602b33a8da308` |
  | display-before-boot.png | `62301803ab59742373b22ef239d6a9d17eaf18446f949cbb91a602b33a8da308` |
  | display-after-boot.png | `62301803ab59742373b22ef239d6a9d17eaf18446f949cbb91a602b33a8da308` |
  | windows-during.json | `6ab2dae92fb5278a796651759923610c0a647b6d3dd0022ffacdf96c7de0994e` |
  | windows-before.json | `6ab2dae92fb5278a796651759923610c0a647b6d3dd0022ffacdf96c7de0994e` |
  | windows-after.json | `6ab2dae92fb5278a796651759923610c0a647b6d3dd0022ffacdf96c7de0994e` |
  | tap-run1.log | `e9110f6eca317acc9f4cb008aec875076e827af71e8e2061e77532a0f1ed8761` |
  | tap-run2.log | `9dd322670b18a931407dd3bc30f7c9908ce0bfd487ec3f5746869ce98d00326e` |
