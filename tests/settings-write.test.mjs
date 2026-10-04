// settings-write.test.mjs — pins for the agent template's PRESERVE-BY-
// DEFAULT settings write (FleetTower #642).
//
// Regression anchor: the driver's settings block (run-dsh-agent.sh)
// REGENERATED $DSH_HOME/settings.yaml on every spawn — stamped-template
// overwrite + a `|| cp` fallback — dropping every key the template does
// not manage (nested provider routes, per-route credential pins) and
// following symlinks into the user's own file (FleetTower #640: the
// air16 clobber class, three stomps 2026-09-21/28/30). These tests fail
// without the fix: the unit pins are the merge-preserve contract
// (ported with the tower lib, FleetTower #641), the CLI pins drive the
// REAL helper the driver spawns, and the source pin makes the driver's
// wiring + the deleted fallback impossible to regress silently.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { preserveUnknownRoutes, normalizeWritePreserving, isPlainObject } from "../scripts/settings-normalize.mjs";
import { checkLaneSettings, laneSettingsPath } from "../scripts/lane-settings-guard.mjs";
import { resolveYaml, runWrite, stampModel } from "../scripts/settings-write.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(ROOT, "scripts", "settings-write.mjs");
const DRIVER = path.join(ROOT, "scripts", "run-dsh-agent.sh");
const TEMPLATE = path.join(ROOT, "config", "settings.zai.yaml");

// ── the user's multi-provider file shape (FleetTower #640 body) ─────
// opencode-go + opencode-go-2 with NESTED routes, each route carrying
// its own credential pin, plus zai and ablit providers and session
// defaults — the exact classes the rc.7 normalizer and the old
// regenerate-by-overwrite dropped.
const USER_SETTINGS = {
  model: "glm-5.3-flash",
  session: { defaultModel: "opencode-go/kimi-k2", defaultAgent: "dsh" },
  providers: {
    "opencode-go": {
      type: "openai",
      api: "https://opencode.example/api/v1",
      apiKey: "pin:oc-go-main",
      routes: {
        "kimi-k2": { model: "kimi-k2", credential: "pin:oc-go-kimi", context: 131072 },
        "deepseek-v3": { model: "deepseek-v3", credential: "pin:oc-go-ds", context: 65536 },
      },
    },
    "opencode-go-2": {
      type: "openai",
      api: "https://opencode2.example/api/v1",
      apiKey: "pin:oc-go2-main",
      routes: {
        "glm-5.3-flash": { model: "glm-5.3-flash", credential: "pin:oc-go2-glm", context: 200000 },
      },
    },
    zai: { type: "anthropic", api: "https://zai.example", apiKey: "pin:zai" },
    ablit: { type: "openai", api: "https://ablit.example", apiKey: "pin:ablit" },
  },
};

// ── the hostile normalizer: flat catalog in, user routes out — what ─
// the rc.7 user-layer write (and the old overwrite) did every spawn.
function rc7StyleNormalizer(_current) {
  return {
    model: "glm-5.3-flash",
    session: { defaultAgent: "dsh" },
    providers: {
      zai: { type: "builtin-zai-catalog", models: ["glm-5.3-flash"] },
    },
  };
}

const canonical = (v) => JSON.stringify(sortDeep(v));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (isPlainObject(v)) {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}

function tmpHome(label) {
  const home = mkdtempSync(path.join(tmpdir(), `settings-write-${label}-`));
  const lane = path.join(home, ".dsh-open");
  mkdirSync(lane, { recursive: true });
  return { home, lane, settings: laneSettingsPath(lane) };
}

// ── 1. the merge-preserve contract (ported lib) ──────────────────────

