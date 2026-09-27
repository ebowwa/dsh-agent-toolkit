---
name: ane-verification
description: ANE's test-and-verification landscape — uv bootstrap, the safe suite vs ane-marked tests, architecture contract tests, maturity inventory regen, and the single-runner queue. Use when working in ebowwa/ANE, running its CI locally, or regenerating its docs.
---

# ANE verification

ANE is a Python/Swift research repo (~1,900+ tests). Its verification landscape has sharp edges; this is the map.

## Bootstrap

```bash
uv sync                 # creates .venv — do this FIRST
.venv/bin/python -m pytest <path>   # or: uv run pytest <path>
```

`uv run pytest` can silently stall on a cold cache the first time in a CI sandbox; `.venv/bin/python -m pytest` after `uv sync` is the reliable form.

## The suite shape

- **Safe suite**: `pytest python/tests -q -m "not ane"` — what CI's "build + safe tests (no ANE budget)" step runs. This is your default gate. ~1,900 tests, minutes-scale.
- **`ane`-marked tests**: need research hardware/budgets; CI skips them. Never treat an `ane`-mark skip as a failure.
- **Architecture contract tests** (`python/tests/architecture/`): these encode REPO LAW — e.g. `test_dsh_bot_ref_matches_reusable_workflow_pin` requires the `dsh-bot-ref` input to equal the `uses:` pin (bump both together). They fail CI on principle violations that look cosmetic elsewhere. Run them explicitly when touching workflows or shell files: `pytest python/tests/architecture/ -q`.
- **Researcher tests** may fail on environmental gaps (e.g. missing bridge build) — check whether the failure is pre-existing on the parent commit before owning it.

## Generated artifacts (the maturity/ontology discipline)

`MATURITY.md`, `docs/maturity_inventory.json`, `docs/ontology/ontology.json` are GENERATED. If your change touches module/test counts:

1. Regenerate: `PYTHONPATH=python python3 scripts/docsgen/gen_maturity.py` (and the ontology autofix script if prompted)
2. **Stale generated docs fail CI** (`--check` mode) — a green suite with a red CI often means exactly this
3. CI has a **self-heal** path that auto-commits regens; if it commits onto YOUR PR branch mid-flight, pull it and shepherd its approval-gated run
4. Validate large regen deltas against what CI produced — a locally-generated artifact from a missing env (e.g. no Swift checkout) can be WRONG while looking plausible

## The runner

ANE has ONE self-hosted runner (`mac-mini-ane`). CI, dsh-reviews, and deploys all serialize behind it. Trigger your run, confirm it queued, and exit — never poll that queue.

## Host-specific hazards

- `/Volumes` probes (SSD store-dir discovery) can stall unboundedly on sick external volumes — the codebase has bounded-probe wrappers now; never add a raw `os.listdir('/Volumes')` at import time
- Deploy paths ("Deploy to VPS") block on local changes in `tools/scanviewer/` — read the deploy workflow's guard before touching that tree
