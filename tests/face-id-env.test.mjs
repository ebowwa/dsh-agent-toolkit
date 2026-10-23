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
// `user-p<pid of the driver>` bare-shell fallback — the driver's OWN pid
// (issue #278: the launcher's PPID is per-PARENT, so concurrent sibling
// drivers of one shell minted one SHARED face — the foreign-face
// misattribution class this identity exists to close). Pinned statically
// (source contract) AND behaviorally (the stub dsh harness records the
// env the launch line carries).
//
// The both-namespaces arms below pin the LANDED #617 precedence, not the
// one this PR originally proposed (issue #614's ruling): an injected
// DISPATCH_FACE_ID is a SEPARATE face — it neither suppresses the ambient
// mint nor gets overwritten by the mirror — so these arms are the
// regression net for that contract and for the converge legs around it.
// #617 is merged; changing the precedence is its own PR with its own
// receipt, not a rebase side-effect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const SRC = readFileSync(DRIVER, "utf8");

test("run-dsh-agent.sh still parses (bash -n)", () => {
  assert.equal(spawnSync("bash", ["-n", DRIVER]).status, 0);
});

test("the driver keeps the LANDED #617 precedence: both namespaces exported, mint gated on DSH_FACE_ID alone (issue #614)", () => {
  assert.match(
    SRC,
    /if \[ -z "\$\{DSH_FACE_ID:-\}" \]; then/,
    "the ambient mint is gated on DSH_FACE_ID ALONE — an injected DISPATCH_FACE_ID must never suppress it (#617: two namespaces, two identities)",
  );
  // The export is load-bearing and it lives INSIDE the mint block: resolving
  // this hunk by side-picking silently drops it (the trap this rebase
  // measured as 4 pass / 3 fail). Pin the line itself.
  assert.match(SRC, /export DSH_FACE_ID\n?$/m, "the minted face is EXPORTED, not just assigned");
  assert.match(
    SRC,
    /if \[ -z "\$\{DISPATCH_FACE_ID:-\}" \] && \[ -n "\$\{DSH_FACE_ID:-\}" \]; then/,
    "the injected namespace is seeded from the ambient face only when it is EMPTY — an injection is never clobbered",
  );
  assert.match(SRC, /DISPATCH_FACE_ID="\$DSH_FACE_ID"/, "the ambient face is mirrored into the injected namespace");
  assert.match(SRC, /export DISPATCH_FACE_ID\n?$/m, "the injected twin is exported too");
  assert.doesNotMatch(
    SRC,
    /DSH_FACE_ID="\$\{DISPATCH_FACE_ID:-/,
    "the injected namespace must NOT be read back as the ambient face's source — that one-line rewrite (this PR's original shape) overrides the ambient face and the rebase reverted it to #617",
  );
});

test("derivation order: session id first, user-p<driver pid> fallback", () => {
  assert.match(SRC, /DSH_FACE_ID="\$DSH_SESSION_ID"/);
  // issue #278: the fallback rides the driver's OWN pid ($$) — fresh per
  // LAUNCH. The PPID form is the collision: per-parent, shared by every
  // concurrent sibling of one shell.
  assert.match(SRC, /DSH_FACE_ID="\$\{DSH_USER:-\$\{USER:-user\}\}-p\$\$"/);
  assert.doesNotMatch(SRC, /-p\$\{PPID\}/, "the PPID fallback must not come back (issue #278)");
});

