// dsh-spawn-scan — the ONE structural matcher for the no-bare-live-leg
// contract, shared by both of its enforcers so they cannot drift:
// tests/live-boot-probe.test.mjs (the per-file count/shape pins) and
// scripts/tests-lint.mjs rule 3 (the corpus-wide shape lint).
//
// The contract (issues #594/#595/#600, pinned by the probe test): a real
// dsh leg in a test file must ride the shared bootProbe
// (tests/lib/live-boot.mjs) — its retry is the only thing keeping an
// under-load starvation red from grading as a real defect — and the only
// bare dsh spawn a test may carry is the fast `["--version"]` presence
// probe. The original pins matched the command ONLY as a double-quoted
// `spawnSync("dsh")` literal, so three evasion forms re-introduced the
// starvation class with the pin green (issue #607, plus the pr#603
// review receipt for the async form):
//   · quote form   — spawnSync('dsh', …) / spawnSync(`dsh`, …)
//   · variable cmd — const DSH = "dsh"; spawnSync(DSH, …)
//   · async family — spawn("dsh", …) / execFile("dsh", …)
//
// What the command position covers: spawnSync, spawn, execFileSync,
// execFile — the child_process calls whose FIRST argument is the
// command — each quote form ("dsh", 'dsh', `dsh`), and any identifier
// bound in-file to one of those literals (first-level alias:
// const/let/var NAME = "dsh"; the binding may sit anywhere in the file,
// so the scan is source-scoped, not line-based).
//
// Shapes out of reach, documented not pretended away (the tests-lint
// scope discipline): a command computed transitively (path.join(bin,
// "dsh") — the stub-executable shape, which is not a live leg), the
// exec/execSync forms (the command rides inside a shell string, a
// different geometry), a renamed import (const ss = spawnSync), and a
// `//` line whose tail carries a real call after a "https://…" URL
// (comment stripping is line-naive, same as the lint's). Commented text
// is dead: whole `//`/`*`/`#` lines and `//`-tails are stripped (columns
// preserved) before matching, so prose examples cannot mint sites.

const HEAD = /\b(?:spawnSync|execFileSync|execFile|spawn)\s*\(/g;

const ALIAS_DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])dsh\2/g;

/** The command position, immediately after the call's `(`: a dsh
 * literal in any quote form, or an identifier (resolved against the
 * file's dsh-bound aliases by the caller). */
const COMMAND = /^\s*(?:(["'`])dsh\1|([A-Za-z_$][\w$]*))/;

/** The sanctioned presence-probe shape: the command is followed, whitespace
 * aside, by a `["--version"]` argv (either quote form). */
const VERSION_ARG = /^\s*,\s*\[\s*(["'])--version\1\s*\]/;

const stripDeadText = (text) =>
  text
    .split("\n")
    .map((l) => {
      if (/^(\/\/|\*|#)/.test(l.trimStart())) return "";
      const cut = l.indexOf("//");
      return cut === -1 ? l : l.slice(0, cut);
    })
    .join("\n");

/**
 * Scan test-source text for bare dsh command spawns.
 * @param {string} source file contents (or a synthetic fixture)
 * @returns {{line: number, command: string, versionProbe: boolean}[]}
 *   every spawn/execFile-family site whose command is the dsh literal
 *   (any quote form) or a dsh-bound alias — `versionProbe` marks the
 *   sanctioned `["--version"]` presence-probe shape.
 */
export const dshSpawnScan = (source) => {
  const text = stripDeadText(source);
  const aliases = new Set();
  for (const m of text.matchAll(ALIAS_DECL)) aliases.add(m[1]);
  const sites = [];
  for (const m of text.matchAll(HEAD)) {
    const rest = text.slice(m.index + m[0].length);
    const cmd = COMMAND.exec(rest);
    if (!cmd) continue;
    const [, quote, name] = cmd;
    if (quote === undefined && !aliases.has(name)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    sites.push({
      line,
      command: quote !== undefined ? `dsh` : name,
      versionProbe: VERSION_ARG.test(rest.slice(cmd[0].length)),
    });
  }
  return sites;
};