describe("settings-normalize — preserve unknown/nested provider routes (FleetTower #642)", () => {
  test("BARE normalize DROPS the routes (the defect, pinned as regression baseline)", () => {
    const out = rc7StyleNormalizer(USER_SETTINGS);
    assert.equal(out.providers["opencode-go"], undefined);
    assert.equal(out.providers["opencode-go-2"], undefined);
  });

  test("preserveUnknownRoutes carries EVERY unknown/nested route + per-route credential pin through", () => {
    const merged = preserveUnknownRoutes(rc7StyleNormalizer(USER_SETTINGS), USER_SETTINGS);
    // the normalizer's own keys stand (it manages model/catalog glue)
    assert.equal(merged.model, "glm-5.3-flash");
    assert.equal(merged.providers.zai.type, "builtin-zai-catalog");
    // ...and the user's routes are byte-equivalent, at full depth
    assert.equal(canonical(merged.providers["opencode-go"]), canonical(USER_SETTINGS.providers["opencode-go"]));
    assert.equal(canonical(merged.providers["opencode-go-2"]), canonical(USER_SETTINGS.providers["opencode-go-2"]));
    assert.equal(canonical(merged.providers.ablit), canonical(USER_SETTINGS.providers.ablit));
    // per-route credential pins survive
    assert.equal(merged.providers["opencode-go"].routes["kimi-k2"].credential, "pin:oc-go-kimi");
    assert.equal(merged.providers["opencode-go-2"].routes["glm-5.3-flash"].credential, "pin:oc-go2-glm");
    // user session keys the normalizer does not set survive
    assert.equal(merged.session.defaultModel, "opencode-go/kimi-k2");
    // no catalog glue duplication (the stomped file carried zai TWICE)
    assert.equal(Object.keys(merged.providers).filter((k) => k === "zai").length, 1);
  });

  test("an IDEMPOTENT second pass changes nothing (normalize-write is stable, no glue stacking)", () => {
    const once = preserveUnknownRoutes(rc7StyleNormalizer(USER_SETTINGS), USER_SETTINGS);
    const twice = preserveUnknownRoutes(rc7StyleNormalizer(once), once);
    assert.equal(canonical(twice), canonical(once));
  });
});

// ── 1b. OWN-key membership (issue #330 — the FleetTower #791 class) ──
// The preserve loop's membership test must be an OWN-key test. `key in
// out` consults the prototype chain, so a user key named `constructor`,
// `toString`, `hasOwnProperty`, … read as "the normalizer set it", was
// never copied, and silently dropped from the written file (Object
// entries/stringify only ever see OWN keys). The module contract says
// EVERY original key the normalizer did not set, at ANY depth, rides
// through untouched — a route literally named `toString` is a legal
// YAML settings shape and must survive a normalize-write. Ported from
// the tower-side fix (FleetTower #791 / PR #903) verbatim-class.

describe("settings-normalize — prototype-named keys survive (issue #330, the FleetTower #791 class)", () => {
  test("TOP-LEVEL keys named like Object.prototype members carry through (the issue #330 repro)", () => {
    const normalized = { model: "glm-5.3", providers: { zai: {} } };
    const original = {
      constructor: "user-value",
      toString: { api: "https://x", pin: "secret-pin" },
      hasOwnProperty: 7,
      valueOf: null,
      myRoute: { keep: true },
    };
    const merged = preserveUnknownRoutes(normalized, original);
    assert.equal(merged.constructor, "user-value");
    assert.equal(canonical(merged.toString), canonical(original.toString));
    assert.equal(merged.hasOwnProperty, 7);
    assert.equal(merged.valueOf, null);
    assert.equal(canonical(merged.myRoute), canonical(original.myRoute));
    // they are OWN keys now (they serialize; inherited ones never do)
    for (const k of ["constructor", "toString", "hasOwnProperty", "valueOf", "myRoute"]) {
      assert.equal(Object.hasOwn(merged, k), true);
    }
    // the normalizer's own keys still stand
    assert.equal(merged.model, "glm-5.3");
    assert.equal(Object.hasOwn(merged.providers, "zai"), true);
  });

  test("a key the normalizer SET wins even when prototype-named — own-set beats prototype-consult, not the user", () => {
    const normalized = { toString: { set: "by-normalizer" } };
    const original = { toString: { set: "by-user", extra: true } };
    const merged = preserveUnknownRoutes(normalized, original);
    // both sides are plain objects → merge-preserve recurses; the
    // normalizer's own `set` wins, the user's unknown `extra` survives
    assert.equal(merged.toString.set, "by-normalizer");
    assert.equal(merged.toString.extra, true);
  });

  test("NESTED route named `toString` and field named `constructor` ride through at depth and inside route arrays", () => {
    const normalized = {
      providers: {
        "opencode-go": {
          type: "openai",
          routes: { "kimi-k2": { model: "kimi-k2" } },
        },
      },
      chain: [{ id: "keep-me", note: "set" }],
    };
    const original = {
      providers: {
        "opencode-go": {
          routes: {
            // a route LITERALLY named toString — legal YAML key
            toString: { model: "user-model", credential: "pin:proto" },
            "kimi-k2": { context: 131072 },
          },
        },
      },
      chain: [{ id: "user-entry", constructor: "entry-field" }],
    };
    const merged = preserveUnknownRoutes(normalized, original);
    // the toString route is restored verbatim at full depth
    assert.equal(
      canonical(merged.providers["opencode-go"].routes.toString),
      canonical(original.providers["opencode-go"].routes.toString),
    );
    // shared route merge-preserve still works beside it
    assert.equal(merged.providers["opencode-go"].routes["kimi-k2"].context, 131072);
    // array entries carrying a prototype-named FIELD keep it
    const userEntry = merged.chain.find((e) => e && e.id === "user-entry");
    assert.equal(userEntry.constructor, "entry-field");
  });

  test("ROUND-TRIP on disk: a settings file with prototype-named keys keeps them through a normalize-write", { skip: !resolveYaml() && "no YAML runtime resolvable on this box (probed Bun.YAML, node:yaml, js-yaml from the dsh tree)" }, () => {
    const yaml = resolveYaml();
    const { home, settings } = tmpHome("protokeys");
    const onDisk = {
      model: "glm-5.3-flash",
      constructor: "user-value",
      providers: {
        "opencode-go": { routes: { toString: { model: "user-model", credential: "pin:proto" } } },
      },
    };
    writeFileSync(settings, yaml.stringify(onDisk), { mode: 0o600 });
    normalizeWritePreserving(settings, rc7StyleNormalizer, { parse: yaml.parse, stringify: yaml.stringify });
    const after = yaml.parse(readFileSync(settings, "utf8"));
    assert.equal(after.constructor, "user-value");
    assert.equal(
      canonical(after.providers["opencode-go"].routes.toString),
      canonical(onDisk.providers["opencode-go"].routes.toString),
    );
    rmSync(home, { recursive: true, force: true });
  });
});

