// post-reply.test.mjs — hermetic tests for scripts/post-reply.sh, the
// thread reply shared by the legacy workflow AND the decoupled worker.
// No network: a `gh` shim (PATH-prepended) logs the calls and the composed
// reply file is asserted. The reply surface is fail-closed SCRUBBED: a
// planted credential in the agent output must come out [redacted] and
// NEVER reach the composed reply.
// The retry ladder tests (issue #535) run with DSH_REPLY_BACKOFF_S: "0" —
// the driver-seam shape: the REAL bounded loop (attempts, classification,
// RC surfacing) with only the waits removed, so the suite never sleeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POST_REPLY = path.join(ROOT, "scripts", "post-reply.sh");
const SCRIPT = readFileSync(POST_REPLY, "utf8");
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "post-reply-test-"));
  const cache = path.join(dir, "cache");
  const shim = path.join(dir, "shim");
  const logs = path.join(dir, "logs");
  mkdirSync(cache, { recursive: true });
  mkdirSync(shim, { recursive: true });
  mkdirSync(logs, { recursive: true });

  const ghLog = path.join(logs, "gh.log");
  writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
exit 0
`);
  spawnSync("chmod", ["+x", path.join(shim, "gh")]);

  return { dir, cache, ghLog, shimDir: shim, logs,
    // statefulGh <behavior> — replaces the default shim with one that logs
    // every invocation, then runs <behavior> (a bash snippet; $n = the
    // 1-based invocation count persisted in $GH_STATE).
    statefulGh: (behavior) => {
      writeFileSync(path.join(shim, "gh"), `#!/usr/bin/env bash
