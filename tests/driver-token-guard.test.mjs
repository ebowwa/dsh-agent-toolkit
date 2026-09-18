// driver-token-guard.test.mjs — the typed DOPPLER_SERVICE_TOKEN guard in
// run-dsh-agent.sh (PR #45 review finding 4) + the argv-leak class guard
// (issue #95).
//
// The agent launches only via `doppler run`, with the service token passed
// through the DOPPLER_TOKEN env, and there is no local-auth fallback. Before
// the typed guard, an unset token died at the launch line with a bare
// "unbound variable" AFTER installing dsh and probing cell tools; the env
// example even documented the token as optional — so a worker deployed per
// that example could never complete a task. The guard must be an EARLY,
// typed, cheap failure (exit 2) that runs before any tooling install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");

test("driver without DOPPLER_SERVICE_TOKEN fails typed (exit 2) before any work", () => {
  // The typed guard fires before the retry loop, so the backoff never
  // waits here — the seam is pinned anyway: every driver spawn pins it,
  // so a stub that starts failing degrades to instant attempts, never a
  // wedge (tests-lint rule 2; gates runs 34748403843/34788769043/
  // 34795917609/34803136058).
  const env = { ...process.env, DSH_RETRY_BACKOFF_S: "0" };
  delete env.DOPPLER_SERVICE_TOKEN;
  // Deliberately bare: the guard must fire before dsh install / cell-tool
  // probes, so no node/dsh/doppler availability is required here.
  const res = spawnSync("bash", [DRIVER, "some task"], {
    encoding: "utf8", env, timeout: 60_000,
  });
  assert.equal(res.status, 2, `expected typed exit 2 (got ${res.status})`);
  assert.match(res.stderr, /DOPPLER_SERVICE_TOKEN unset/);
  assert.ok(!res.stdout.includes("installing"), "guard must run BEFORE tooling install");
});

// The token-set path is pinned structurally in decouple-structure.test.mjs
// (F4) — spawning the full driver with a token would leave the hermetic
// regime (cell-tool probes, doppler, dsh install), which the offline suite
// must never do.

// --- issue #95: the token must never ride ARGV -----------------------------
//
// `doppler run --token T` puts the service token in the doppler process's
// argv — world-readable via ps / /proc/<pid>/cmdline to every local user for
// the process's whole lifetime (observed live on a Linux cell, 2026-09-18).
// environ is different: /proc/<pid>/environ is readable only by the same uid
// (or root) — the same exposure class as the caller-supplied
// DOPPLER_SERVICE_TOKEN the driver itself already holds. The fix hands the
// token to doppler's ENVIRONMENT via a bash prefix assignment (assignments
// never touch argv), using DOPPLER_TOKEN — the CLI's env input for --token
// (probed v3.76.0: a bogus DOPPLER_TOKEN reproduces --token's auth error
// exactly, while a bogus DOPPLER_SERVICE_TOKEN env is IGNORED — doppler
// falls through to local auth, so the ticket's original env-name guess
// would have silently stopped injecting secrets).
test("the doppler launch carries the token via env, never argv (issue #95 class guard)", () => {
  const src = readFileSync(DRIVER, "utf8");
  // No executable `doppler run --token` anywhere in the driver. (The
  // runtime-proof pins — doppler's env snapshot holds DOPPLER_TOKEN, every
  // argv snapshot is token-free — live in run-dsh-agent.test.mjs's
  // doppler-isolation test; this source pin catches a revert without
  // spawning anything.)
  assert.doesNotMatch(
    src,
    /doppler run --token/,
    "the driver must not pass the token on the doppler command line (world-readable argv)",
  );
  // The env handoff must sit ON the launch line: the bash prefix assignment
  // feeding the scope-isolation `env -u` chain.
  assert.match(
    src,
    /DOPPLER_TOKEN="\$DOPPLER_SERVICE_TOKEN" \\\nenv -u DOPPLER_PROJECT/,
    "the launch must hand DOPPLER_SERVICE_TOKEN to doppler's environment via a prefix assignment on the env -u chain",
  );
  // doppler passes its parent env THROUGH to the child (canary-verified
  // against the real CLI), so the child chain strips the DOPPLER_TOKEN env
  // input exactly like the raw DOPPLER_SERVICE_TOKEN — the agent must never
  // see either (an `env` tool call would ship it to the model provider).
  assert.match(
    src,
    /env -u DOPPLER_SERVICE_TOKEN -u DOPPLER_TOKEN -u DOPPLER_CONFIG/,
    "the child env chain must strip the DOPPLER_TOKEN env input too",
  );
});
