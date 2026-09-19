> Fleet-scope note (generated copy): this skill was written for the github-activity-tracker factory/fleet checkout. References to "the factory", "the tower", or specific branch names describe that deployment — substitute your own workspace's equivalents when working elsewhere.

# Cross-repo guest work

You were dispatched in the FACTORY repo but your work lives in a TARGET repo. Everything below was learned the hard way by 15+ agents (flight-recorder transcripts, 2026-08-24); treat it as given.

## The mental model swap (do this FIRST)

Your session's CLAUDE.md describes the **factory** — mock-first TypeScript, bun, layer rules. It does NOT apply to the target. After cloning:

1. `gh repo clone <target> work && cd work`
2. Read the TARGET's own `CLAUDE.md` and `README.md`. Follow THAT repo's conventions, gates, and toolchain. You are a guest there.
3. The factory's rules (bun, arch, mock-first) are wrong for a Python target (uv, pytest, its own architecture tests). Never run factory gates in a target repo.

Beware: mid-flight reminders may re-splice the FACTORY's CLAUDE.md into your context. It is factory orientation, not target law — the target's own docs win.

## Bootstrap before concluding anything is missing

Runners are cold. Before deciding "tool X not found":

- Python targets: `uv sync` first (creates `.venv`; then `.venv/bin/python -m pytest ...`)
- TS repos: `bun install --frozen-lockfile` first
- `tsc: command not found` almost always means "deps not installed", not "tsc absent"

## Credential identity (which token pushes where)

The checkout injects the ephemeral runner token via git's `http.https://github.com/.extraheader`:

- That token **cannot push workflow files** (`.github/workflows/**`) and is repo-scoped
- Plain code pushes work with it
- To push workflow-file changes: `git config --local --unset-all http.https.github.com/.extraheader` and let gh's PAT flow
- `gh auth status` shows which identity you hold

## Dominant branches differ per repo

`main` is NOT universal. The task contract carries the target's dominant branch; typical map: factory=`main`, ANE=`dev`, dsh-agent-toolkit=`main`. PRs against the wrong base are the #1 conflict source.

## Runner topology (queue expectations)

Factory lanes (mini-dsh, mini-dsh-2, seed-dsh) run in parallel. **ANE has ONE runner (`mac-mini-ane`)** — its CI, reviews, and deploys serialize behind each other. Expect long queues there; trigger your run, verify it started, and EXIT (the tower observes conclusions — never poll a serial queue away).

## Bare `self-hosted` is a grab-bag (the 2026-08-26 secondsee lesson)

A consumer whose review/CI jobs say bare `runs-on: self-hosted` (or `runner-labels: ["self-hosted"]`) is routing to EVERY cell registered to the repo — uitest boxes, relay cells, prod cells — and only some of them carry the toolchain (`gh`, `doppler`, node/npm). secondsee lost 29 consecutive reviews this way (exit 127 `command not found`, doppler fallback-file errors, npm OOM) after a "widen the labels" PR. Before pinning labels, dump the real inventory and match the job to the cell that has its tools:

```bash
gh api /repos/<owner>/<repo>/actions/runners --paginate \
  --jq '.runners[] | "\(.name) \(.status) labels:\([.labels[].name] | join(","))"'
```

Evidence for "which cell works": grep past runs' logs for `Runner name` (`gh run view <id> --log | grep -m1 "Runner name"`) and correlate with conclusions — the last successful run's cell is the only proven-good target.

Custom labels (`relay`, `agents`, …) are unknown to actionlint and fail `Workflow Lint` until declared in `.github/actionlint.yaml`:

```yaml
self-hosted-runner:
  labels: [relay, agents, uitest, macmini]
```

(actionlint auto-loads that file from the repo root for any workflow under `.github/workflows/`; same form as this factory's own config.)

## Failure-triage shortcuts (what the exit codes mean)

- **127 `command not found`** — the job landed on a cell without that binary; a label/topology problem, not a code problem. Check the runner inventory before touching scripts.
- **Exit 143 (SIGTERM) + adjacent runs `cancelled`** — the runner service went away mid-job (restart/offline), **or** a `cancel-in-progress: true` concurrency group deliberately cancelled a superseded run (this factory's own `gates.yml` does exactly that). Look for a newer run of the same workflow before writing any fix: one exists → supersession, don't re-dispatch a duplicate; none and later runs recovered green → transient outage.
- **`couldn't find remote ref refs/pull/N/merge`** — the PR merged (or closed) before the dispatch ran; GitHub deletes the merge ref on merge. Skip-worthy, not fixable by harder fetches.
- **Checkout of `refs/tags/vX.Y.Z` flapping across days with no local change** — remember the pin tags MOVE (tagsync); a "stable" pin is not a stable tree.
