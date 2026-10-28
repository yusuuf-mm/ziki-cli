# ziki-cli

A status, setup, and review CLI for repositories where humans and coding agents
work together. `ziki status` answers three questions in one screen:

1. What state is the Git repository in?
2. Which agent configuration files are present?
3. Which verification commands does this project appear to use?

It never runs those commands or touches the network. `status` writes nothing;
`init` writes `ziki.json` and the agent skill/command files, and only after
approval; `review` inspects changes read-only.

**Phase 4.** This release contains the read-only `status` command, plan-first
`init`, the read-only `review` command, and the `/ziki` agent integration: the
same `init` generates a shared skill and slash-command files for Claude Code
and OpenCode that walk an agent through inspect → plan → human approval → work
→ verify → review → present. Publishing and a deploy pipeline are not
implemented yet.

## Requirements

- Node.js 20 or newer
- Git on `PATH`

## Run from source

```console
$ node bin/ziki.js status
```

Human output:

```text
ziki status
  repo      /home/dev/project
  branch    feat/status  ->  origin/main  ahead 2, behind 1
  worktree  2 staged · 1 modified · 3 untracked  (not clean)
  last      a1b2c3d  fix: handle empty diff  (2 hours ago)
  agents    claude-skill      .claude/skills/ziki/SKILL.md
  checks    test   npm test                 (detected, not run)
```

Machine output:

```console
$ node bin/ziki.js status --json
```

```json
{
  "schemaVersion": 1,
  "tool": { "name": "ziki-cli", "version": "0.1.0" },
  "generatedAt": "2026-10-28T12:00:00.000Z",
  "repo": {
    "root": "/home/dev/project",
    "cwd": ".",
    "isGitRepo": true,
    "branch": "feat/status",
    "detached": false,
    "head": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "upstream": { "name": "origin/main", "ahead": 2, "behind": 1 },
    "lastCommit": {
      "sha": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      "shortSha": "a1b2c3d",
      "subject": "fix: handle empty diff",
      "date": "2026-10-28T10:00:00.000Z"
    }
  },
  "worktree": {
    "staged": 2,
    "modified": 1,
    "untracked": 3,
    "deleted": 0,
    "renamed": 0,
    "conflicted": 0,
    "clean": false
  },
  "agents": [
    { "kind": "claude-skill", "path": ".claude/skills/ziki/SKILL.md" }
  ],
  "checks": [
    {
      "name": "test",
      "command": "npm test",
      "source": "package.json#scripts.test",
      "executed": false
    }
  ]
}
```

The JSON contract is defined normatively in
[`docs/status-schema-v1.md`](docs/status-schema-v1.md). Key order and nullability
are part of the tests, not of the consumer contract.

## Initialize a project

`ziki init` inspects the repository and proposes `ziki.json` plus three agent
files: a shared skill at `.claude/skills/ziki/SKILL.md` and one command file
per harness at `.claude/commands/ziki.md` and `.opencode/commands/ziki.md`.
It writes nothing by default:

```console
$ node bin/ziki.js init
ziki init (plan)
  repo      /home/dev/project
  config    ziki.json  (new)
  agent     .claude/skills/ziki/SKILL.md  (new)
  agent     .claude/commands/ziki.md  (new)
  agent     .opencode/commands/ziki.md  (new)
  checks    test      npm test  (package.json#scripts.test)

--- ziki.json (new) ---
  {
    "schemaVersion": 1,
    "checks": [
      {
        "name": "test",
        "command": "npm test",
        "source": "package.json#scripts.test"
      }
    ],
    "managedFiles": {
      ".claude/skills/ziki/SKILL.md": "sha256:...",
      ".claude/commands/ziki.md": "sha256:...",
      ".opencode/commands/ziki.md": "sha256:..."
    },
    "integrity": {
      "algorithm": "sha256",
      "hash": "..."
    }
  }

--- .claude/skills/ziki/SKILL.md (new) ---
  ...
```

Apply only after reading the plan:

```console
$ node bin/ziki.js init --apply
```