// ── 2. the guard (lstat rule, ported) ────────────────────────────────

describe("lane-settings-guard — the symlink tripwire (ported from FleetTower #641)", () => {
  test("absent and real-file shapes pass; symlink and non-file refuse with the clobber-class reason", () => {
    const { home, lane } = tmpHome("guard");
    assert.deepEqual({ ...checkLaneSettings(path.join(lane, "settings.yaml")), ok: true, kind: "absent" }, {
      ok: true,
      kind: "absent",
      path: path.join(lane, "settings.yaml"),
    });
    const real = path.join(lane, "settings.yaml");
    writeFileSync(real, "a: 1\n", { mode: 0o600 });
    assert.equal(checkLaneSettings(real).kind, "real-file");
    const target = path.join(home, "user.yaml");
    writeFileSync(target, "user: true\n");
    const link = path.join(lane, "linked.yaml");
    symlinkSync(target, link);
    const res = checkLaneSettings(link);
    assert.equal(res.ok, false);
    assert.equal(res.kind, "symlink");
    assert.match(res.reason, /SYMLINK/);
    assert.equal(checkLaneSettings(lane).ok, false, "a directory is not a settings file");
    rmSync(home, { recursive: true, force: true });
  });
});

// ── 3. the helper CLI — the template's own write path ────────────────

