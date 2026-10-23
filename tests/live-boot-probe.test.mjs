// live-boot-probe.test.mjs — the OFFLINE structural guard for the live-boot
// starvation class (issues #594, #595, #600, #607).
//
// The live dsh legs in this repo spawn REAL `dsh` children. Under the full
// suite's parallel file execution on a loaded box a child can STARVE (the
// #594 receipt: 125s wall, EMPTY output) and the assertion that follows reds
// on load rather than on a defect. `tests/lib/live-boot.mjs` (bootProbe) is
// the shared discriminator: ONE bounded retry when the child produced NO
// output at all, never a retry once it printed a verdict.
//
// This file is the guard that keeps the contract from regressing file by
// file. It is deliberately OFFLINE (text only) so it runs on every lane,
// dsh installed or not.
//
// Issue #607's lesson, built in: the first draft of a pin like this matched
// ONLY the double-quoted literal (`spawnSync("dsh"`), so a single-quoted or
// a hoisted-command leg re-introduced the class with the pin GREEN. The
// detector below covers both quote styles and an identifier command, and it
// is self-tested (negative controls) rather than trusted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "tests");

// THIS file is exempt from its own scan: it carries the evasion snippets as
// negative-control data (they are string literals here, never executed
// spawns) and the scan would otherwise flag its own fixtures. The exemption
// is explicit and singular — and the negative controls below prove the
// detector still bites on every form.
const SELF = "live-boot-probe.test.mjs";
const TEST_FILES = readdirSync(TESTS)
  .filter((f) => f.endsWith(".test.mjs") && f !== SELF)
  .sort();

