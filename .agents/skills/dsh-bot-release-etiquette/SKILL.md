---
name: dsh-bot-release-etiquette
description: How dsh-agent-toolkit versions flow — releases, tags, bump PRs, the rolling branch, tag-sync, and pin lockstep across consumer repos. Use when a task mentions dsh-agent-toolkit (formerly dsh-bot) pins, bump PRs, release tags, or the reusable workflow refs.
---

# dsh-bot release etiquette

dsh-agent-toolkit (renamed from `dsh-bot`; this skill keeps its legacy name) ships the reusable workflows the whole fleet calls. Its version flow has hard-won rules (earned across v1.13→v1.27, 2026-08-24); violating any of them has caused fleet-wide dispatch failures.

## The flow

1. A change merges to dsh-agent-toolkit `main`
2. `drift-check` (self-reviewing release agent) computes the next minor tag, reviews its own diff, and tags ONLY if approved — then notifies consumers via `repository_dispatch`
3. The factory's bump workflow opens/updates ONE rolling PR (`dsh-bot/bump-latest`) rewriting the `@vX.Y.Z` pins in the consumer workflows
4. On bump-PR merge, the **tagsync** job moves the tag to dsh-agent-toolkit's current `main` head

## The rules (each learned from an incident)

- **Never release with an empty tag payload.** A dispatch without `tag` sed-rewrote pins to a literal dangling `dsh-bot@` (PR #138 incident). The bump workflow guards this; keep the guard.
- **The tag must point at the tree gates reviewed.** Releases create tags at pre-merge heads; a stale tag ships unreviewed bytes and 422s every dispatch (v1.19.0, v1.24.0 incidents). Tag-sync exists for this — don't bypass it.
- **Workflow-file YAML is parse-fatal.** An unquoted colon or a mis-indented key kills the CALLED workflow; every dispatch 422s with "failed to parse workflow" while dashboards stay green. Validate with actionlint AND pyyaml before pushing — both catch distinct classes.
- **Consumer pins and `dsh-bot-ref` inputs move in LOCKSTEP.** ANE's contract test enforces `dsh-bot-ref == the uses: pin`; bump both together or CI dies on the drift.
- **A release sequence updates the rolling PR; it never opens one PR per tag.** (Three simultaneous bump PRs once raced each other through gates.)

## Consumer-side facts

- Factory pins: `.github/workflows/dsh-agent.yml`, `dsh-review.yml`, `dsh-agent-comment.yml` → `ebowwa/dsh-agent-toolkit/.github/workflows/<wf>.yml@vX.Y.Z`
- ANE's shell pins separately (its `dsh-review.yml`) — a factory bump does NOT update ANE's pin; ANE bumps its own
- Fully-qualified refs (`refs/tags/vX.Y.Z`) are the hardened form — a same-named branch cannot shadow the tag