On a terminal Ziki asks `Apply these changes? [y/N]`. In a non-interactive
shell, pass `--apply --yes`. A global yes does not overwrite an existing file:
name each such file with `--confirm <path>` — for example
`--confirm ziki.json` or `--confirm .claude/skills/ziki/SKILL.md`. A rerun with
nothing to change writes nothing and needs no confirmation.

`ziki.json` records the detected checks, any unknown fields Ziki does not own,
the hashes of the agent files Ziki wrote (`managedFiles`), and a SHA-256
integrity hash of its own contents. Hand edits are detected and labeled
(`integrity mismatch`, `modified since last write`, or `not written by ziki
init`) and are not overwritten without confirmation. The format is documented
in [`docs/config-schema-v1.md`](docs/config-schema-v1.md).

### Use `/ziki` from an agent

The generated files use only documented frontmatter fields (`name` and
`description` for the skill, `description` for commands) and contain no
machine-specific paths. The skill and both command files guide the agent
through the fixed workflow: inspect with `status`, plan with `init`, get an
explicit human yes before `init --apply`, implement the task, verify with the
project's own checks, review with `ziki review`, and present changes, real
check results, and open decisions.

The files never call a bare `ziki` command, because on some machines that name
belongs to the unrelated **Ziki bounty platform** (its own skill and `/ziki`
command are installed at user level). Name resolution matters: Claude Code
gives a **personal** (user-level) skill priority over a project skill with the
same name, and OpenCode de-duplicates skill names across locations. So on a
machine where the bounty platform's user-level `ziki` skill is installed,
`/ziki` runs that skill, not this repository workflow, even inside a
configured repository. On a machine without a conflicting `ziki` skill, the
generated project skill and command load normally. Every template instructs
the agent to run:

```console
$ node <ziki-cli>/bin/ziki.js status
```

Replace `<ziki-cli>` with this checkout's path; the agent is told to ask the
human if it does not know it. After a global install, the installed binary is
also `ziki`; check `ziki --version` before relying on it. The template contract
is documented in
[`docs/agent-integration-v1.md`](docs/agent-integration-v1.md).

Do not put secrets in `ziki.json`: plans print the file's proposed contents and
diffs so a human can approve them.

## Review changes

`ziki review` inspects the working tree after an agent (or a human) has made
changes. It is completely read-only:

```console
$ node bin/ziki.js review
ziki review
  repo      /home/dev/project
  branch    feat/status  at a1b2c3d
  head      a1b2c3d4e5f60718293a4b5c6d7e8f9012345678
  staged    2 files  +3 -0
  unstaged  1 file  +1 -1
  untracked 1 file  +1 -0
  summary   4 files  +5 -1

changed files
  staged    modified    src/app.js  +2 -0
            added       stale-token.js  +1 -0
  unstaged  modified    src/app.js  +1 -1
  untracked notes.md  +1 -0

areas
  src                     2 files     +3 -1
  .                       2 files     +2 -0

largest changes
  src/app.js                              staged    +2 -0
  src/app.js                              unstaged  +1 -1
  notes.md                                untracked +1 -0
  stale-token.js                          staged    +1 -0

checks
  ziki.json not found; checks were detected from project manifests
  source    detected
  (none configured or detected)

secrets
  5 added lines scanned; 1 pattern found
  ! stale-token.js:1  [staged]  github-token

read-only: no files were written and no project commands were run
```

What review reports, and what it refuses to pretend:

- **Staged and unstaged changes**, including renames, copies, deletions,
  mode changes, binaries, and repositories with no commits yet. Unstaged
  content is read with `git diff-files` so the index is never refreshed.
- **Untracked files** are read (regular files only, symlinks never followed)
  under size caps and counted as added lines.
- **Directory (area) summaries** and the **ten largest known changes**, so a
  large diff can be triaged without dumping every file.
- **Check states.** Review never runs a check. Every check is `not run`,
  `unknown`, or `observed`. `observed` means a matching record in
  `ziki.json#lastObserved` claims a result; the report labels it
  `recorded in ziki.json`, never "Ziki verified". A detected command is not
  evidence that anything ran.