echo "gh: $*" >> "$GH_LOG"
n=$(( $(cat "$GH_STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$GH_STATE"
${behavior}
`);
      spawnSync("chmod", ["+x", path.join(shim, "gh")]);
    },
    env: (extra = {}) => ({
      GH_TOKEN: "fake-token", DSH_SHIP_REPO: "owner/repo",
      TARGET_KIND: "issue", TARGET_NUM: "42", DSH_AGENT_TOOLKIT_DIR: ROOT,
      DSH_SHIP_CACHE: cache, DSH_AGENT_OUTPUT: path.join(cache, "dsh-agent-output.txt"),
      DSH_SHIP_NOTE: "shipped [branch](https://github.com/owner/repo/pull/999)",
      DSH_RUN_ID: "run123", DSH_RUNNER_NAME: "worker-t", DSH_REPLY_OUT: path.join(cache, "reply.md"),
      GH_LOG: ghLog, PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      ...extra,
    }) };
};

const TOO_QUICKLY = "GraphQL: was submitted too quickly (addComment)";
const SECONDARY = "HTTP 403: You have exceeded a secondary rate limit and have been temporarily blocked from content creation";

test("with ACK_COMMENT_ID the reply PATCHes the ack comment in place", () => {
  const f = fixture();
  try {
    // planted date: the reply comment is an OUTPUT surface (issue #152) —
    // the date must come out [redacted:date], never verbatim
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"),
      `finished on 2026-09-26. token ${TOKEN} is real\n`);
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8", env: f.env({ ACK_COMMENT_ID: "123" }),
    });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /comments\/123/);
    assert.match(log, /PATCH/);
    const reply = readFileSync(path.join(f.cache, "reply.md"), "utf8");
    assert.match(reply, /\*\*dsh agent\*\* — run: run123/);  // stamped header (no hardcoded model without meta)
    assert.match(reply, /run: run123 /);
    assert.match(reply, /finished/);
    assert.match(reply, /\[redacted:token\]/);
    assert.match(reply, /\[redacted:date\]/,
      "reply comments are output surfaces: dates redact by design (issue #152)");
    assert.ok(!reply.includes("2026-09-26"), "the raw date must never reach the posted reply");
    assert.ok(!reply.includes(TOKEN), "credential must never reach the composed reply");
    assert.match(reply, /Shipped.*pull\/999/s);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("without ACK_COMMENT_ID on a PR thread it posts a fresh PR comment", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    writeFileSync(path.join(f.cache, "dsh-ship-note.txt"), "shipped [b](https://github.com/owner/repo/pull/1)");
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8",
      env: f.env({ TARGET_KIND: "pr", TARGET_NUM: "7", DSH_SHIP_NOTE: "" }),
    });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.match(log, /pr comment 7/);
    assert.match(log, /--body-file/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("requires TARGET_KIND and DSH_SHIP_REPO (fails loudly, never posts blind)", () => {
  const f = fixture();
  try {
    const env = f.env({ TARGET_KIND: "" });
    delete env.TARGET_KIND;
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /TARGET_KIND/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("with driver meta present, the reply stamps the model + harness", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    writeFileSync(path.join(f.cache, "dsh-run-meta.env"),
      "DSH_RUN_MODEL=glm-5.3-flash\nDSH_RUN_PROVIDER=zai\nDSH_RUN_DSH_VERSION=0.1.0-rc.7\n");
    const res = spawnSync("bash", [POST_REPLY], {
      encoding: "utf8", env: f.env({ ACK_COMMENT_ID: "123" }),
    });
    assert.equal(res.status, 0, res.stderr);
    const reply = readFileSync(path.join(f.cache, "reply.md"), "utf8");
    assert.match(reply, /model: glm-5\.3-flash · harness: dsh-0\.1\.0-rc\.7/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- the reply write is the one output that must not be droppable (issue #535)

const retryEnv = (f, extra = {}) => f.env({
  DSH_REPLY_BACKOFF_S: "0",  // the test seam: the REAL loop, no waits
  GH_STATE: path.join(f.logs, "state"),
  ...extra,
});

test("retry: a transient platform block retries on the ladder and lands (issue #535)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    // the live receipt shape: GraphQL addComment blocked, then it clears
    f.statefulGh(`if [ "$n" -le 2 ]; then
  echo "${TOO_QUICKLY}" >&2
  exit 1
fi`);
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env: retryEnv(f) });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.equal((log.match(/gh: issue comment 42/g) || []).length, 3,
      "the blocked write retries until it lands: 2 blocks + 1 success");
    assert.match(res.stderr, /submitted-too-quickly block/);
    assert.match(res.stderr, /landed on attempt 3/);
    assert.ok(!/issues\/42\/comments -F/.test(log), "no REST fallback once the primary channel lands");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("retry: GraphQL stays blocked through the ladder → REST create-comment fallback lands", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    // the live receipt shape: GraphQL blocked through the wave, REST cleared
    f.statefulGh(`case "$1" in
  api) exit 0;;
  *) echo "${SECONDARY}" >&2
     exit 1;;
esac`);
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env: retryEnv(f) });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.equal((log.match(/gh: issue comment 42/g) || []).length, 4,
      "the full GraphQL ladder walks: 4 attempts");
    assert.match(log, /gh: api repos\/owner\/repo\/issues\/42\/comments -F body=@/,
      "the REST create-comment endpoint covers the issue thread");
    assert.match(res.stderr, /falling back to the REST create-comment channel/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("retry: total exhaustion is TYPED, non-zero, and the reply file survives (never silent)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"),
      `answer done on 2026-09-26, token ${TOKEN} redacts`);
    f.statefulGh(`echo "${SECONDARY}" >&2
exit 1`);
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env: retryEnv(f) });
    assert.notEqual(res.status, 0, "final failure must exit non-zero — never a silent drop");
    assert.match(res.stderr, /::error::.*FAILED after 4 attempts/);
    assert.match(res.stderr, /PRESERVED at .*reply\.md/,
      "the typed error names the preserved reply file");
    // the answer is recoverable: the composed reply survived both ladders
    const reply = readFileSync(path.join(f.cache, "reply.md"), "utf8");
    assert.match(reply, /answer done/);
    assert.match(reply, /\[redacted:token\]/);
    assert.ok(!reply.includes(TOKEN));
    const log = readFileSync(f.ghLog, "utf8");
    assert.equal((log.match(/gh: issue comment 42/g) || []).length, 4);
    assert.equal((log.match(/gh: api repos\/owner\/repo\/issues\/42\/comments/g) || []).length, 4,
      "the fallback walks its own full ladder before surfacing the typed error");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("retry: a NON-transient failure fails fast — one attempt, no ladder, no fallback", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    // 404-class: the thread is gone / wrong number — no backoff cures it
    f.statefulGh(`echo "GraphQL: Could not resolve to an Issue with the number 42" >&2
exit 1`);
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env: retryEnv(f) });
    assert.notEqual(res.status, 0);
    const log = readFileSync(f.ghLog, "utf8");
    assert.equal((log.match(/gh: issue comment 42/g) || []).length, 1,
      "fail fast stays fail fast: no retries on a deterministic error");
    assert.ok(!/issues\/42\/comments -F/.test(log),
      "a REST fallback cannot cure a 404 — the channel switch never runs");
    assert.match(res.stderr, /::error::.*NON-transient/);
    assert.match(res.stderr, /PRESERVED at/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("retry: the ack PATCH walks the same ladder (one comment per task holds)", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.cache, "dsh-agent-output.txt"), "done.\n");
    f.statefulGh(`if [ "$n" -le 2 ]; then
  echo "${TOO_QUICKLY}" >&2
  exit 1
fi`);
    const res = spawnSync("bash", [POST_REPLY], { encoding: "utf8", env: retryEnv(f, { ACK_COMMENT_ID: "123" }) });
    assert.equal(res.status, 0, res.stderr);
    const log = readFileSync(f.ghLog, "utf8");
    assert.equal((log.match(/gh: api repos\/owner\/repo\/issues\/comments\/123/g) || []).length, 3);
    assert.match(log, /PATCH/);
    assert.match(res.stderr, /landed on attempt 3/);
    assert.ok(!log.includes("issues/42/comments -F"),
      "no fresh-comment POST behind a failed PATCH — the one-comment UX holds");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("source pin: the production ladder is 4 attempts at 60/120/240 with the driver-seam override", () => {
  // the behavioral tests run the 0-seam, so the PRODUCTION defaults are only
  // pinned here — a silent re-tune of the ladder is an unowned change.
  assert.match(SCRIPT, /waits=\(60 120 240\)/,
    "issue #535 receipts: sub-minute retries NEVER cleared the block");
  assert.match(SCRIPT, /for attempt in 1 2 3 4/, "initial + 3 retries");
  assert.match(SCRIPT, /sleep "\$\{waits\[\$\(\(attempt-1\)\)\]\}"/);
  assert.match(SCRIPT, /DSH_REPLY_BACKOFF_S/,
    "the seam must exist for hermetic tests (mirrors the driver's DSH_RETRY_BACKOFF_S)");
  assert.match(SCRIPT, /issues\/\$\{TARGET_NUM\}\/comments/,
    "the REST fallback endpoint (a PR conversation comment IS an issue comment)");
  assert.match(SCRIPT, /::error::post-reply: \$label FAILED after 4 attempts/,
    "final failure is typed, never silent");
});
