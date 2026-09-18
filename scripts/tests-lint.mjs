#!/usr/bin/env node
// tests-lint.mjs — structural lint for test sources, no dependencies.
//
// Regression anchor: gates run 32933615526 (PR #27, commit 8557fb5). Its
// "no doppler CLI on the runner falls back" test constructed doppler's
// ABSENCE by restricting the child PATH to `<shimdir>:/usr/bin:/bin` —
// but the dsh lanes install the real doppler CLI in a system dir that
// this restricted PATH still traverses. command -v doppler succeeded,
// the resolver took the live-fetch branch, printed "doppler fetch
// failed" where the test demanded "no doppler cli/service token", and
// gates went red ON THE LANE ONLY: on the author's dev machine doppler
// lives in /opt/homebrew/bin, outside that PATH, so the same suite was
// green there and the landmine shipped. Nothing between "green on my
// machine" and "red on the lane" caught the pattern — this tool does.
//
// What it checks (line-based, single concern per rule):
//
// Rule 1 — a PATH assignment (JS `PATH:` property or shell `PATH=` inside
//     an embedded script string) whose value hard-codes literal absolute
//     path components AND does not re-include the ambient PATH
//     (`process.env.PATH` / `$PATH` / `${PATH}`) is an error: on the
//     dsh lanes the real CLIs (doppler, gh) are installed in system
//     dirs, so such a PATH constructs nothing. Absence of a
//     lane-installed CLI is built soundly either with an explicit BIN
//     seam (e.g. DOPPLER_BIN=/nonexistent/...) or with a fully hermetic
//     PATH whose only entries are prepared shim dirs, runtime-
//     interpolated, with no system dir traversed and the ambient PATH
//     not re-included — nothing outside the prepared dirs can be found,
//     which is how tests/resolve-push-token.test.mjs constructs it
//     (blessed review r2 finding 5; the DOPPLER_BIN seam that repo
//     gained in 7dd6d21 is gone). Presence is constructed soundly by
//     PREPENDING a shim dir to the ambient PATH, which shadows
//     everywhere.
//
// Rule 2 — a test that spawns scripts/run-dsh-agent.sh must pin
//     `DSH_RETRY_BACKOFF_S` in the env it passes. The driver's failure
//     path walks the production retry backoff (PR #85 throttle wave:
//     180s + 600s), so a test whose agent stub FAILS cannot complete
//     inside any sane spawn budget: spawnSync kills the driver
//     mid-backoff, `status` comes back null, and the suite wedges —
//     gates runs 34748403843, 34788769043, 34795917609, and finally
//     34803136058, where the failure-path contract test itself died
//     (`null !== 1` at its own 60s budget). PR #88 added the seam and
//     pinned it where the stub fails; this rule keeps the CLASS out:
//     every driver spawn pins the seam, so a stub that starts failing
//     tomorrow degrades to three instant attempts instead of a
//     13-minute-per-test wedge. `DSH_RETRY_BACKOFF_S: "0"` keeps the
//     REAL bounded loop (3 attempts, RC surfacing, cleanup) — only the
//     waits go.
//
// Scope note: every rule here is line-based — catch the observed defect
// class, not the universe. Rule 2 sees a spawn whose command is bash/sh
// and whose first script argument is the driver path literal or a
// same-file `const`/`let` initialized from it. Shapes it cannot see are
// documented, not pretended away: a harness parameter fed from a
// helper's `return path.join(...)` (the search-compose-mount shape —
// its spawn is pinned manually there), `bash -c` extractions that only
// READ the script (cell-tools), and `bash -n` syntax checks never
// execute the driver and are not spawns for this purpose. Comment
// lines (//, *, #) are skipped — the corpus scan in
// tests/tests-lint.test.mjs keeps false positives at zero on every
// shipped test file. A multi-line value whose literal lands on the
// continuation line is out of scope for the same reason every lint
// here is line-based.

import { readFileSync } from "node:fs";

/** Ambient-PATH re-inclusion: the assignment composes with the runner's
 * PATH instead of pretending to replace it — sound on every machine. */
const AMBIENT = /process\.env\.PATH|\$\{?PATH\}?(?!\w)/;

/** A PATH assignment: `PATH:` (JS object property) or `PATH=` (shell).
 * The leading group keeps process.env.PATH reads and $PATH / ${PATH}
 * expansions from counting as assignments. */
