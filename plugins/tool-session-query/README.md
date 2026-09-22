# tool-session-query (vendored build)

The model-facing session history tools: `session_search`, `session_event_search`,
`session_trace`, `session_event_trace`, `session_event_read` — five read-only
tools over `ctx.sessionQuery` (issue #110). Agents running
verify-before-dismissal call `session_search` with a limitation claim and find
the prior session that already investigated it, instead of re-deriving the
wrong answer or hand-writing zstd parsers over the session logs.

## Provenance (read before refreshing)

This is the **built upstream package**, vendored so the mount is
self-contained and offline:

- upstream: `deepseek-harness` `packages/session-query/tool-session-query`
  (npm `@deepseek-ai/dsh-tool-session-query`)
- vendored version: **0.1.0-rc.8** (`npm pack @deepseek-ai/dsh-tool-session-query@0.1.0-rc.8`,
  tarball extracted, `lib/` + `package.json` + `LICENSE` kept) — the build
  that era-matches the dsh profile tree (whose `dsh-session` is 0.1.0-rc.x).
  The newer alpha line does NOT load against it: 0.1.7-alpha.2 imports
  `SessionSeq` from `@deepseek-ai/dsh-session`, which the rc-era package does
  not export — the real-profile boot proof in
  `tests/session-query-mount.test.mjs` catches that as a plugin-tree load
  failure, which is exactly why the proof runs on every dsh cell.
- why vendored: the upstream git tree ships only `src/` (no built `lib/`), and
  no `dsh` release depends on this package (checked npm — it is opt-in by
  design), so neither a git checkout nor a dsh upgrade can put a loadable copy
  in the profile module tree. The built tarball is ~104K and imports only
  `@deepseek-ai/*` bare specifiers, which resolve through the profile's flat
  fallback (same packaging contract as
  [`tool-search-compose`](../tool-search-compose/README.md)).
- refresh procedure: bump the version here deliberately (the ADR 2026-08-27
  adoption posture) ONLY to a build that boots against the deployed profile
  tree — run the live boot proof on a dsh cell before landing; an alpha-line
  bump that imports renamed session APIs will fail it. Land the bump in the
  same PR as any manifest config change that depends on it.

The harness's own packages are NOT vendored — `@deepseek-ai/dsh-session-query-sqlite`
(the `ctx.sessionQuery` backend this plugin reads) ships inside the dsh
profile already; this repo only flips its config on (see
`config/lane-plugins.json`, entry `session-query-sqlite`).

## Mount contract (scripts/lane-plugins-consult.py)

Declared in `config/lane-plugins.json` under seam `plugin` (the compose
pattern): per-job copy into
`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-tool-session-query` + an
explicit `insert:` overlay row naming the package. The consult gates on the
backend package being present in the profile tree
(`require_profile_packages`) — without it the five tools would register and
then fail every call, which is a dead mount wearing a working one's clothes.

## What is verified where

- `tests/session-query-mount.test.mjs` — package integrity (parse checks, the
  name/version pins the overlay and docs rely on), the manifest cross-pins,
  the consult's gating and row shapes for all three session-query entries.
  Offline; never imports the vendored lib (CI has no profile tree — same
  posture as the tool-search-compose tests, which `node --check` instead).
- Live proofs (skip-gated on the `dsh` CLI; the dsh lanes run them):
  `--dump-config` composes the overlays into the real profile, and the
  packaged plugin tree boots against it.