test("the header env doc names DSH_FACE_ID with the issue citation", () => {
  assert.match(SRC, /^#   DSH_FACE_ID .*ebowwa\/factory#864/m);
  assert.ok(SRC.includes("ebowwa/factory#864"));
});

// Behavioral: drive the SEAM ITSELF — the exact block, extracted from the
// driver source so it cannot drift from what this test runs (a full driver
// boot needs doppler/runner plumbing out of scope here). The pin dies if
// the derivation order or the guard ever changes in the script.
const seamBlock = () =>
  SRC.slice(SRC.indexOf('if [ -z "${DSH_FACE_ID:-}" ]'), SRC.indexOf("DSH_VERSION="));

test("the seam mints user-p<driver pid> and never overrides an existing face", () => {
  // bash owns $$ — pin it for the extraction run so the assertion is
  // deterministic (the seam itself is unchanged in the driver source).
  const block = seamBlock().replace(/-p\$\$/, "-p85681");
  assert.ok(block.includes("export DSH_FACE_ID"));
  const run = (env) =>
    spawnSync("bash", ["-c", `${block}\nprintf "%s" "$DSH_FACE_ID"`], { env, encoding: "utf8" }).stdout;
  // bare shell: the fallback shape, derived from the driver pid passed in
  assert.match(run({ PATH: process.env.PATH, DSH_USER: "ebowwa" }), /^ebowwa-p85681$/);
  // session id wins over the fallback
  assert.equal(
    run({ PATH: process.env.PATH, DSH_SESSION_ID: "session-abc" }),
    "session-abc",
  );
  // a minted face (the node's agentEnvFor) is never overridden
  assert.equal(
    run({ PATH: process.env.PATH, DSH_FACE_ID: "sess-node-minted", DSH_SESSION_ID: "session-abc" }),
    "sess-node-minted",
  );
});

test("the landed #617 precedence, pinned behaviorally: the injection is a SEPARATE face, never a suppression", () => {
  // bash owns $$ — pin it for the extraction run (the seam itself is
  // unchanged in the driver source).
  const block = seamBlock().replace(/-p\$\$/, "-p85681");
  const runBoth = (env) =>
    spawnSync("bash", ["-c", `${block}\nprintf "%s %s" "$DSH_FACE_ID" "$DISPATCH_FACE_ID"`], {
      env,
      encoding: "utf8",
    }).stdout;
  // injected namespace only: the ambient mint STILL fires — the injection is
  // a distinct face on the driver's own launch, not a replacement for it (the
  // #617 receipt shape: `ebowwa-p<pid> | sess-node-injected`)
  assert.equal(
    runBoth({ PATH: process.env.PATH, DSH_USER: "ebowwa", DISPATCH_FACE_ID: "sess-node-injected" }),
    "ebowwa-p85681 sess-node-injected",
  );
  // both, divergent: two DIFFERENT faces, one per namespace — the operator's
  // ambient value is never overwritten by the injection, and the injection is
  // never clobbered by the mirror
  assert.equal(
    runBoth({ PATH: process.env.PATH, DSH_FACE_ID: "ambient-stale", DISPATCH_FACE_ID: "sess-node-injected" }),
    "ambient-stale sess-node-injected",
  );
  // operator ambient only: mirrored into the injected namespace, not dropped
  // (the sanitizer-proof twin a child reads — the whole reason #617 exists)
  assert.equal(
    runBoth({ PATH: process.env.PATH, DSH_FACE_ID: "sess-node-minted" }),
    "sess-node-minted sess-node-minted",
  );
});

test("the mint's face is EXPORTED — a CHILD process resolves it (the trap: the export sits inside the block a side-pick drops)", () => {
  const block = seamBlock().replace(/-p\$\$/, "-p85681");
  assert.ok(block.includes("export DSH_FACE_ID"), "the export rides the extracted seam (main's #617 shape)");
  // assignment without export is invisible to children — and children are the
  // entire point of the ambient identity (issue ebowwa/factory#864). Ask a
  // CHILD what it can see, never this shell's own variable.
  const child = spawnSync("bash", ["-c", `${block}\nenv | grep '^DSH_FACE_ID=' || true`], {
    env: { PATH: process.env.PATH, DSH_USER: "ebowwa" },
    encoding: "utf8",
  });
  assert.equal(
    child.stdout.trim(),
    "DSH_FACE_ID=ebowwa-p85681",
    "the minted face reaches a child env — main's export DSH_FACE_ID is restored, not dropped",
  );
});

test("concurrent sibling drivers of one parent mint DISTINCT faces (issue #278 — PPID is per-parent, not per-session)", () => {
  // The ticket's repro premise, verbatim shape:
  //   bash scripts/run-dsh-agent.sh "task A" &
  //   bash scripts/run-dsh-agent.sh "task B" &
  // Both children share ONE parent, so they shared ONE PPID — and under
  // the PPID form, ONE face: a claim/release by either was attributed to
  // both (the foreign-face misattribution class factory#864 exists to
  // close). Run the REAL seam block (extracted verbatim, nothing pinned —
  // the whole point is that $$ resolves per child process) as two
  // concurrent children of one parent bash; on the unfixed source both
  // write the parent's pid and this test goes red.
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-face-siblings-"));
  const script = path.join(dir, "seam.sh");
  writeFileSync(script, `${seamBlock()}\nprintf '%s' "$DSH_FACE_ID" > "$FACE_OUT"\n`);
  const outA = path.join(dir, "face-a");
  const outB = path.join(dir, "face-b");
  const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parent = spawnSync(
    "bash",
    ["-c", `FACE_OUT=${shq(outA)} bash ${shq(script)} & FACE_OUT=${shq(outB)} bash ${shq(script)} & wait`],
    { env: { PATH: process.env.PATH, DSH_USER: "ebowwa" }, encoding: "utf8" },
  );
  assert.equal(parent.status, 0, `the sibling repro must run clean, stderr: ${parent.stderr}`);
  const a = readFileSync(outA, "utf8");
  const b = readFileSync(outB, "utf8");
  assert.match(a, /^ebowwa-p\d+$/, `sibling A must mint the fallback shape from its own pid, got ${a}`);
  assert.match(b, /^ebowwa-p\d+$/, `sibling B must mint the fallback shape from its own pid, got ${b}`);
  assert.notEqual(
    a,
    b,
    "two concurrent sibling drivers of ONE parent must mint DISTINCT faces (issue #278) — the PPID form minted one shared face",
  );
  rmSync(dir, { recursive: true, force: true });
});