// --- the detector -----------------------------------------------------------
// A spawnSync whose COMMAND is the literal "dsh" (any quote style)...
const literalDshSpawns = (src) => {
  const out = [];
  const re = /spawnSync\(\s*(["'`])dsh\1/g;
  let m;
  while ((m = re.exec(src))) out.push({ index: m.index, tail: src.slice(m.index, m.index + 90) });
  return out;
};

// ...or whose command is an IDENTIFIER (the hoisted-const evasion).
const identCommandSpawns = (src) => {
  const out = [];
  const re = /spawnSync\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g;
  let m;
  while ((m = re.exec(src))) out.push({ index: m.index, ident: m[1] });
  return out;
};

// The identifier's declaration RHS — used to prove a hoisted command does not
// resolve to `dsh` (a var-command spawn of `bash` is legitimate).
const declarationOf = (src, ident) => {
  const re = new RegExp(`^\\s*(?:const|let|var)\\s+${ident.replace(/\$/g, "\\$")}\\s*=([^\\n]*)`, "m");
  const m = re.exec(src);
  return m ? m[1] : null;
};

const isVersionProbe = (tail) => /^spawnSync\(\s*["'`]dsh["'`]\s*,\s*\[["'`]--version["'`]\]/.test(tail);

// --- the pins ---------------------------------------------------------------

test("no bare live dsh leg outside bootProbe: the only literal-dsh spawns are --version presence probes (issues #594/#595/#600)", () => {
  const offenders = [];
  for (const file of TEST_FILES) {
    const src = readFileSync(path.join(TESTS, file), "utf8");
    for (const hit of literalDshSpawns(src)) {
      if (!isVersionProbe(hit.tail)) {
        const line = src.slice(0, hit.index).split("\n").length;
        offenders.push(`${file}:${line} — ${hit.tail.split("\n")[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `every real dsh boot must ride bootProbe (tests/lib/live-boot.mjs), not a bare spawnSync:\n${offenders.join("\n")}`);
});

test("no hoisted-command dsh leg: an identifier command must not resolve to dsh (the #607 evasion)", () => {
  const offenders = [];
  for (const file of TEST_FILES) {
    const src = readFileSync(path.join(TESTS, file), "utf8");
    for (const hit of identCommandSpawns(src)) {
      const decl = declarationOf(src, hit.ident);
      const line = src.slice(0, hit.index).split("\n").length;
      if (decl === null) {
        offenders.push(`${file}:${line} — spawnSync(${hit.ident}, ...) has no resolvable declaration; name it explicitly or route it through bootProbe`);
      } else if (/dsh/i.test(decl)) {
        offenders.push(`${file}:${line} — spawnSync(${hit.ident}, ...) where ${hit.ident} = ${decl.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a hoisted dsh command re-introduces the starvation class with the pin green:\n${offenders.join("\n")}`);
});

test("the live legs ride the helper: every suite that boots a real dsh imports bootProbe", () => {
  for (const file of ["run-dsh-agent.test.mjs", "search-compose-mount.test.mjs", "session-query-mount.test.mjs"]) {
    const src = readFileSync(path.join(TESTS, file), "utf8");
    assert.match(src, /import \{ bootProbe, probeWhy \} from "\.\/lib\/live-boot\.mjs";/, `${file} must import the helper`);
    assert.match(src, /bootProbe\(\{/, `${file} must route its live legs through bootProbe`);
  }
});

test("negative controls: the detector catches what the old one missed (issue #607)", () => {
  // Every one of these is the SAME defect in a form the double-quoted-only
  // matcher stayed green on. If a future edit narrows the detector, this
  // reds instead of silently unenforcing the contract.
  const evasions = [
    `const nc1 = spawnSync('dsh', ["--profile", "headless", "reply ok"], { encoding: "utf8" });`,
    `const nc2 = spawnSync(\`dsh\`, ["--profile", "headless", "reply ok"], {});`,
    `const nc3 = spawnSync(\n      "dsh",\n      ["--profile", "headless", "reply ok"],\n      { encoding: "utf8" },\n    );`,
    `const DSH_CMD = "dsh";\n const nc4 = spawnSync(DSH_CMD, ["reply ok"], {});`,
    `const CMD = process.env.DSH_BIN;\n const nc5 = spawnSync(CMD, ["reply ok"], {});`,
  ];
  for (const snippet of evasions) {
    const literal = literalDshSpawns(snippet).filter((h) => !isVersionProbe(h.tail));
    const ident = identCommandSpawns(snippet).filter((h) => {
      const decl = declarationOf(snippet, h.ident);
      return decl !== null && /dsh/i.test(decl);
    });
    assert.ok(literal.length + ident.length > 0, `the detector MUST flag this evasion: ${JSON.stringify(snippet.slice(0, 60))}`);
  }
  // ...and it must NOT flag the legitimate non-dsh spawns in this suite
  const benign = `const BASH = resolveBin("bash");\nspawnSync(BASH, ["-c", "true"], {});\nspawnSync("chmod", ["+x", f]);\nspawnSync("dsh", ["--version"], { timeout: 30_000 });`;
  assert.equal(literalDshSpawns(benign).filter((h) => !isVersionProbe(h.tail)).length, 0, "a --version probe is not a live leg");
  const benignIdents = identCommandSpawns(benign).filter((h) => {
    const decl = declarationOf(benign, h.ident);
    return decl === null || /dsh/i.test(decl);
  });
  assert.equal(benignIdents.length, 0, "a hoisted bash command is legitimate");
});

test("the helper's own contract: one bounded retry on a starved child, none once output exists", async () => {
  const { bootProbe } = await import("./lib/live-boot.mjs");
  // a child that prints nothing and exits 0 — the starvation shape
  const silent = bootProbe({ command: process.execPath, args: ["-e", "0"], options: { encoding: "utf8" }, attempts: 2 });
  assert.equal(silent.attempts, 2, "an empty child is retried (attempts counts the retry)");
  assert.equal(silent.retried, true, "the retry is recorded for the failure message");
  assert.equal(silent.starved, true, "starved is named");
  // a child with a diagnostic — a VERDICT: never retried, never masked
  const loud = bootProbe({ command: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"], options: { encoding: "utf8" }, attempts: 2 });
  assert.equal(loud.retried, false, "a child that produced a diagnostic is NOT retried");
  assert.equal(loud.status, 3, "the real failure status survives the helper untouched");
  assert.match(loud.stderr, /boom/, "the diagnostic survives the helper untouched");
});
