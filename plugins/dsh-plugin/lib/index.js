// @gh-tracker/dsh-plugin — embeds the 8 portable github-activity-tracker
// skills into any dsh composition via ctx.skills.register() (runtime
// provider label, modelInvocable: true / userInvocable: false — same
// model-only surface the filesystem provider gives .dsh/skills today).
//
// Source of truth is .dsh/skills/ in the gat repo; skills/*.md here are the
// generated copies (sync direction gat -> plugin; see CORDIS-PLUGIN-PLAN.md).
//
// Activation follows the verified plugin shape (@local/dsh-model-alternator):
// default-export class with `static inject = ["skills"]` (the
// @deepseek-ai/dsh-skill service name), one ctx.skills.register() per skill.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// name/description/whenToUse mirror the SKILL.md frontmatter in .dsh/skills/;
// the body is read from skills/<name>.md so edits to the prose stay in files.
const SKILLS = [
  {
    name: "pr-body-dod",
    description:
      "The PR-body definition-of-done — the honesty sections reviewers REQUIRE (NOT-verified, lane impact, generator statements, claims-vs-reality accuracy). Use before opening any PR or updating its body; reviewfix rounds fail on these more than on code.",
    file: "pr-body-dod.md",
  },
  {
    name: "gh-cli-techniques",
    description:
      "The proven gh/git one-liners the fleet keeps re-deriving — worktree parent-checks, stash-bisect, base64 PAT headers, depth tricks, pagination. Use when constructing gh/git commands for verification, pushing with specific credentials, or paging API results.",
    file: "gh-cli-techniques.md",
  },
  {
    name: "parent-commit-verification",
    description:
      "Proving \"fails without it\" honestly — worktree-based parent checks, exact-count claims, mutation tests, and flaky-test attribution. Use when a PR requires regression tests that fail on the parent, or when deciding whether a failure is yours.",
    file: "parent-commit-verification.md",
  },
  {
    name: "sed-yaml-escaping",
    description:
      "The edit-tool trap on backslash-dense lines (sed programs, regex replacements in YAML) and the reliable routes around it. Use when an edit on a line containing \\\\., \\\\1, or sed -E patterns keeps failing to match, or when reading such lines shows inconsistent backslash counts.",
    file: "sed-yaml-escaping.md",
  },
  {
    name: "conflict-recovery",
    description:
      "When your branch conflicts with the dominant branch — update-branch healing vs genuine divergence, the heal-first ladder, when supersede is correct, and what lands where. Use when a PR shows dirty/mergeable:false, a review won't fire for lack of a merge ref, or after sibling PRs merged first.",
    file: "conflict-recovery.md",
  },
  {
    name: "cross-repo-guest",
    description:
      "Working in a TARGET repo from a checkout of another — the CLAUDE.md swap, target-first bootstrap, credential identity, and dominant-branch rules. Use when your task names a repo other than your checkout, or after `gh repo clone <target> work`.",
    file: "cross-repo-guest.md",
  },
  {
    name: "ship-and-exit",
    description:
      "The post-work protocol — gates green, push, post the marker, exit; the tower owns review fires and observes conclusions. Use when your work is complete and you are deciding what shipping and stopping look like.",
    file: "ship-and-exit.md",
  },
  {
    name: "flight-recorder-audit",
    description:
      "How to read the fleet's own transcripts — locating a run's session, decoding the zstd JSONL, and the analysis lenses that found real defects (polling waste, duplicate dispatch, confusion episodes). Use when asked to evaluate what an agent actually did, verify a claim about agent behavior, or hunt for optimization levers.",
    file: "flight-recorder-audit.md",
  },
];

const GatSkills = class {
  static inject = ["skills"];

  constructor(ctx) {
    for (const skill of SKILLS) {
      const content = readFileSync(join(here, "..", "skills", skill.file), "utf8");
      ctx.skills.register({
        name: skill.name,
        description: skill.description,
        content,
        invocation: { modelInvocable: true, userInvocable: false },
      });
      ctx.logger.info(`gh-tracker skill registered: ${skill.name}`);
    }
  }
};

export { GatSkills };
export default GatSkills;
