/**
 * Static agent-integration templates (PRD FR-21 to FR-23). These are the only
 * files Phase 4 adds beyond `ziki.json`, and `ziki init` is the only writer.
 *
 * Rules the templates must keep:
 * - Frontmatter uses only documented fields: `name` and `description` for the
 *   shared skill, `description` for the command files. Nothing harness-specific.
 * - No absolute paths and no machine-specific values, so the files are
 *   identical on every machine and reruns are byte-stable. The CLI checkout
 *   path is a `<ziki-cli>` placeholder the agent resolves with the human.
 * - The command files are written to the documented plural directories
 *   (`.claude/commands`, `.opencode/commands`); detection additionally reads
 *   OpenCode's singular `.opencode/command` where some installs use it.
 * - The description disambiguates this repository workflow from the unrelated
 *   "Ziki" bounty platform, whose user-level skill and command use the same
 *   name on some machines.
 */

const CLI_INVOCATION = 'node <ziki-cli>/bin/ziki.js';

const SKILL = `---
name: ziki
description: >-
  Repository workflow for the ziki-cli tool: inspect repo state with status,
  propose setup with init (writes only after the human approves), and review
  changes with review before handing work back to the human. Use when the
  human asks for repo state, a change review, or project setup in a
  repository managed by ziki-cli. This is the ziki-cli repository workflow,
  not the Ziki bounty platform.
---

# Ziki repository workflow

Division of responsibility: the agent (you) implements and verifies; the human
approves decisions; the Ziki CLI reports repository facts. Ziki never runs
project commands, never commits, never pushes, and never decides anything.

## Running the CLI

Ziki CLI runs from its source checkout. The shell command \`ziki\` may belong
to a different tool on this machine (for example a bounty-platform CLI), so
never call bare \`ziki\`. Always run:

    ${CLI_INVOCATION} <command> [options]

Replace \`<ziki-cli>\` with the ziki-cli checkout path on this machine; ask the
human if you do not know it. Available commands: \`status\`, \`init\`,
\`review\`. Use \`--json\` for exact machine facts; use plain output to read
quickly. Use \`--help\` before guessing any flag.

## The fixed workflow

Follow these steps in order for any non-trivial task in this repository.

### 1. Inspect

Run \`${CLI_INVOCATION} status\`. Read the branch, divergence, worktree
counts, last commit, detected agent files, and detected checks. Run it again
mid-task whenever the tree state matters.

### 2. Plan

If \`ziki.json\` is missing or stale, run \`${CLI_INVOCATION} init\`. It is
plan-only by default and prints exactly what it would create: \`ziki.json\`
and the agent skill/command files. Show the plan to the human. Do not treat a
plan as done work.

### 3. Human approval

\`ziki init --apply\` writes only after approval. Get an explicit yes from the
human **in this conversation** before applying; only then may you pass
\`--yes\` (needed because an agent session is not an interactive terminal).
Never approve on the human's behalf, and never pass \`--yes\` preemptively.
If a file already exists, init also requires \`--confirm <path>\` per file;
tell the human which paths need confirming and why.

### 4. Work

Implement the requested change yourself. Ziki has no code-generation step and
does not watch your edits.

### 5. Verify

Run the project's verification commands yourself — the checks Ziki reports
are suggestions it detected, not commands it runs. Report exactly what you
ran, the exit codes, and what failed. A check you did not run must be
reported as not run. Never say a check passed unless you ran it and saw it
pass.

### 6. Review

Run \`${CLI_INVOCATION} review\` (add \`--json\` for the full contract). It
reports staged, unstaged, and untracked changes, directory summaries, check
states, secret-pattern warnings, limits, and warnings — read-only, so it is
safe at any point. Fix what it surfaces before claiming the task is done. Its
secret scan is a best-effort warning pass, not proof the tree is clean; treat
its findings as questions for the human, and never print or guess a matched
secret value.

### 7. Present decisions

End by presenting the human a short summary: what changed (by area), which
checks you ran and their real results, what \`ziki review\` reported, and the
open decisions. Ziki's \`observed\` check state means a record stored in
\`ziki.json\` claims a result — quote it as recorded, never as verified by
Ziki. Your own verification is the only thing you may present as "passed",
with the command and exit code you saw.

## Hard rules

- No commits, pushes, merges, or publishes unless the human explicitly
  asks; Ziki never does them by itself.
- \`ziki review\` and \`ziki status\` write nothing. Only \`ziki init
  --apply\` writes, and only after human approval.
- Do not hand-edit \`ziki.json\`; change it through the init plan/apply flow.
  The CLI never writes \`lastObserved\`; a future record command would, and
  it does not exist yet.
- If a command fails or reports unavailable data, surface the limitation to
  the human instead of working around it silently.
- This workflow is for repositories managed by ziki-cli. If the human means
  the Ziki bounty platform (issues, bids, points), that is a different tool
  and a different skill.
`;

const COMMAND = `---
description: Run the ziki-cli repository workflow — status, init plan, human approval, work, verify, review, present
---

Run the Ziki repository workflow from the \`ziki\` skill (ziki-cli): inspect
with \`status\`, plan setup with \`init\` when needed, get the human's
explicit approval before any \`init --apply\`, implement the request, verify
the project's own checks yourself, run \`ziki review\`, and finish with a
summary of changes, real check results, and open decisions.

Never call bare \`ziki\` in the shell; use
\`${CLI_INVOCATION}\` — the checkout path comes from the skill or the human.

Task from the human: $ARGUMENTS
`;

const OPENCODE_COMMAND = `---
description: Run the ziki-cli repository workflow — status, init plan, human approval, work, verify, review, present
---

Run the Ziki repository workflow from the \`ziki\` skill (ziki-cli): inspect
with \`status\`, plan setup with \`init\` when needed, get the human's
explicit approval before any \`init --apply\`, implement the request, verify
the project's own checks yourself, run \`ziki review\`, and finish with a
summary of changes, real check results, and open decisions.

Never call bare \`ziki\` in the shell; use
\`${CLI_INVOCATION}\` — the checkout path comes from the skill or the human.

Task from the human: $ARGUMENTS
`;

/** Managed agent files, in write order (ziki.json itself is always last). */
export const AGENT_TEMPLATES = Object.freeze([
  {
    path: '.claude/skills/ziki/SKILL.md',
    kind: 'claude-skill',
    content: SKILL,
  },
  {
    path: '.claude/commands/ziki.md',
    kind: 'claude-command',
    content: COMMAND,
  },
  {
    path: '.opencode/commands/ziki.md',
    kind: 'opencode-command',
    content: OPENCODE_COMMAND,
  },
]);
