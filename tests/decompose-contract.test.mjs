// decompose-contract.test.mjs — contract fixtures for the fleet decomposition
// protocol (issue #114, the agent-side mirror of the factory#60 placement
// law): the parts table the exit summary must carry, and the
// self-contained-ticket rule every filed part must satisfy. Structural pins
// in the decouple-structure style: the driver INJECTS the protocol into
// every dispatched task, so a future edit that silently drops a step (plan
// first, fleet context, file-what-you-cannot, parts table) goes red here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(path.join(ROOT, p), "utf8");

const DRIVER = read("scripts/run-dsh-agent.sh");
const SKILL = read(".agents/skills/decompose-by-capability/SKILL.md");
const MANIFEST = read("config/fleet-manifest.md");

// --- 1. the protocol is injected into EVERY task by the driver -------------

test("driver injects the work-plan-first step (parts + capability class per part)", () => {
  assert.match(DRIVER, /## Work plan FIRST — decompose by fleet capability/);
  assert.match(
    DRIVER,
    /decompose this claim into PARTS and classify each part's\ncapability requirement/
  );
  // the not-done-planning rule is the step's exit condition (issue #114)
  assert.match(
    DRIVER,
    /an agent that cannot name which machines\ncan run a part is not done planning/
  );
  // injected AFTER the input scrub — driver-authored text, not caller text
  const scrubAt = DRIVER.indexOf("scrub-output.mjs");
  const blockAt = DRIVER.indexOf("## Work plan FIRST");
  assert.ok(scrubAt > -1 && blockAt > scrubAt, "protocol block must be assembled after the input scrub");
});

test("the five capability classes carry the factory#60 placement law", () => {
  for (const cls of ["mac-native", "linux-native", "language-default", "neutral", "heavy-compute"]) {
    assert.match(DRIVER, new RegExp(cls), `capability class ${cls} missing from the driver block`);
    assert.match(SKILL, new RegExp(cls), `capability class ${cls} missing from the skill contract`);
  }
  // OS affinity is absolute on both ends (factory#60 acceptance 2 + 3)
  assert.match(DRIVER, /macOS nodes ONLY/);
  assert.match(DRIVER, /Linux nodes ONLY/);
  // trait beats language (wrong-hardware dispatch is a standing mistake class)
  assert.match(DRIVER, /trait beats language/);
  // heavy-compute has its own lane; ghost-seat nodes are ineligible
  assert.match(DRIVER, /big lane only/);
  assert.match(DRIVER, /ghost seats is ineligible/);
});

test("standing fleet context: driver wires env snapshot + shipped registry", () => {
  // the live snapshot seam (caller-injected; runtime resources never baked
  // into a shipped file) and the standing file BOTH reach the prompt
  assert.match(DRIVER, /DSH_FLEET_MANIFEST/);
  assert.match(DRIVER, /config\/fleet-manifest\.md/);
  // the block lands inside the task, labeled for what it is
  assert.match(DRIVER, /## Standing fleet context \(node registry \+ placement law — factory#60\)/);
  // the standing registry itself: node table with OS + lanes, ghost-seat law
  assert.match(MANIFEST, /\| Nodes \| OS \| Lanes served \| Notes \|/);
  assert.match(MANIFEST, /mini-L1/);
  assert.match(MANIFEST, /seed-L3/);
  assert.match(MANIFEST, /ghost seats/i);
  assert.match(MANIFEST, /factory#60/);
});

// --- 2. the parts-table contract fixtures ----------------------------------

test("exit-summary parts table: exact columns, disposition vocabulary, filed-followups", () => {
  assert.match(DRIVER, /## Exit summary — the parts table \(mandatory\)/);
  // the exact table shape the exit summary must carry (one row per part)
  assert.match(DRIVER, /\| Part \| Class \| Disposition \| Target node class \| Why \|/);
  assert.match(DRIVER, /\|---\|---\|---\|---\|---\|/);
  // disposition vocabulary: executed here, or filed as #N — nothing else
  assert.match(DRIVER, /Disposition is \\"executed here\\" or \\"filed as #N\\"/);
  // every filed number is listed at the end (#113 exit-summary contract)
  assert.match(DRIVER, /filed-followups: line listing every issue number you filed/);
  // the skill teaches the same table (the contract outlives any one prompt)
  assert.match(SKILL, /\| Part \| Class \| Disposition \| Target node class \| Why \|/);
  assert.match(SKILL, /filed-followups/);
});

// --- 3. the self-contained-ticket rule --------------------------------------

test("filed parts are SELF-CONTAINED tickets (zero sibling context)", () => {
  // the #113 mechanism: file it, don't fix it in-claim
  assert.match(DRIVER, /gh issue create; title prefix \\"part: \\"/);
  assert.match(DRIVER, /agent-todo where it exists/);
  // the rule itself: a fresh agent holding only that ticket completes it
  assert.match(
    DRIVER,
    /The body is SELF-CONTAINED: a fresh agent holding only that ticket\n  completes it with ZERO sibling context/
  );
  // self-contained means: own goal, own receipts, own acceptance criteria,
  // own class + target — each named as a required body element
  assert.match(DRIVER, /own goal/);
  assert.match(DRIVER, /own receipts \(file:line,/);
  assert.match(DRIVER, /own acceptance criteria/);
  assert.match(DRIVER, /class: mac-native — target: mac lane/);
  // coupling phrases are banned by name — the exact failure the rule kills
  assert.match(DRIVER, /never \\"see the\n  other task\\", never \\"as described above\\"/);
  // and the skill states the rule standalone (the fixtures' source of truth)
  assert.match(
    SKILL,
    /\*\*SELF-CONTAINED\*\*: a fresh agent holding only that ticket\n  completes it with ZERO sibling context/
  );
  for (const el of ["the goal of the part", "receipts", "its own acceptance criteria", "the target capability class \\+ node class"]) {
    assert.match(SKILL, new RegExp(el), `self-contained body element missing: ${el}`);
  }
  assert.ok(!/see the other task[^\n]*allowed/.test(SKILL));
});

test("filing is routing: pile-gate honesty, no half-running, no scope-creep", () => {
  // #114 dependency: sub-tickets ride the pile gate until the comment
  // trigger is restored — the protocol must not assume instant sub-dispatch
  assert.match(DRIVER, /pile gate \(~1 day\)/);
  assert.match(DRIVER, /never assume instant\n  sub-dispatch and never block on a filed ticket/);
  // parts the agent CAN run, it runs — filing never ships less
  assert.match(DRIVER, /Parts this cell CAN legally and efficiently run: run them here\./);
  assert.match(DRIVER, /Filing is routing, not outsourcing/);
  // the skill carries the same honesty section
  assert.match(SKILL, /ride the pile\ngate \(~1 day\)/);
  assert.match(SKILL, /Never assume\ninstant sub-dispatch; never block on a filed ticket/);
});

test("the skill contract exists in .agents with the skill-file shape", () => {
  assert.match(SKILL, /^---\nname: decompose-by-capability\ndescription:/);
  assert.match(SKILL, /# Decompose the work by fleet capability/);
  // agent-side mirror of the router-side law — the framing the issue sets
  assert.match(SKILL, /agent-side mirror of the router-side placement law/);
});

// --- 4. behavioral half: the protocol reaches the MODEL, not just the file --

// Spawn harness modeled on search-compose-mount.test.mjs's runLauncher:
// stub cell tools, a recording dsh stub whose args file carries the full
// launch argv (the LAST argument is the assembled task), a persistent
// DSH_HOME. The launcher runs from a COPY so the manifest-absent case can
// construct absence without touching the working tree.
const materializeLauncher = (base, { withManifest = true } = {}) => {
  mkdirSync(path.join(base, "scripts"), { recursive: true });
  mkdirSync(path.join(base, "config"), { recursive: true });
  for (const f of ["run-dsh-agent.sh", "scrub-output.mjs"]) {
    cpSync(path.join(ROOT, "scripts", f), path.join(base, "scripts", f));
  }
  // settings template + the standing manifest the driver injects
  cpSync(path.join(ROOT, "config", "settings.zai.yaml"), path.join(base, "config", "settings.zai.yaml"));
  if (withManifest) {
    cpSync(path.join(ROOT, "config", "fleet-manifest.md"), path.join(base, "config", "fleet-manifest.md"));
  }
  return path.join(base, "scripts", "run-dsh-agent.sh");
};

const runLauncher = (extraEnv = {}, opts = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-decompose-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const runnerTemp = path.join(dir, "runner");
  const argsFile = path.join(dir, "dsh-args.txt");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(path.join(bin, "doppler"), "#!/bin/sh\nshift; shift\nexec \"$@\"\n");
  writeFileSync(
    path.join(bin, "dsh"),
    [
      "#!/bin/sh",
      'case "$1" in --version) echo "dsh-stub-0.0.0" >&2; exit 0;; esac',
      'printf "%s\\n" "$@" > "$STUB_ARGS_FILE"',
      "echo STUB-OK",
      "exit 0",
    ].join("\n") + "\n",
  );
  writeFileSync(path.join(bin, "zstd"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 0\n");
  for (const f of readdirSync(bin)) chmodSync(path.join(bin, f), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: runnerTemp,
    DOPPLER_SERVICE_TOKEN: "stub-token",
    DSH_HOME: home,
    DSH_PERSISTENT_HOME: "1",
    STUB_ARGS_FILE: argsFile,
    GH_BIN: path.join(bin, "gh"),
    DOPPLER_BIN: path.join(bin, "doppler"),
    CELL_PROBE_DIRS: "",
    // tests-lint rule 2: every driver spawn pins the retry seam (a failing
    // stub must degrade to instant attempts, never walk the production
    // 180s+600s backoff).
    DSH_RETRY_BACKOFF_S: "0",
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_ENV;
  delete env.RUNNER_NAME;
  delete env.DSH_MODEL;
  delete env.DSH_SUBAGENT_MODEL;
  delete env.DSH_FLEET_MANIFEST;
  delete env.DSH_SEARCH_COMPOSE;
  delete env.DSH_WEB_SEARCH_CELLS;
  Object.assign(env, extraEnv);

  const script = materializeLauncher(path.join(dir, "tk"), opts);
  const proc = spawnSync("bash", [script, "decompose contract test task"], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  const args = existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "";
  return { proc, dir, args };
  // dir left for the caller to rmSync (assertions read it after the spawn)
};

test("spawned driver: the protocol reaches the model's task text", () => {
  const { proc, dir, args } = runLauncher();
  try {
    assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
    // the task is the launcher's last argv; the parts-table contract rides it
    const task = args.trimEnd().split("\n--profile\n")[0];
    assert.match(task, /## Work plan FIRST — decompose by fleet capability/);
    for (const cls of ["mac-native", "linux-native", "language-default", "neutral", "heavy-compute"]) {
      assert.ok(task.includes(cls), `capability class ${cls} must reach the model`);
    }
    assert.match(task, /\| Part \| Class \| Disposition \| Target node class \| Why \|/);
    assert.match(task, /filed-followups:/);
    assert.match(task, /SELF-CONTAINED: a fresh agent holding only that ticket/);
    // standing fleet context injected from the shipped registry
    assert.match(task, /## Standing fleet context \(node registry \+ placement law — factory#60\)/);
    assert.match(task, /### Standing registry/);
    assert.match(task, /seed-L3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawned driver: a live DSH_FLEET_MANIFEST snapshot rides the task", () => {
  const { proc, dir, args } = runLauncher({ DSH_FLEET_MANIFEST: "live: 2 free seats on seed-L3, mini at 4/4" });
  try {
    assert.equal(proc.status, 0, `launcher must succeed, stderr: ${proc.stderr}`);
    const task = args.trimEnd().split("\n--profile\n")[0];
    assert.match(task, /### Live snapshot \(caller-injected\)/);
    assert.match(task, /2 free seats on seed-L3/);
    // live snapshot does not displace the standing registry or the law
    assert.match(task, /### Standing registry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawned driver: missing manifest degrades to protocol-only, never a wedged launch", () => {
  const { proc, dir, args } = runLauncher({}, { withManifest: false });
  try {
    assert.equal(proc.status, 0, `launcher must succeed even without the manifest file, stderr: ${proc.stderr}`);
    const task = args.trimEnd().split("\n--profile\n")[0];
    assert.doesNotMatch(task, /## Standing fleet context/);
    // the protocol itself still ships — planning is never untaught
    assert.match(task, /## Work plan FIRST — decompose by fleet capability/);
    assert.match(task, /\| Part \| Class \| Disposition \| Target node class \| Why \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