- **Secret warnings.** Added diff lines and scanned untracked text are checked
  against a fixed pattern list (provider tokens, private keys, JWTs,
  credential-style assignments). Findings name only the path, line, scope,
  and rule; the matched value is never stored, printed, or logged. This is a
  best-effort warning pass, **not** a security control: a clean report does
  not mean no secrets exist, and findings are reported as `partial` or
  `not-scanned` when any channel could not be scanned.
- **Honest incompleteness.** Every cap (diff size, added lines, line length,
  findings, untracked files and bytes, list sizes) is reported in
  `limits.hit`, and `warnings` explains anything that could not be inspected.
  Nothing is silently omitted.

The machine contract is `node bin/ziki.js review --json`, defined normatively
in [`docs/review-schema-v1.md`](docs/review-schema-v1.md). Key order and
nullability are part of the tests, not of the consumer contract.

## Options

| Option | Commands | Meaning |
|---|---|---|
| `-h`, `--help` | all | Print usage |
| `-v`, `--version` | all | Print the package version |
| `--debug` | all | Include a stack trace when a runtime error occurs |
| `--json` | `status`, `review` | Print the machine-readable report |
| `--plan` | `init` | Print the plan; this is the default and writes nothing |
| `--apply` | `init` | Write the plan after approval |
| `--yes` | `init` | Approve without an interactive prompt; requires `--apply` |
| `--confirm <path>` | `init` | Confirm replacing an existing or changed file; repeatable |

Color is used only when stdout is a TTY and `NO_COLOR` is unset. Piped output
and `--json` never contain ANSI escapes. Control characters that come from
repository data (for example, in a commit subject or a path) are escaped in
human output, and JSON escapes them as `\uXXXX`.

## What is detected

**Git state:** repository root, invocation directory, branch, detached HEAD,
HEAD commit, upstream and ahead/behind counts, latest commit, and working-tree
tallies (staged, modified, untracked, deleted, renamed, conflicted, clean).

**Agent files, by presence only:**

| Kind | Location |
|---|---|
| `claude-skill` | `.claude/skills/<name>/SKILL.md` |
| `claude-command` | `.claude/commands/<name>.md` |
| `opencode-skill` | `.opencode/skills/<name>/SKILL.md` |
| `opencode-command` | `.opencode/commands/<name>.md` and `.opencode/command/<name>.md` |
| `agents-skill` | `.agents/skills/<name>/SKILL.md` |
| `instructions` | `AGENTS.md`, `CLAUDE.md` |

OpenCode's singular `command/` directory is detected where an existing install
uses it (OD-08); `init` always writes the documented plural `commands/`.

**Verification commands, from manifests only:**

| Ecosystem | Signal | Suggestion |
|---|---|---|
| Node | `package.json` scripts | `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` |
| Flutter | `pubspec.yaml` | `flutter test`, `flutter analyze` |
| Go | `go.mod` | `go test ./...` |
| Rust | `Cargo.toml` | `cargo test` |

An invalid manifest contributes nothing and does not crash the command.

## Safety guarantees

- **Read-only by default.** `status`, `review`, and every `init` run without
  `--apply` write nothing and change no tracked content, ref, or working-tree
  state. Git optional locks are disabled (`GIT_OPTIONAL_LOCKS=0`), so `status`
  does not refresh `.git/index`. Review reads unstaged content with
  `git diff-files` for the same reason: the index is never touched.
- **One write path.** `init --apply` is the only command that writes: exactly
  `ziki.json` at the repository root plus the three fixed agent files above,
  after displaying the plan and obtaining approval. It never edits any other
  agent file and never reads anyone else's skill or command contents. `review`
  writes nothing, not even `ziki.json`.
- **No clobber.** An existing `ziki.json` or agent file is rewritten only with
  `--confirm <path>` naming that file, and only after its full contents or
  diff were displayed. A global `--yes` is not enough. Files that changed since
  Ziki recorded their hash are labeled and refused the same way. Nothing is
  written when any confirmation is missing, and every target is re-read
  immediately before writing so a file edited after the plan is never
  overwritten under stale approval.