const ASSIGNMENT = /(^|[^\w${])PATH\s*[:=]\s*(.*)$/;

/** Literal absolute path components still present after ${...}
 * interpolations are stripped (a shim dir reference like ${dir} never
 * counts — only hard-coded system paths do). */
const literalAbsPaths = (value) => {
  const stripped = value.replace(/\$\{[^}]*\}/g, "");
  const found = [];
  const re = /(?:^|[\s"'`,:;(])((?:\/[\w.-]+)+)/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) found.push(m[1]);
  return found;
};

// --- rule 2 helpers: the driver-spawn backoff seam ------------------------

const DRIVER_SCRIPT = "run-dsh-agent.sh";

/** A spawn call head: `spawnSync(` or `spawn(` — word-bounded so other
 * names ending in "spawn" don't match. */
const SPAWN_CALL = /\b(?:spawnSync|spawn)\s*\(/;

/** Spawn geometry that can EXECUTE a script file: command bash/sh, then
 * an array literal. (`bash -c "…"` runs a string, `bash -n` only parses,
 * and sed/tar/python3 only read or ignore the file — none of them runs
 * the driver's main flow.) */
const BASH_ARRAY_HEAD = /^\(\s*(["'])(?:bash|sh)\1\s*,\s*\[/;

/** The seam pin: the env key with a value (`DSH_RETRY_BACKOFF_S: "0"`). */
const SEAM_PIN = /\bDSH_RETRY_BACKOFF_S\s*:/;

const isCommentLine = (raw) => /^(\/\/|\*|#)/.test(raw.trimStart());

const constDeclInitializer = (raw, name) => {
  const m = new RegExp(`^\\s*(?:const|let)\\s+${name}\\s*=\\s*(.+)$`).exec(raw);
  return m ? m[1] : null;
};

/** ${...} interpolations would pollute paren/brace counting. */
const stripInterpolations = (s) => s.replace(/\$\{[^}]*\}/g, "");

/** A pin inside a `//` comment is dead text — strip before matching.
 * (Line-based scope: a "https://…" URL in the same window loses its
 * tail, which no check here reads.) */
const stripLineComments = (multiLine) =>
  multiLine
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

/** Walk `text` from `from` (which sits ON an opener) to its matching
 * closer; returns the full `(...)`/`{...}` text, or null when unbalanced
 * (a syntax error the test run owns, not this lint). */
const balancedFrom = (text, from, open, close) => {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
};

/** The spawn-call windows of a file: `spawnSync(...)`/`spawn(...)` texts
 * with their start line. A window consumes its own arguments, so a
 * spawn named inside another call's argv template is not re-scanned. */
const spawnWindows = (lines) => {
  const windows = [];
  let i = 0;
  while (i < lines.length) {
    if (!isCommentLine(lines[i]) && SPAWN_CALL.test(lines[i])) {
      const head = SPAWN_CALL.exec(lines[i]);
      const start = head.index + head[0].length - 1;
      let j = i;
      let found = null;
      while (j < lines.length && !found) {
        found = balancedFrom(
          stripInterpolations(lines.slice(i, j + 1).join("\n")),
          start,
          "(",
          ")",
        );
        j++;
      }
      windows.push({ line: i + 1, text: found ?? lines.slice(i).join("\n") });
      i = j;
      continue;
    }
    i++;
  }
  return windows;
};

/** The first element of a spawn's argv array, or null when the call does
 * not have the `bash/sh [script, …]` geometry that runs a script file. */
const firstScriptArg = (winText) => {
  const m = BASH_ARRAY_HEAD.exec(winText);
  if (!m) return null;
  const rest = winText.slice(m[0].length);
  let depth = 0;
  let q = null;
  let elem = "";
  for (const ch of rest) {
    if (q) {
      elem += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      elem += ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") {
      depth++;
      elem += ch;
      continue;
    }
    if (ch === "]" || ch === ")" || ch === "}") {
      if (depth === 0) break;
      depth--;
      elem += ch;
      continue;
    }
    if (ch === "," && depth === 0) break;
    elem += ch;
  }
  return elem.trim();
};

/** Resolve the env a spawn's options pass: an inline `env: { … }`
 * literal, `env: NAME`, or the `{ env, … }` shorthand. Returns the
 * literal text, null when NO env is passed at all, or undefined when an
 * identifier form is present but its object literal cannot be resolved
 * in-file — the caller fails closed on undefined. */
const envPassedToSpawn = (winText, lines, winLine) => {
  const inline = /\benv\s*:\s*\{/.exec(winText);
  if (inline) {
    const at = winText.indexOf("{", inline.index);
    return balancedFrom(winText, at, "{", "}");
  }
  // `env: NAME,` / `env: NAME}` / `env: NAME(` — the call shape has no
  // resolvable object literal, so it resolves as an unknown identifier
  // and fails closed below.
  const named = /\benv\s*:\s*([A-Za-z_$][\w$]*)\s*[(,}]/.exec(winText);
  const shorthand = /[{,]\s*env\s*[,}]/.exec(winText);
  const name = named ? named[1] : shorthand ? "env" : null;
  if (!name) return null;
  for (let i = winLine - 2; i >= 0; i--) {
    if (isCommentLine(lines[i])) continue;
    const init = constDeclInitializer(lines[i], name);
    if (!init) continue;
    const eqAt = lines[i].indexOf("=");
    const braceAt = lines[i].indexOf("{", eqAt);
    if (braceAt === -1) return undefined;
    const literal = balancedFrom(
      stripInterpolations(lines.slice(i).join("\n")),
      braceAt,
      "{",
      "}",
    );
    return literal ?? undefined;
  }
  return undefined;
};

/**
 * Lint one test-source file's text.
 * @param {string} text file contents
 * @param {string} name file name (for error messages)
 * @returns {{line: number, message: string}[]} errors, empty when clean
 */
export const lintTests = (text, name) => {
  const errors = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    // comments are dead text: JS // and block-comment bodies, shell #
    if (/^(\/\/|\*|#)/.test(trimmed)) continue;
    const m = ASSIGNMENT.exec(lines[i]);
    if (!m) continue;
    const value = m[2];
    if (AMBIENT.test(value)) continue;
    const literals = literalAbsPaths(value);
    if (!literals.length) continue;
    errors.push({
      line: i + 1,
      message: `${name}:${i + 1}: PATH hard-codes ${literals.map((l) => `'${l}'`).join(", ")} without re-including the ambient PATH — the dsh lanes install the real CLIs (doppler, gh) in system dirs, so this restriction constructs no absence and a test riding it passes on a dev machine but takes the wrong branch on a lane (gates run 32933615526). Prepend to the ambient PATH (…:\${process.env.PATH}) or construct absence with an explicit BIN seam (e.g. DOPPLER_BIN=/nonexistent/…) or a hermetic PATH of prepared dirs only (no system dir, ambient not re-included).`,
    });
  }

  // --- rule 2: every spawn of run-dsh-agent.sh pins DSH_RETRY_BACKOFF_S ---
  const driverConsts = new Set();
  for (const raw of lines) {
    if (isCommentLine(raw)) continue;
    const init = constDeclInitializer(raw, "[A-Za-z_$][\\w$]*");
    if (init && init.includes(DRIVER_SCRIPT)) {
      driverConsts.add(new RegExp("^\\s*(?:const|let)\\s+([A-Za-z_$][\\w$]*)").exec(raw)[1]);
    }
  }
  for (const win of spawnWindows(lines)) {
    const scriptArg = firstScriptArg(win.text);
    if (scriptArg === null) continue;
    const runsDriver =
      scriptArg.includes(DRIVER_SCRIPT) || driverConsts.has(scriptArg);
    if (!runsDriver) continue;
    const env = envPassedToSpawn(win.text, lines, win.line);
    // null = no env passed at all; undefined = unresolvable identifier —
    // both fail closed (only a RESOLVED literal containing the pin skips).
    if (env != null && SEAM_PIN.test(stripLineComments(env))) continue;
    errors.push({
      line: win.line,
      message:
        env === undefined
          ? `${name}:${win.line}: a spawn of ${DRIVER_SCRIPT} passes an env this lint cannot resolve in-file — pin \`DSH_RETRY_BACKOFF_S: "0"\` in the env object this spawn passes, or the driver's failure path walks the production retry backoff (180s+600s) and a failing stub wedges the suite past any spawn budget until spawnSync kills the driver (status null; gates runs 34748403843, 34788769043, 34795917609, 34803136058).`
          : `${name}:${win.line}: a spawn of ${DRIVER_SCRIPT} (${scriptArg}) does not pin DSH_RETRY_BACKOFF_S — the driver's failure path walks the production retry backoff (180s+600s), so a failing stub wedges the suite past any spawn budget until spawnSync kills the driver (status null; gates runs 34748403843, 34788769043, 34795917609, 34803136058). Set \`DSH_RETRY_BACKOFF_S: "0"\` in the env this spawn passes: it keeps the REAL bounded loop (3 attempts, RC surfacing, cleanup) and removes only the waits.`,
    });
  }
  return errors;
};

/** CLI: one or more test files; exit 1 with per-line errors if any fail. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error("usage: tests-lint.mjs <test.mjs> [more.test.mjs ...]");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch (e) {
      console.error(`tests-lint: cannot read ${f}: ${e.message}`);
      bad++;
      continue;
    }
    for (const { message } of lintTests(text, f)) {
      console.error(message);
      bad++;
    }
  }
  if (bad) process.exit(1);
}