describe("settings-write — the template's write path (run-dsh-agent.sh spawns this)", () => {
  const yamlRuntime = resolveYaml();

  test("ROUND-TRIP through the helper: read → normalize → write preserves the multi-provider shape byte-equivalently", { skip: !yamlRuntime && "no YAML runtime resolvable on this box (probed Bun.YAML, node:yaml, js-yaml from the dsh tree)" }, () => {
    const { home, settings } = tmpHome("roundtrip");
    writeFileSync(settings, yamlRuntime.stringify(USER_SETTINGS), { mode: 0o600 });
    const before = readFileSync(settings, "utf8");

    const res = runWrite({ settingsPath: settings, templatePath: TEMPLATE, modelId: "glm-5.3-flash" });
    assert.equal(res.ok, true, `write refused: ${res.reason}`);
    assert.equal(res.mode, "merge-preserve");

    const afterText = readFileSync(settings, "utf8");
    const after = yamlRuntime.parse(afterText);
    // the template's OWN keys win: the stamped agent-default-model ...
    assert.equal(after["agent-default-model"].model, "glm-5.3-flash");
    assert.equal(after["agent-default-model"].provider, "zai");
    // ... and the template's provider catalog rides in whole
    assert.ok(after["llm-pi-ai"]?.providers?.zai, "template catalog present");
    // the USER's multi-provider shape survives byte-equivalently:
    assert.equal(canonical(after.providers["opencode-go"]), canonical(USER_SETTINGS.providers["opencode-go"]));
    assert.equal(canonical(after.providers["opencode-go-2"]), canonical(USER_SETTINGS.providers["opencode-go-2"]));
    assert.equal(canonical(after.providers.ablit), canonical(USER_SETTINGS.providers.ablit));
    assert.equal(after.providers["opencode-go"].routes["deepseek-v3"].credential, "pin:oc-go-ds");
    assert.equal(after.providers["opencode-go-2"].routes["glm-5.3-flash"].credential, "pin:oc-go2-glm");
    assert.equal(after.session.defaultModel, "opencode-go/kimi-k2");
    assert.equal(after.model, "glm-5.3-flash");
    // no glue duplication
    assert.equal(Object.keys(after.providers).filter((k) => k === "zai").length, 1);

    // ... and a SECOND write is a BYTE fixpoint (stable across spawns)
    const res2 = runWrite({ settingsPath: settings, templatePath: TEMPLATE, modelId: "glm-5.3-flash" });
    assert.equal(res2.ok, true);
    assert.equal(readFileSync(settings, "utf8"), afterText, "second spawn must not churn the file");
    assert.notEqual(before, afterText, "the first preserve-write merges (this assert only documents the merge happened)");
    rmSync(home, { recursive: true, force: true });
  });

  test("a MODEL OVERRIDE re-stamps only the template's own keys — user routes still survive", { skip: !yamlRuntime && "no YAML runtime resolvable on this box" }, () => {
    const { home, settings } = tmpHome("override");
    writeFileSync(settings, yamlRuntime.stringify(USER_SETTINGS), { mode: 0o600 });
    const res = runWrite({ settingsPath: settings, templatePath: TEMPLATE, modelId: "glm-5.2" });
    assert.equal(res.ok, true, `write refused: ${res.reason}`);
    const after = yamlRuntime.parse(readFileSync(settings, "utf8"));
    assert.equal(after["agent-default-model"].model, "glm-5.2", "override stamped into the template's own key");
    assert.equal(canonical(after.providers["opencode-go"]), canonical(USER_SETTINGS.providers["opencode-go"]));
    rmSync(home, { recursive: true, force: true });
  });

  test("FIRST BOOT (absent file) writes the stamped template without any YAML runtime", () => {
    const { home, settings } = tmpHome("firstboot");
    const res = runWrite({ settingsPath: settings, templatePath: TEMPLATE, modelId: "glm-5.3-flash" });
    assert.equal(res.ok, true, `write refused: ${res.reason}`);
    assert.equal(res.mode, "first-boot");
    assert.equal(readFileSync(settings, "utf8"), stampModel(readFileSync(TEMPLATE, "utf8"), "glm-5.3-flash"));
    // no temp litter beside the file
    assert.equal(readdirSync(path.dirname(settings)).filter((f) => f.includes(".settings-write-") || f.includes(".normalize-")).length, 0);
    rmSync(home, { recursive: true, force: true });
  });

  test("a SYMLINKED settings target refuses the write LOUDLY (exit 2) and leaves the target untouched", () => {
    const { home, lane } = tmpHome("symlink");
    const target = path.join(home, "user-real-settings.yaml");
    writeFileSync(target, yamlRuntime ? yamlRuntime.stringify(USER_SETTINGS) : "user: true\n", { mode: 0o600 });
    symlinkSync(target, laneSettingsPath(lane));
    // through the CLI — the exact spawn the driver makes
    const proc = spawnSync(process.execPath, [HELPER, laneSettingsPath(lane), TEMPLATE, "glm-5.3-flash"], { encoding: "utf8" });
    assert.equal(proc.status, 2, `expected exit 2, got ${proc.status}: ${proc.stderr}`);
    assert.match(proc.stderr, /SYMLINK/);
    assert.match(proc.stderr, /refusing settings write/);
    assert.equal(readFileSync(target, "utf8"), yamlRuntime ? yamlRuntime.stringify(USER_SETTINGS) : "user: true\n", "link target untouched");
    assert.ok(existsSync(laneSettingsPath(lane)), "the link itself is not removed");
    rmSync(home, { recursive: true, force: true });
  });

  test("an UNPARSEABLE existing file refuses (exit 3) instead of being stomped", { skip: !yamlRuntime && "no YAML runtime resolvable on this box" }, () => {
    const { home, settings } = tmpHome("malformed");
    writeFileSync(settings, "{a: [1, 2\nb: :::\n", { mode: 0o600 });
    const proc = spawnSync(process.execPath, [HELPER, settings, TEMPLATE, "glm-5.3-flash"], { encoding: "utf8" });
    assert.equal(proc.status, 3, `expected exit 3, got ${proc.status}: ${proc.stderr}`);
    assert.equal(readFileSync(settings, "utf8"), "{a: [1, 2\nb: :::\n", "malformed file left untouched — never stomped");
    rmSync(home, { recursive: true, force: true });
  });

  test("a MISSING template refuses (exit 3) — the driver's no-template branch still leaves settings alone", () => {
    const { home, settings } = tmpHome("notemplate");
    writeFileSync(settings, "a: 1\n");
    const res = runWrite({ settingsPath: settings, templatePath: path.join(home, "no-such-template.yaml"), modelId: "glm-5.3-flash" });
    assert.equal(res.ok, false);
    assert.equal(res.code, 3);
    assert.equal(readFileSync(settings, "utf8"), "a: 1\n");
    rmSync(home, { recursive: true, force: true });
  });

  test("the model id is charset-checked before it is stamped INTO structured YAML", () => {
    const { home, settings } = tmpHome("modelid");
    writeFileSync(settings, "a: 1\n");
    for (const bad of ["zai/glm-5.3\ninjected: true", "zai/gl m", "zai/glm: x # y"]) {
      const res = runWrite({ settingsPath: settings, templatePath: TEMPLATE, modelId: bad });
      assert.equal(res.ok, false, `model id '${bad}' must refuse`);
      assert.match(res.reason, /A-Za-z0-9/);
    }
    assert.equal(readFileSync(settings, "utf8"), "a: 1\n", "nothing written on refusal");
    rmSync(home, { recursive: true, force: true });
  });
});