- **Atomic and contained.** Writes use a temporary file in the target
  directory, `fsync`, and rename; missing parent directories are created
  inside the repository only. Symlinks, directories, and paths outside the
  repository are refused before writing. Files are written independently
  (agent files first, `ziki.json` last); a failure midway leaves the earlier
  files valid, and the next `init` reports and repairs the difference.
- **No execution.** Detected commands are suggestions; nothing ever runs them.
  Git itself runs without a shell, only allowlisted read subcommands are
  accepted, and Git calls time out after 30 seconds. Review's only extra Git
  surface is a fixed-argument diff wrapper (`git diff --cached` for staged
  content, `git diff-files` for unstaged content) that always passes
  `--no-ext-diff --no-textconv`, uses fixed prefixes and the Myers algorithm,
  forces `core.quotePath=true`, and scrubs `GIT_EXTERNAL_DIFF` and
  `GIT_DIFF_OPTS` from the child environment. A repository-configured external
  diff or textconv helper therefore cannot execute during review, which is
  proven by tests.
- **No network.** No HTTP, DNS, or socket APIs are imported.
- **No secret reading — with one documented review exception.** `status`,
  detection, and `init` only read file existence, `package.json` scripts, and
  an existing `ziki.json`; manifests over 1 MiB are skipped, and `.env` files,
  key material, ignored files, environment dumps, and source files are never
  read. `review` is the deliberate exception: to warn about leaked secrets it
  must inspect the content that is being reviewed — added diff lines of
  changed files and, within its caps, untracked files. When a `.env` file or
  key file is part of the reviewed change set, review reads **exactly that
  reviewed content**; it never reads an unchanged file's full contents, never
  prints file contents or matched values anywhere (findings carry only path,
  line, scope, and rule), and never scans files outside the reviewed change
  set. The PRD's SP-06 was clarified on 2026-10-28 to allow exactly this.
- **No agent edits.** Agent configuration files other than the three fixed
  templates are only listed — never parsed or modified. The skill/command
  templates are written by `init` with the same approval and no-clobber rules
  as `ziki.json`.
- **Terminal-safe output.** Control characters from repository data are escaped
  before human output, and `--debug` stack traces redact absolute paths outside
  the repository.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success, including dirty and detached repositories |
| `1` | Runtime error: not a Git repository, Git missing, unreadable state |
| `2` | Usage error: unknown command, unknown flag, extra argument |

Stack traces are printed only with `--debug`.

## Development

```console
$ npm test
$ npm run bench
```

`npm test` runs the functional suite. `npm run bench` runs the wall-clock
benchmark separately (p95 over five runs on a 500-file fixture, after one
warm-up run). The benchmark is separate because a wall-clock gate on a busy
machine measures contention, not the CLI.

The suite uses `node:test` and `node:assert/strict` only. Tests create
disposable Git repositories in the system temporary directory; they do not run
project scripts and do not touch sibling repositories.

## Install

### From a local tarball (verified for this version)

Build the package from a checkout and install it globally:

```console
$ npm pack
$ npm install -g ./ziki-cli-0.1.0.tgz
$ ziki --version
```

Or install it into a single project without touching the global prefix:

```console
$ npm install ./ziki-cli-0.1.0.tgz
$ npx ziki status
```

The tarball contains `bin/`, `src/`, `docs/`, and this README; tests and
fixtures are excluded. The CLI has no runtime dependencies and needs Node.js
20 or newer.

The installed command is named `ziki`. On some machines another tool already
uses that name (for example an unrelated bounty-platform CLI). If `ziki
--version` does not print this package's version, call the binary by path:
`node <install-prefix>/node_modules/ziki-cli/bin/ziki.js`.

### From npm (not available yet)

`ziki-cli` is **not published to npm**. Do not run `npm install -g ziki-cli`
until a release is published: the name is currently unclaimed there and the
command would install nothing. The planned command, once a release is
approved and published, is:

```console
$ npm install -g ziki-cli
```

## Status of the package

The package is `private` and `UNLICENSED` while the license and publishing
path are undecided, so `npm publish` is blocked on purpose. Publishing also
requires choosing a license and adding a `LICENSE` file. Run it from source
meanwhile:

```console
$ node bin/ziki.js --help
```
