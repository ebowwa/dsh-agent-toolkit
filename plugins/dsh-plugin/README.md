# @gh-tracker/dsh-plugin (v0)

Skills-only dsh plugin embedding the 8 portable github-activity-tracker
agent skills via `ctx.skills.register()` (runtime provider, model-invocable
only). See `../CORDIS-PLUGIN-PLAN.md` for the scoping.

## Status: built + boot-verified, NOT mounted

The package is verified with a throwaway profile (see below). It is NOT
mounted into the live `headless`/`web` profiles or any launcher — that is a
user decision (opt-in launcher flag vs persistent install; plan §5).

## Skills shipped

pr-body-dod, gh-cli-techniques, parent-commit-verification,
sed-yaml-escaping, conflict-recovery, cross-repo-guest, ship-and-exit,
flight-recorder-audit.

`cross-repo-guest`, `ship-and-exit`, and `flight-recorder-audit` carry a
generated fleet-scope note (their prose references the factory/tower
deployment). The 5 repo-specific skills (factory-arch-conformance,
dsh-bot-release-etiquette, ane-verification, gauge-app-release,
gauge-plugin-release) stay in `.dsh/skills/`.

## Sync direction

`.dsh/skills/` is the source of truth; `skills/*.md` here are generated
copies. Regenerate by re-extracting the frontmatter bodies (open question in
the plan: whether the plugin should become the home).

## Boot verification (verified 2026-09-16, throwaway-profile route)

```bash
DSH=~/.dsh/runtime/node_modules/.bin/dsh   # NOT /opt/homebrew/bin/dsh (stale rc.7)

# 1. throwaway profile + package into the shared profile module tree
$DSH --profile gat-v0-test --from-default-profile headless
mkdir -p ~/.dsh/profiles/node_modules/@gh-tracker
cp -R dsh-plugin ~/.dsh/profiles/node_modules/@gh-tracker/dsh-plugin

# 2. compose check: --dump-config shows the insert row applied
$DSH --profile gat-v0-test --patch dsh-plugin/gat-v0-test.patch.yml --dump-config | grep gh-tracker

# 3. A/B catalog check from a NEUTRAL cwd (not gat — the filesystem provider
#    would find .dsh/skills there and confound the result):
#   WITHOUT the overlay: only the global user skills (~/.dsh/skills) appear.
#   WITH the overlay: those plus exactly the 8 plugin skills appear.
$DSH --profile gat-v0-test "list your skill catalog"   # control
$DSH --profile gat-v0-test --patch dsh-plugin/gat-v0-test.patch.yml "list your skill catalog"

# 4. cleanup (nothing stays mounted)
rm -rf ~/.dsh/profiles/gat-v0-test ~/.dsh/profiles/node_modules/@gh-tracker
```

Recorded result of step 3 (neutral cwd, web-search-browser workspace):
- control: autonomous-delegator, iterate-reflex, make-pdf, reflex-over-ssh,
  resume-headless-session, using-reflex (6)
- with overlay: the same 6 **plus all 8 plugin skills** (conflict-recovery,
  cross-repo-guest, flight-recorder-audit, gh-cli-techniques,
  parent-commit-verification, pr-body-dod, sed-yaml-escaping, ship-and-exit)
```
