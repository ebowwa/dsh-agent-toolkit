# CORDIS-PLUGIN-PLAN.md — packaging gat's skills + CLI as a dsh plugin

Scoped 2026-09-16. Read-only research; nothing scaffolded yet.

## 0. What the idea is

The user once asked whether github-activity-tracker ("gat") could be "a
cordis plugin that the harness uses". Today the integration is loose:
13 skills at `.dsh/skills/` are discovered only when dsh runs with this repo
as cwd (the `dsh-skill-filesystem` provider), and the `gh-tracker` CLI must
be invoked by path. A plugin would make the fleet's work-record toolkit
available to EVERY dsh composition, from any workspace.

## 1. The dsh plugin convention (verified against the runtime)

Plugins are **npm packages mounted into the profile module tree**, activated
by a row in the profile's plugin-bundle patch layers (`dsh --profile <name>
--patch overlay.yml`). Verified sources:

- `~/.dsh/runtime/node_modules/@deepseek-ai/` — ~50 `dsh-*` packages, each a
  cordis plugin (`dsh-skill`, `dsh-skill-filesystem`, `dsh-tool-skill`,
  `dsh-agent-*`, `cordis-plugin-*`, …).
- The in-repo precedent: `dsh-bot`'s `plugins/tool-search-compose/` — its
  README documents the full mount contract: a **real package**
  (`package.json` with `name`/`version`/`main`; a bare in-tree path fails —
  the f2972e7 blocker), copied by the launcher into
  `$DSH_HOME/profiles/node_modules/<pkg>`, activated by a **regenerated
  patch overlay using an explicit `insert:` row** (a bare unknown-id row only
  warns and is silently skipped). The overlay names the package, never a
  path; `@deepseek-ai/*` deps resolve positionally against the profile
  tree's flat fallback.
- Skills specifically: `@deepseek-ai/dsh-skill` is the registry; providers
  contribute via `ctx.skills.registerProvider(...)`; **embedded skills**
  register in-memory with `ctx.skills.register(...)` and get the `runtime`
  provider label; every skill carries an invocation policy
  (`modelInvocable` / `userInvocable`). So a plugin can ship skills two
  ways: register them at activation, or ship `SKILL.md` files and register
  a small filesystem provider scoped to the package dir.

### Sketch: package structure (NOT scaffolded yet)

```
@gh-tracker/dsh-plugin/
├── package.json          # name, version, main: lib/index.js (tool-search-compose shape)
├── lib/index.js          # activation: ctx.skills.register(...) × N (or a provider)
├── lib/skill-tool.js     # optional: a `work-record` tool wrapping the gh-tracker CLI
└── skills/               # the SKILL.md sources (kept in sync with .dsh/skills/)
```

The entrypoint exposes (in increasing ambition):
1. **skills only** (pure instruction packs — zero runtime deps);
2. + a thin tool (`gh-tracker` invocation with repo discovery, so agents in
   any workspace can query the work record);
3. + the web dashboard hand-off (deeplink to the Vercel route) — probably
   NOT worth it; the CLI covers agents.

## 2. Which of the 13 skills translate directly

| Skill | Translates? | Why |
|---|---|---|
| pr-body-dod | **Yes, direct** | repo-agnostic PR-body honesty contract |
| gh-cli-techniques | **Yes, direct** | repo-agnostic gh/git one-liners |
| parent-commit-verification | **Yes, direct** | repo-agnostic "fails without it" proof method |
| sed-yaml-escaping | **Yes, direct** | tool-trap reference, no repo coupling |
| conflict-recovery | **Yes, direct** | branch-healing ladder, generic |
| cross-repo-guest | **Mostly** | names the factory checkout; needs a small wording pass |
| ship-and-exit | **Mostly** | protocol is generic but references "the tower"/markers — parameterize or scope to fleet installs |
| flight-recorder-audit | **Mostly** | method is generic; paths reference the tower-state branch |
| factory-arch-conformance | **No (keep local)** | IS the gat repo's arch law — belongs to the repo, not a fleet plugin |
| dsh-bot-release-etiquette | **No (keep local)** | dsh-agent-toolkit release mechanics |
| ane-verification | **No (keep local)** | ANE-repo-specific |
| gauge-app-release | **No (keep local)** | Gauge-specific |
| gauge-plugin-release | **No (keep local)** | Gauge-specific |

**5 translate as-is, 3 with a light wording pass, 5 stay repo-local.**
Recommendation: the plugin ships the 8 portable ones; the 5 repo-specific
ones stay in `.dsh/skills/` (the filesystem provider still finds them when
working in gat — no loss).

## 3. Migration steps (each ≈ one commit)

1. Extract the 8 portable skills into `plugins-src/dsh-plugin/skills/` with a
   sync note in each (`source: .dsh/skills/<name>` + date) — or the reverse
   (make `.dsh/skills` the source and have the plugin build copy) — pick one
   direction; two copies without a sync rule is how they drift.
2. Scaffold `package.json` + `lib/index.js` registering the skills via
   `ctx.skills.register(...)` (frontmatter name/description/whenToUse →
   registry fields; set `modelInvocable: true, userInvocable: false` to
   match today's model-only surface).
3. Boot-verify against the runtime dsh: `dsh --dump-config` with the overlay,
   then a headless run whose catalog shows the `runtime`-provider skills.
4. (Optional unit) add the `work-record` tool wrapping `gh-tracker` with the
   required `defineTool` output block (the f2972e7 lesson).
5. Install path: extend the `run-dsh-agent.sh` launcher pattern (opt-in env
   flag like `DSH_SEARCH_COMPOSE=1`, launcher copies package + stamps
   `insert:` overlay) OR a one-time manual mount into the persistent
   profile. The launcher route is the tested one.
6. Docs: a README in the plugin dir following tool-search-compose's
   honest-parameter style.

## 4. Effort estimate

| Unit | Effort |
|---|---|
| Steps 1–3 (skills-only plugin, mounted + boot-verified) | **half a day** |
| Step 4 (CLI-wrapping tool, with output-block contract + tests) | **half a day to a day** |
| Step 5 (launcher integration in dsh-bot, smoke per cell) | **half a day** |
| Total | **~2 days** for the full shape; a skills-only v0 is achievable in one focused session |

## 5. Open questions for the user

1. Ship scope: 8 portable skills only, or also parameterize ship-and-exit /
   cross-repo-guest for fleet use?
2. Mount route: opt-in launcher flag (dsh-bot pattern) vs persistent-profile
   install?
3. Tool ambition: skills-only v0 first, or straight to the `work-record` CLI
   tool?
4. Source of truth: do skills live in gat and the plugin build-copies, or
   does the plugin become the home and gat's `.dsh/skills` shrink to the 5
   repo-specific ones?
