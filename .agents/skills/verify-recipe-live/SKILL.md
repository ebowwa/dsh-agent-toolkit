---
name: verify-recipe-live
description: Before landing rules-file / rulebook / docs text that prescribes a side-effecting shell command agents will copy-paste, run the EXACT command shape once against a small visible target and trace where its side effects land. Use when writing or editing agent rulebooks, runbooks, or guard docs that embed commands.
---

# Verify the recipe live (run the prescribed command before shipping it)

Docs that prescribe commands are executed by future agents verbatim. A
plausible-looking command that was never run ships a defect to every reader.

## Procedure

1. **Run the EXACT command shape once** against a small visible repo or
   scratch checkout — not a paraphrase, not from memory. Copy-paste drift is
   itself the defect class.
2. **Trace where side effects land relative to any gate that walks the tree.**
   Example trap: a verify command that writes artifacts into the repo turns
   the next full-tree test sweep into a red herring — the sweep globs the
   artifact. If side effects land inside the tree, the doc must add the
   cleanup line or redirect to a scratch path.
3. **Check the command exists at the documented path** with the documented
   name: script renamed, key renamed, subcommand moved — run it, don't trust
   the package manifest or an older doc.
4. **Land the receipt in the doc**: one line stating the command was run live
   at head <sha> and what it printed. The next editor then knows the recipe
   was real, not aspirational.

## Pitfalls

- Compound recipes (`cd x && generate && test`) break at the first renamed
  segment; verify each segment, not just the chain.
- A recipe that only works with repo-local state (built artifacts, generated
  fixtures) must say so — fresh-clone readers die on step one.
