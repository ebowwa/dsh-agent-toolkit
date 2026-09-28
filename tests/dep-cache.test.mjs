// dep-cache.test.mjs — pins scripts/dep-cache.sh (issue #189).
//
// The cache is keyed on the sha256 of the checkout's lockfile(s); restore
// is best-effort and must never fail a claim. Tests run offline: installs
// go through DSH_DEP_INSTALL_CMD so no registry is ever contacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEP_CACHE = path.join(ROOT, "scripts", "dep-cache.sh");

const scenario = (lockfile, body = '"lockfile-v1"\n') => {
  const dir = mkdtempSync(path.join(tmpdir(), "dep-cache-test-"));
  const checkout = path.join(dir, "checkout");
  const cache = path.join(dir, "cache");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(path.join(checkout, "package.json"), '{"name":"t","private":true}\n');
  if (lockfile) writeFileSync(path.join(checkout, lockfile), body);
  return { dir, checkout, cache,
    env: (extra = {}) => ({
      DSH_DEP_CACHE_DIR: cache, HOME: dir,
      ...extra,
    }) };
};

const run = (args, env) =>
  spawnSync("bash", [DEP_CACHE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("parses clean (bash -n) — gates run this over scripts/", () => {
  const res = spawnSync("bash", ["-n", DEP_CACHE]);
  assert.equal(res.status, 0, res.stderr);
});

test("key is stable for the same lockfile and changes when the lockfile changes", () => {
  const a = scenario("bun.lock");
  const b = scenario("bun.lock");
  const c = scenario("bun.lock", '"lockfile-v2"\n');
  try {
    const ka = run(["key", a.checkout], a.env());
    const kb = run(["key", b.checkout], b.env());
    const kc = run(["key", c.checkout], c.env());
    assert.equal(ka.status, 0, ka.stderr);
    assert.equal(ka.stdout.trim(), kb.stdout.trim(), "identical lockfiles must share one cache key");
    assert.notEqual(ka.stdout.trim(), kc.stdout.trim(), "a lockfile change must invalidate the key");
  } finally {
    for (const s of [a, b, c]) rmSync(s.dir, { recursive: true, force: true });
  }
});

test("key covers WHICH lockfiles are present — bun.lock vs package-lock never collide", () => {
  const a = scenario("bun.lock");
  const b = scenario("package-lock.json");
  try {
    const ka = run(["key", a.checkout], a.env());
    const kb = run(["key", b.checkout], b.env());
    assert.notEqual(ka.stdout.trim(), kb.stdout.trim());
  } finally {
    for (const s of [a, b]) rmSync(s.dir, { recursive: true, force: true });
  }
});

test("restore MISS installs via DSH_DEP_INSTALL_CMD and WARMS the cache", () => {
  const s = scenario("bun.lock");
  try {
    const res = run(["restore", s.checkout], s.env({
      DSH_DEP_INSTALL_CMD: `mkdir -p node_modules/fake-pkg`,
    }));
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /cache MISS/);
    assert.match(res.stdout, /cache WARMED/);
    assert.ok(existsSync(path.join(s.checkout, "node_modules", "fake-pkg")));
    // and the cache entry holds the materialized node_modules
    const entries = spawnSync("find", [s.cache, "-name", "fake-pkg"], { encoding: "utf8" });
    assert.ok(entries.stdout.trim().length > 0, "cache must be populated after a MISS install");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("restore HIT copies node_modules from the cache without running any install", () => {
  const s = scenario("bun.lock");
  try {
    // warm: first pass installs and populates the cache
    const warm = run(["restore", s.checkout], s.env({
      DSH_DEP_INSTALL_CMD: `mkdir -p node_modules/fake-pkg`,
    }));
    assert.equal(warm.status, 0, warm.stderr);
    rmSync(path.join(s.checkout, "node_modules"), { recursive: true, force: true });
    // hit: an install command that would FAIL must never run on a hit
    const hit = run(["restore", s.checkout], s.env({
      DSH_DEP_INSTALL_CMD: `exit 3`,
    }));
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /cache HIT/);
    assert.ok(existsSync(path.join(s.checkout, "node_modules", "fake-pkg")),
      "node_modules must be restored from the cache on a hit");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("restore never fails the claim: a failing install still exits 0 (best-effort)", () => {
  const s = scenario("bun.lock");
  try {
    const res = run(["restore", s.checkout], s.env({
      DSH_DEP_INSTALL_CMD: `exit 9`,
    }));
    assert.equal(res.status, 0, "best-effort by contract — a failed install must not fail the claim");
    assert.match(res.stderr, /install failed/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("restore is a no-op without a lockfile (nothing to key on) and honors DSH_DEP_CACHE=off", () => {
  const none = scenario(null);
  const off = scenario("bun.lock");
  try {
    const r0 = run(["restore", none.checkout], none.env());
    assert.equal(r0.status, 0);
    assert.match(r0.stdout + r0.stderr, /no supported lockfile|nothing to do/);
    const r1 = run(["restore", off.checkout], off.env({ DSH_DEP_CACHE: "off" }));
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /disabled/);
    assert.ok(!existsSync(path.join(off.checkout, "node_modules")));
  } finally {
    for (const s of [none, off]) rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the worker wires the restore after the claim checkout (issue #189 fix surface)", () => {
  const worker = path.join(ROOT, "scripts", "dsh-worker.sh");
  const text = readFileSync(worker, "utf8");
  const checkoutIdx = text.indexOf("base-ref '$t_base' checkout fell back");
  const restoreIdx = text.indexOf("dep-cache.sh\" restore \"$work\"");
  assert.ok(checkoutIdx > 0 && restoreIdx > checkoutIdx,
    "dep-cache restore must run after the task checkout in task_item");
});
