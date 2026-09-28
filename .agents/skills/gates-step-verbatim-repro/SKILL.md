---
name: gates-step-verbatim-repro
description: Reproduce or verify ONE specific GitHub Actions step locally (flaky gate, dep-install divergence, env-dependent failure) by extracting the step's exact `run:` block and executing it verbatim in bash - same commands, same failure. Use whenever a claim must debug or confirm a CI-step defect without waiting for a runner or burning CI cycles.
---

# Gates-step verbatim repro (run the CI step, not an approximation)

Distilled from the dsh-agent-toolkit gates step-3 investigation (2026-09-28):
peer-union install settling PRUNED while CI passed — only a verbatim step run
showed it. Approximate local re-creations diverge exactly where the bug lives
(extra flags, different shell state, different cwd).

## Procedure

1. **Extract the step's `run: |` block byte-for-byte** from the workflow YAML,
   not from memory:

       python3 - <<'EOF'
       s = open('.github/workflows/<workflow>.yml').read()
       i = s.index('run: |', s.index('<step name anchor>'))
       j = s.index('      - name:', i)          # next step at same indent
       open('/tmp/step.sh','w').write(s[i+7:j])
       EOF

2. **Syntax-check it before running**: `bash -n /tmp/step.sh`.
3. **Wipe the state the step mutates** (the step assumes a fresh runner):
   `rm -rf node_modules` (or the lockfile/artifacts the step regenerates).
   A repro against dirty state "passes" for the wrong reason.
4. **Run it**: `bash /tmp/step.sh` from the repo root — CI-faithful output
   from the same commands, including `set -euo pipefail` and env lines that
   were part of the block.
5. Divergence between local repro and CI means you extracted the wrong block
   or missed a `env:`/`if:` at the step or job level — re-read the YAML.

## Guardrails

- Never "fix" the step by editing your extracted copy — fix the workflow YAML;
  the extraction is disposable evidence.
- If the step depends on secrets/inputs, stub them at the top of the copy and
  say so in the ticket; a stubbed repro is still command-faithful.
