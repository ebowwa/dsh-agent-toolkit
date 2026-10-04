// prose.mjs — tolerant prose matching for doc-grading contract pins.
//
// Issue #270 class fix: contract pins that grade DOC RULES (not driver
// source, not command syntax) were written as case-sensitive,
// sentence-position-anchored regexes. A legitimate editorial reflow —
// capitalizing a clause that got split into its own sentence (the
// PR #268 receipt), rewrapping a paragraph, renumbering a checklist —
// red-lined CI with no pointer from the doc back to the pin grading it.
//
// foldProse() normalizes the DECORATION and PRESENTATION of prose so a
// pin anchored on a substantive clause fails only when the RULE
// disappears, not when the sentence moves:
//   - `**bold**` and `` `code` `` decoration is stripped (the words stay)
//   - all whitespace collapses to single spaces (line wraps stop mattering)
//   - case folds (mid-sentence vs standalone-sentence stops mattering)
//
// What deliberately stays strict: the clause itself. Reword the rule so
// the clause no longer appears — "milestone" becomes "label", the
// "(issue #185" attribution is dropped — and proseHas() returns false.
// Pins on driver source (the stamped task text is the deliverable),
// command syntax (`gh issue edit N --repo R --milestone "..."`), and
// structural anchors (## headings) stay raw asserts elsewhere — this
// helper is for doc RULE prose only.

/** Normalize prose for rule-clause matching: decoration off, wraps collapsed, case folded. */
export const foldProse = (text) =>
  text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold decoration off, words stay
    .replace(/`([^`]*)`/g, "$1") // code ticks off, words stay
    .replace(/\s+/g, " ") // line wraps and indentation collapse
    .toLowerCase(); // sentence position stops mattering

/**
 * True when `doc` carries the substantive `clause` under tolerant
 * matching. Pin docs with `assert.ok(proseHas(doc, "..."), "what rule")`.
 */
export const proseHas = (doc, clause) => foldProse(doc).includes(foldProse(clause));
