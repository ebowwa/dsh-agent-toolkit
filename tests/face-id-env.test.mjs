// face-id-env.test.mjs — the ambient session identity in run-dsh-agent.sh
// (issue ebowwa/factory#864): every spawned session's env carries
// DSH_FACE_ID — fresh per session, stable for the session's lifetime,
// children inherit — so a session's later step self-identifies as the
// face-lock holder instead of reading as a foreign face (the measured
// receipt incident: `face-lock release` refused the session's OWN claim
// because every later command ran as a fresh shell).
//
// Driver-side contract: an existing value wins (the node minted one in
// agentEnvFor); else the harness session id when one exists; else the
// `user-p<pid of the driver>` bare-shell fallback. Pinned statically
// (source contract) AND behaviorally (the stub dsh harness records the
// env the launch line carries).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const SRC = readFileSync(DRIVER, "utf8");

test("run-dsh-agent.sh still parses (bash -n)", () => {
  assert.equal(spawnSync("bash", ["-n", DRIVER]).status, 0);
});

test("the driver exports DSH_FACE_ID when absent, never overrides a minted one", () => {
  assert.match(SRC, /if \[ -z "\$\{DSH_FACE_ID:-\}" \]; then/);
  assert.match(SRC, /export DSH_FACE_ID\n?$/m);
});

test("derivation order: session id first, user-p<driver pid> fallback", () => {
  assert.match(SRC, /DSH_FACE_ID="\$DSH_SESSION_ID"/);
  assert.match(SRC, /DSH_FACE_ID="\$\{DSH_USER:-\$\{USER:-user\}\}-p\$\{PPID\}"/);
});

test("the header env doc names DSH_FACE_ID with the issue citation", () => {
  assert.match(SRC, /^#   DSH_FACE_ID .*ebowwa\/factory#864/m);
  assert.ok(SRC.includes("ebowwa/factory#864"));
});

// Behavioral: drive the SEAM ITSELF — the exact block, extracted from the
// driver source so it cannot drift from what this test runs (a full driver
// boot needs doppler/runner plumbing out of scope here). The pin dies if
// the derivation order or the guard ever changes in the script.
test("the seam mints user-p<driver pid> and never overrides an existing face", () => {
  const block = SRC.slice(SRC.indexOf('if [ -z "${DSH_FACE_ID:-}" ]'), SRC.indexOf("DSH_VERSION="))
    // bash owns PPID — pin it for the extraction run so the assertion is
    // deterministic (the seam itself is unchanged in the driver source).
    .replace(/\$\{PPID\}/, "85681");
  assert.ok(block.includes("export DSH_FACE_ID"));
  const run = (env) =>
    spawnSync("bash", ["-c", `${block}\nprintf "%s" "$DSH_FACE_ID"`], { env, encoding: "utf8" }).stdout;
  // bare shell: the fallback shape, derived from the driver pid passed in
  assert.match(run({ PATH: process.env.PATH, DSH_USER: "ebowwa" }), /^ebowwa-p85681$/);
  // session id wins over the fallback
  assert.equal(
    run({ PATH: process.env.PATH, DSH_SESSION_ID: "session-abc", PPID: "85681" }),
    "session-abc",
  );
  // a minted face (the node's agentEnvFor) is never overridden
  assert.equal(
    run({ PATH: process.env.PATH, DSH_FACE_ID: "sess-node-minted", DSH_SESSION_ID: "session-abc" }),
    "sess-node-minted",
  );
});
