// live-boot.mjs — the live dsh boot probe with a starvation retry
// (issue #594).
//
// The gates suite runs test FILES in parallel (node --test, glob form),
// and the live boot legs inside them spawn a REAL dsh boot (plugin-tree
// load + credential resolution, ~50s quiet). Under that parallel load the
// child can starve past its spawn budget and terminate with EMPTY stdout
// AND stderr — the measured flake (issue #594: two independent full-suite
// runs, 125s wall, empty output, red at the credential-wall match) while
// the SAME file's quiet single-file rerun is green on the same tree.
//
// The discriminator that makes a retry honest: a real defect PRINTS. The
// plugin-load failure shape the boot proof exists to catch (the alpha-line
// SessionSeq drift) dies loudly, and the credential wall itself prints
// MISSING_CREDENTIAL. An empty-output termination therefore carries no
// verdict about the tree — it is a starvation artifact — so it is retried
// ONCE before the caller's assertions see it; a diagnostic-bearing result
// comes back on the first attempt (never spend the retry budget on, and
// never mask, an honest failure).
//
// Pins for these contracts (offline, stub commands): tests/live-boot-probe.test.mjs.

import { spawnSync } from "node:child_process";

/**
 * True when the spawn result carries no diagnostic surface at all —
 * neither stream produced a byte. Whitespace-only counts: a boot that
 * reached any code path worth reporting would have named it.
 */
export function starvedBoot(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() === "";
}

/**
 * Run `spawnSync(command, args, { encoding: "utf8", ...options })` up to
 * `attempts` times (default 2), stopping at the first attempt whose
 * output is non-empty. Returns `{ boot, attemptsRan, starvationRetried }`
 * where `boot` is the LAST attempt's result — hand it to the same
 * assertions a bare spawnSync result fed, plus the retry bookkeeping for
 * the failure message (a twice-starved probe must be NAMED as box load,
 * not left looking like a tree defect).
 */
export function bootProbe({ command, args, options = {}, attempts = 2 }) {
  let boot;
  let ran = 0;
  let starved = true;
  while (ran < attempts && starved) {
    boot = spawnSync(command, args, { encoding: "utf8", ...options });
    starved = starvedBoot(boot); // a diagnostic-bearing result is a verdict — first attempt wins
    ran++;
  }
  return { boot, attemptsRan: ran, starvationRetried: ran > 1 };
}
