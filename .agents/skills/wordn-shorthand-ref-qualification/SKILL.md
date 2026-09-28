---
name: wordn-shorthand-ref-qualification
description: Convert bare `word#N` shorthand refs in docs (which GitHub never autolinks) to `owner/repo#N` at fleet scale - census with a lookbehind-guarded regex, classify tower claim keys that must NOT be touched, API-verify every target number, and transform with perl (never sed). Use on any docs-sweep claim about unlinked issue/PR references.
---

# word#N shorthand ref qualification (autolink the docs sweep)

Distilled from the factory owner-less-ref sweep (2026-09-28): ~190 bare
`factory#N`-style refs across docs/ never autolinked because GitHub only
links `owner/repo#N`.

## Procedure

1. **Census**:

       grep -rnoE '[a-zA-Z][a-zA-Z0-9-]*#[0-9]+' docs/ --include='*.md'

   Exclude already-qualified `owner/repo#` lines and blockquote lines.
2. **Classify tokens before touching anything**: repo shorthands (`factory#`,
   `gat#`, `toolkit#`) get qualified; tower claim keys (`issue#N#todo`,
   `scout#`, `derived#`, `review#`) are IDENTIFIERS, not refs — keep them.
3. **API-verify every target number** (`gh api repos/<owner>/<repo>/pulls/N`
   or `/issues/N`) before editing: a typo'd numeral silently repoints the
   citation at a stranger.
4. **Transform with perl, not sed** — the negative lookbehind is mandatory or
   you double-prefix already-qualified forms sharing a line:

       perl -pi -e 's{(?<!/)\b(factory)#(\d+)}{ebowwa/$1#$2}g' docs/**/*.md

5. **Re-run the census; expect 0** unqualified repo-shorthand refs. Non-zero =
   missed forms (usually backticked or table-piped variants).

## Guardrails

- Commit the census diff separately from any prose edits so review can diff
  the mechanical pass against the editorial one.