// ── 4. the driver wiring (source pin — the write path cannot regress ─
// silently back to the stomp)

describe("run-dsh-agent.sh — the settings write path wiring", () => {
  const src = readFileSync(DRIVER, "utf8");

  test("the driver spawns settings-write.mjs (no inline overwrite node -e stamp anymore)", () => {
    assert.match(src, /settings-write\.mjs" "\$DSH_HOME\/settings\.yaml" "\$SETTINGS_TEMPLATE" "\$MODEL_ID/);
    assert.ok(!/node -e .+replace\(\^  model/.test(src), "the inline overwrite stamp must be gone");
  });

  test("the `|| cp` stomp fallback is DELETED, not degraded", () => {
    assert.ok(!/\|\| cp "\$SETTINGS_TEMPLATE" "\$DSH_HOME\/settings\.yaml"/.test(src), "a failing settings write must fail the spawn, never fall back to an unmerged overwrite");
  });

  test("the symlink refusal is hoisted BEFORE both settings write sites", () => {
    const refusal = src.indexOf('is a SYMLINK');
    const helperWrite = src.indexOf('settings-write.mjs');
    const bootstrap = src.indexOf('writing initial $DSH_HOME/settings.yaml');
    assert.ok(refusal !== -1 && helperWrite !== -1 && bootstrap !== -1);
    assert.ok(refusal < helperWrite, "refusal must precede the template write");
    assert.ok(refusal < bootstrap, "refusal must precede the first-boot bootstrap write");
    assert.match(src, /\[ -L "\$DSH_HOME\/settings\.yaml" \]/, "-L tests the link itself (lstat rule), never its target");
  });
});

// ── 5. the stamp itself (byte-compatible with the old inline stamp) ──

describe("stampModel — the template stamp", () => {
  test("stamps the two-space-indented model line; `$`-class ids refuse before the stamp", () => {
    const t = "agent-default-model:\n  model: glm-5.3\n  provider: zai\n";
    assert.equal(stampModel(t, "glm-5.2"), "agent-default-model:\n  model: glm-5.2\n  provider: zai\n");
    // a '$&'-class id never reaches the replace (charset guard first) —
    // the string-form replace would have expanded it; the function-form
    // replacement + charset check are both defense, this pins the guard
    assert.throws(() => stampModel(t, "x$&y"), /A-Za-z0-9/);
  });
  test("a metacharacter id refuses (the stamp lands inside structured YAML)", () => {
    assert.throws(() => stampModel("a: 1\n", "zai/glm\ninjected: true"), /A-Za-z0-9/);
  });
});
