// live-boot.mjs — the starvation-tolerant live dsh probe (issues #594, #595,
// #600, #607).
//
// The live legs in this repo spawn a REAL `dsh` child (`--profile headless
// ... reply ok`, `--dump-config`, `--dump-default-config`). Under the full
// suite's parallel file execution on a loaded box the child STARVES: the
// measured receipt (issue #594) is a 125s wall with EMPTY stdout AND stderr,
// so the assertion that follows reds on `(empty)` while a quiet single-file
// re-run on the SAME tree passes in ~50s. A red suite is signal; a starved
// child is load, not signal — and the difference is exactly "did the child
// produce ANY output at all".
//
// bootProbe() is that discriminator:
//
//   - spawn the child with the caller's exact argv/env/timeout;
//   - NO RETRY when it produced output: whatever it printed is a verdict the
//     caller's own assertions get to grade (a nonzero exit WITH a diagnostic
//     is a real failure and must not be papered over);
//   - ONE bounded retry when it produced NEITHER stream, or when the child
//     had to be killed at the timeout (status null / a signal / ETIMEDOUT):
//     that is the starvation shape, and the retry re-runs the same probe;
//   - the returned result is the LAST attempt, decorated with `attempts`,
//     `retried` and `starved` so a failure message can say which it was.
//
// The caller keeps every existing assertion, unchanged — bootProbe only
// removes the load-induced empty-output red from the grading path, it never
// turns a real failure green.

import { spawnSync } from "node:child_process";

const EMPTY = "";

const producedOutput = (res) =>
  `${res.stdout ?? EMPTY}${res.stderr ?? EMPTY}`.length > 0;

const killedAtTimeout = (res) =>
  res.status === null ||
  res.signal != null ||
  res.error?.code === "ETIMEDOUT";

export const STARVATION_NOTE =
  "the child produced NO output and was killed at its bound — the starvation shape (under load, not a verdict)";

/**
 * bootProbe({ command?, args?, options?, attempts?, onRetry? })
 *
 * @param command  the executable (default "dsh")
 * @param args     argv array
 * @param options  spawnSync options (encoding/timeout/env/cwd as-is)
 * @param attempts total attempts (default 2: the first, then ONE starvation retry)
 * @param onRetry  optional (attemptIndex, result) => void hook for a
 *                 load-naming note in the caller's output
 * @returns the LAST spawnSync result, with `.attempts` / `.retried` /
 *          `.starved` attached
 */
export function bootProbe({
  command = "dsh",
  args = [],
  options = {},
  attempts = 2,
  onRetry,
} = {}) {
  const total = Math.max(1, attempts);
  let res;
  let lastStarved = false;
  for (let attempt = 0; attempt < total; attempt++) {
    res = spawnSync(command, args, options);
    lastStarved = !producedOutput(res) || killedAtTimeout(res);
    if (!lastStarved) break;
    if (attempt < total - 1) {
      try {
        onRetry?.(attempt + 1, res);
      } catch {
        /* a hook must never mask the probe */
      }
    }
  }
  try {
    res.attempts = total;
    res.retried = lastStarved && total > 1;
    res.starved = lastStarved;
  } catch {
    /* spawnSync always returns a plain object; decoration is best-effort */
  }
  return res;
}

/** The failure-message tail every live leg should carry (load-naming). */
export function probeWhy(res) {
  const starved = res?.starved ? ` — ${STARVATION_NOTE} (attempts: ${res.attempts ?? 1})` : "";
  return starved;
}
