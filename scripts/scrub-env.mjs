#!/usr/bin/env node
// scrub-env.mjs — the agent-env secret sweep (dsh-agent-toolkit#608).
//
// Prints the NAMES of environment variables that must not reach an agent
// session, one per line, sorted. run-dsh-agent.sh unsets each printed name
// BEFORE spawning the dsh harness, so a node-injected credential never
// enters any agent shell, session transcript, or model context at all —
// the injection half of the cure, not a downstream scrub.
//
// Why the driver cannot rely on the harness alone: dsh-subprocess strips
// only KEY/PASSWORD/SECRET/TOKEN-named vars from agent child processes
// (run-dsh-agent.sh section 2b comment). A credential exported under any
// other name — the launchd-level `*_PAT_*` class this repo's issue #608
// pins, a `*_P12_*` signing blob — rides straight through into every agent
// shell, and the transcript keeps whatever a tool result echoes.
//
// Two drop rules (a name matching either is swept unless allowlisted):
//   1. value-shape — the VALUE matches a credential shape the shared
//      scrubber knows (github_pat_, gh[posr]_, sk-, JWT, dp.st.,
//      Z.AI-style 32-hex-dot). Name-blind: a token under an innocuous
//      name still dies.
//   2. name-segment — the NAME carries a credential segment the harness
//      strip does NOT cover: PAT, P12, CRED/CREDENTIAL. (KEY/PASSWORD/
//      SECRET/TOKEN are already stripped downstream by the harness, and
//      the provider route keys MUST survive — they are allowlisted.)
//
// Allowlist: the pipeline's own contracts — provider route keys,
// DOPPLER_SERVICE_TOKEN, GH_TOKEN/GITHUB_TOKEN (the driver's gh-identity
// step consumes them, and TOKEN names are harness-stripped downstream),
// the DSH_/DISPATCH_ namespaces and the shim-contract vars (paths/flags,
// never credentials). Consumers with extra provider keys exempt them via
// DSH_ENV_SWEEP_KEEP="NAME1,NAME2" (comma-separated exact names).
//
// Never prints values — names only (this stdout lands in run logs).
// Reads no stdin; exits 0 always except on an internal error (the driver
// treats a nonzero exit as fatal — scrubbing is fail-closed, REVIEW.md).

const VALUE_SHAPES = [
  /\b[0-9a-f]{32}\.[A-Za-z0-9_-]{8,}\b/, // Z.AI-style
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI/gateway style
  /\bdp\.[a-z]{2}\.[A-Za-z0-9_.-]{16,}/, // Doppler dp.st.<cfg>.<slug>
  /\bgh[posr]_[A-Za-z0-9_.-]{20,}\b/, // classic GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, // fine-grained GitHub PATs (issue #608)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, // JWT
];

// Credential-bearing NAME segments the harness SENSITIVE_ENV_PATTERN misses.
// Deliberately narrow: a false drop here breaks a live lane, so public/
// structural segments (CERT — a CA cert is not a credential) stay out.
const NAME_SEGMENT = /(^|_)(PAT|P12|CRED|CREDENTIAL)(_|$)/;

const ALLOW_EXACT = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "DOPPLER_SERVICE_TOKEN",
  // Provider route keys (apiKeyEnv in config/settings*.yaml and common
  // consumer catalogs) — the model route dies without them:
  "ZAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
]);

const ALLOW_PREFIX = [
  "DSH_", // the pipeline's own namespace (also harness-stripped downstream)
  "DISPATCH_", // face-identity namespace (bin/face-lock)
  "GH_SCRUB_", // shim contract: paths
  "GIT_SCRUB_", // shim contract: paths
  "GH_MERGE_GUARD", // shim contract: flag + script path
  "SCRUB_SCRIPT", // shim contract: scrubber path
];

for (const extra of (process.env.DSH_ENV_SWEEP_KEEP ?? "").split(",")) {
  const name = extra.trim();
  if (name) ALLOW_EXACT.add(name);
}

const swept = [];
for (const [name, value] of Object.entries(process.env)) {
  if (!value || value.length < 8) continue;
  if (ALLOW_EXACT.has(name)) continue;
  if (ALLOW_PREFIX.some(p => name.startsWith(p))) continue;
  const byShape = VALUE_SHAPES.some(re => re.test(value));
  const byName = NAME_SEGMENT.test(name);
  if (byShape || byName) swept.push(name);
}
process.stdout.write(swept.sort().join("\n") + (swept.length ? "\n" : ""));
