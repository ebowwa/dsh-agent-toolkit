---
name: decompose-by-capability
description: Decompose a claim into PARTS, classify each part's capability requirement (mac-native / linux-native / language-default / neutral / heavy-compute), and route each part to the machine class that can run it — executing the parts this cell can run and filing the rest as self-contained tickets. Use BEFORE executing any multi-part claim, and again whenever a planned part turns out to be unrunnable on the current node.
---

# Decompose the work by fleet capability

Owner decision 2026-09-26 (issue #114): agents think about WHAT PARTS the
work consists of and WHICH fleet machines can do each part — and modularize
accordingly. The standing failure this replaces: an agent monoliths its
whole claim on whatever node it landed on, so a swift+python+docs claim
runs its swift half on a Linux box (or its shell half on a mac), or dies
there instead of filing the part onward.

This skill is the agent-side mirror of the router-side placement law
(factory#60). The router places whole claims; you place parts.

## Step 1 — WORK PLAN FIRST

Before executing, decompose the claim into parts and classify each part's
capability requirement:

| Class | Examples | Placement (the law, factory#60) |
|---|---|---|
| `mac-native` | swift, ios, macos-native (Xcode, simulators, ANE) | mac lane — **macOS nodes ONLY** |
| `linux-native` | systemd units, deploys, kernel, shell targeting linux | linux lane — **Linux nodes ONLY** (lane alone never satisfies it) |
| `language-default` | tsx / ts / python | linux lane BY DEFAULT; a macRepos-trait repo keeps mac — **trait beats language** |
| `neutral` | docs, config, reviews, triage | open lane — any OS |
| `heavy-compute` | big builds, long benches | big lane only |

Two hard checks before you call the plan done:

1. Every part names the node class that can run it. **An agent that cannot
   name which machines can run a part is not done planning.**
2. When more than one node can serve a part, prefer by live availability:
   free pool seats, disk/ram/token budget. A node whose log claims N running
   agents while fewer real processes exist (ghost seats) is **ineligible**
   until healed — never route onto a phantom-full node.

The standing fleet context injected into your task (node registry + live
resource summary + the placement law) is the ground truth for this step.
If it is missing from the task, read `config/fleet-manifest.md` in the
toolkit checkout before planning. The registry distinguishes LANE from OS —
a lane name never satisfies an OS class (mini-L3 serves cheap cells and
still runs macOS; only the seed box is Linux).

## Step 2 — RUN WHAT YOU CAN, FILE WHAT YOU CANNOT

Parts this cell can legally and efficiently run: **run them here** — the
plan does not excuse shipping less.

Parts the cell cannot legally or efficiently run (wrong OS class, wrong
hardware trait, heavy-compute on a small node): **file each as a separate
self-contained ticket** in the repo where the work belongs, using the
filing mechanism (#113):

- `gh issue create` — title prefix `part: ` plus the part name.
- The body is **SELF-CONTAINED**: a fresh agent holding only that ticket
  completes it with ZERO sibling context. It carries, on its own:
  1. the goal of the part (no "see the other task", no "as described
     above", no references to your claim or thread),
  2. receipts — file:line, command output, the exact environment gap that
     makes this part unrunnable on the filing node,
  3. its own acceptance criteria (done looks like X, verifiable without
     reading any sibling ticket),
  4. the target capability class + node class in the body
     (`class: mac-native — target: mac lane, macOS nodes`).
- Label it with the repo's todo label (`agent-todo` where it exists).
- **Zero scope-creep**: a filed part is not worked in this claim. Do not
  half-run an unrunnable part "to help out" — a wrong-OS execution is the
  standing mistake class this protocol exists to end.

Queue honesty (#114 dependency): agent-filed sub-tickets ride the pile
gate (~1 day) until the comment-trigger path is restored — webhooks are
dead everywhere and manual enqueue is the only live mint. **Never assume
instant sub-dispatch; never block on a filed ticket.** If a filed part is
on the claim's critical path, say so loudly in the exit summary instead of
waiting.

## Step 3 — EXIT SUMMARY: the parts table

The final summary reports the decomposition — one row per part:

```markdown
| Part | Class | Disposition | Target node class | Why |
|---|---|---|---|---|
| swift UI port | mac-native | filed as #123 | mac (macOS only) | this cell is linux |
| pytest suite | language-default | executed here | linux | non-macRepos repo |
| docs pass | neutral | executed here | any | no OS affinity |
```

plus a `filed-followups:` line listing every issue number you filed (#113
shape: one line, comma-space separated refs). A summary without the parts
table is an incomplete exit (the claim's review sends it back).

## Anti-pattern (what this skill replaces)

> A claim spanning a swift port + a python fixture + docs lands whole on a
> linux seed node. The agent burns its clock failing to build swift on
> linux, ships nothing, and the docs pass — runnable in minutes, anywhere —
> never happens either. One monolith on a wrong-OS node loses all three
> parts. The decomposed claim: docs done here, python done here, swift
> filed `part: …` `class: mac-native` for a mac node, exit summary says
> exactly that.
