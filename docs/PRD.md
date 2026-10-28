# Ziki CLI — Product Requirements Document

| Field | Value |
|---|---|
| Product | Ziki CLI |
| Working package name | `ziki-cli` |
| Executable name | `ziki` |
| Document version | 0.3 |
| Date | 2026-10-28 |
| Document status | Phase 1 accepted 2026-10-28. Phase 2 (`init`) implemented and under review. Phase 3 (`review`) implemented and under review. Phase 4 (`/ziki` agent integration) implemented and under review. |
| Phase covered | Phases 1–4 (scaffold, `status`, `--json`, `init`, read-only `review`, agent skill/command templates, tests, README, schema docs) |
| Source of truth | Phase 1 research and architecture proposal in this session, verified 2026-10-28 |

> This document describes requirements. It does not authorize implementation.
> Nothing here should be read as approval of the product, the architecture, or
> any phase.

---

## 1. Product overview and problem statement

### 1.1 What Ziki CLI is

A zero-dependency Node.js command-line tool that runs beside a coding agent
(Claude Code, OpenCode, or any future harness) and gives the human a truthful,
low-effort view of three things:

1. **Where the project is** — branch, upstream divergence, working-tree state,
   last commit, which agent configurations exist, which verification commands
   are available.
2. **What changed** — a structural summary of the current diff and the checks
   that remain unfinished (later phase).
3. **How to collaborate** — a one-time, approval-gated setup that installs a
   shared skill and a `/ziki` slash command into the agent's native
   configuration directories (later phase).

The agent remains responsible for all coding. Ziki is the inspector and the
protocol, not the worker.

### 1.2 Problem statement

Agentic coding tools are good at producing changes and poor at telling a human
what state those changes are in. Today a developer must:

- run five or more `git` commands to answer "where am I?" at the start of a
  session;
- manually reconstruct what an agent did after a burst of edits;
- guess which checks were run, because "tests pass" is a claim, not evidence;
- repeat the same per-repo setup by hand for every project;
- re-explain the workflow to every fresh session, because agent context is
  disposable.

The result is lost context, unverifiable claims, inconsistent workflows, and a
human who cannot confidently approve work they cannot see.

### 1.3 Proposed solution

One small CLI with one job per verb:

| Verb | Job | Phase |
|---|---|---|
| `ziki init` | Inspect the project, propose a setup, write only after explicit approval | 2 |
| `ziki status` | Report repo truth in one command, human and JSON | **1** |
| `ziki review` | Summarize the diff and list unfinished checks | 3 |
| `/ziki` | Start a fixed human–agent workflow inside the agent harness | 4 |

Plus a separate, one-way dashboard for demonstration (Phase 5).

### 1.4 Non-goals

Ziki CLI is not a Git wrapper, not a test runner, not a code generator, not an
orchestrator of multiple agents, and not a hosted service. It never commits,
pushes, merges, publishes, or installs anything on its own.

---

## 2. Target users and main use cases

### 2.1 Personas

| ID | Persona | Context | Primary need |
|---|---|---|---|
| P1 | Solo developer | Uses Claude Code or OpenCode daily on one or more repos | Know the state of the repo without ceremony |
| P2 | Tech lead / reviewer | Reviews work produced partly by agents | See what changed and what was verified |
| P3 | New contributor | Clones a repo and opens a session | Reproduce the team's workflow without asking |
| P4 | Evaluator / demo audience | Watches the Vercel walkthrough | Understand the concept in under two minutes |

### 2.2 Use cases

| ID | Trigger | Flow | Success |
|---|---|---|---|
| UC-1 | Start of a working session | `ziki status` | Branch, divergence, dirty state, last commit, and available checks understood in one screen |
| UC-2 | After an agent finishes a task | `ziki review` | Human sees what changed by area and which checks remain unrun |
| UC-3 | Before committing | `ziki review` | Human decides with complete information; Ziki does not commit |
| UC-4 | First time in a repo | `ziki init` (Phase 2) | Setup proposed, previewed, then written only on approval |
| UC-5 | Handing work to another person or session | `ziki status --json` | Same facts, machine-readable, reproducible |
| UC-6 | Public demonstration | Vercel demo (Phase 5) | Concept understood without installing anything |

---

## 3. Product goals and measurable success criteria

| ID | Goal | Success criterion | How measured |
|---|---|---|---|
| G1 | Truth in one command | `ziki status` matches ground truth in 10/10 defined repo scenarios (clean, staged, modified, untracked, detached, unborn, no upstream, ahead, behind, conflicted) | Automated fixture tests |
| G2 | Zero mutation | `status` and `review` change no tracked content, refs, or working-tree files | AC-P1-13 plus a code-level Git allowlist test |
| G3 | Zero runtime dependencies | `dependencies` is empty in `package.json`; no third-party import in `src/` | Automated package + import scan |
| G4 | Fast | `ziki status --json` p95 under 2 seconds on a 500-file reference repo, excluding first-ever `npm` cold start | Local benchmark script |
| G5 | Portable | Identical behavior on Windows 11 and Ubuntu 24.04 | Local Windows gate in Phase 1; CI matrix added before publish |
| G6 | Machine-stable | JSON output validates against a versioned schema; identical input yields byte-identical output except `generatedAt` | Golden-file tests |
| G7 | Usable without docs | README quickstart works from a clean clone in one copy-paste | Manual acceptance check |
| G8 | Honest | Output never states that a check passed unless it was executed and observed by something that actually ran it | Requirement SP-09 plus tests forbidding success language in report modules |

**Anti-goals for measurement:** number of commands run, lines of code, number of
agent integrations, or any metric that rewards scope growth.

---

## 4. Phase 1 MVP requirements

Phase 1 ships exactly: package scaffold, basic CLI dispatch, working `status`,
`--json`, tests, README. Nothing else.

### 4.1 Deliverables

| ID | Requirement |
|---|---|
| P1-01 | `package.json` with `name: "ziki-cli"`, `version: "0.1.0"`, `type: "module"`, `bin: { "ziki": "./bin/ziki.js" }`, `engines.node: ">=20"`, `files` whitelist, and an empty `dependencies` object |
| P1-02 | `bin/ziki.js` contains only shebang, argument dispatch, and exit-code handling |
| P1-03 | `ziki --version` prints the version from `package.json` |
| P1-04 | `ziki --help` prints usage for the available commands and global flags |
| P1-05 | `ziki status` prints branch, upstream divergence, worktree counts, last commit, detected agent files, and detected verification commands |
| P1-06 | `ziki status --json` prints the schema-versioned JSON document defined in 4.3 |
| P1-07 | Unknown command or flag prints usage to stderr and exits 2, without a stack trace |
| P1-08 | Running outside a Git repository prints a clear error and exits 1; it does not suggest or perform `git init` |
| P1-09 | Status performs no writes to the project or to user configuration |
| P1-10 | Unit tests for every parser and integration tests for the CLI contract |
| P1-11 | `README.md` with install, usage, JSON example, guarantees, limitations |
| P1-12 | Phase 1 runs from source (`node bin/ziki.js`) and via `npm exec` from the package directory; it is not published to npm in Phase 1 |

### 4.2 `ziki status` human output

Required facts, in a stable order:

```
ziki status
  repo      /path/to/repo (cwd: packages/app)
  branch    feat/x  ->  origin/dev  ahead 2, behind 1
  worktree  2 staged · 1 modified · 3 untracked  (not clean)
  last      a1b2c3d  fix: handle empty diff  (2 hours ago)
  agents    claude-skill      .claude/skills/ziki/SKILL.md
            opencode-command  .opencode/commands/ziki.md
  checks    test   npm test        (detected, not run)
            lint   npm run lint    (detected, not run)
```

Rules:

- Every value comes from an executed `git` or filesystem read. No inference.
- Relative times ("2 hours ago") appear only in human output. JSON carries
  absolute ISO 8601 timestamps.
- "not run" is mandatory wording for every check. The words "passed", "green",
  or "ok" must never describe a check in Phase 1.
- Color is disabled when stdout is not a TTY or when `NO_COLOR` is set.
- Paths are printed relative to the repository root; the root itself is absolute.

### 4.3 `ziki status --json` contract

```json
{
  "schemaVersion": 1,
  "tool": { "name": "ziki-cli", "version": "0.1.0" },
  "generatedAt": "2026-10-28T12:00:00.000Z",
  "repo": {
    "root": "/absolute/path",
    "cwd": "packages/app",
    "isGitRepo": true,
    "branch": "feat/x",
    "detached": false,
    "head": "a1b2c3d4e5f6",
    "upstream": { "name": "origin/dev", "ahead": 2, "behind": 1 },
    "lastCommit": {
      "sha": "a1b2c3d4e5f6...",
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
    { "kind": "claude-skill", "path": ".claude/skills/ziki/SKILL.md" },
    { "kind": "opencode-command", "path": ".opencode/commands/ziki.md" }
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

Contract rules:

- `schemaVersion` is an integer, starts at `1`, and only changes for breaking
  changes. Additive fields do not bump it.
- Field order is fixed by the serializer so output is deterministic.
- `upstream` is `null` when no upstream is configured.
- `branch` is `null` and `detached` is `true` on a detached HEAD; `head` carries
  the commit.
- `head` is `null` on an unborn branch.
- `checks[].executed` is always `false` in Phase 1. The field exists so later
  phases can report observed execution without changing the shape.
- No ANSI escapes, no locale-dependent text, no absolute times other than ISO
  8601 UTC strings.

### 4.4 Detection scope (Phase 1)

Agents detected by file presence only:

| Kind | Path |
|---|---|
| `claude-skill` | `.claude/skills/*/SKILL.md` |
| `claude-command` | `.claude/commands/*.md` |
| `opencode-skill` | `.opencode/skills/*/SKILL.md` |
| `opencode-command` | `.opencode/commands/*.md` |
| `agents-skill` | `.agents/skills/*/SKILL.md` |
| `instructions` | `AGENTS.md`, `CLAUDE.md` at repo root |

Verification commands detected, never executed:

| Ecosystem | Signal | Suggested command |
|---|---|---|
| Node | `package.json` scripts `test`, `lint`, `typecheck`, `build` | the script itself |
| Flutter | `pubspec.yaml` | `flutter test`, `flutter analyze` |
| Go | `go.mod` | `go test ./...` |
| Rust | `Cargo.toml` | `cargo test` |

Every detected check is labeled `source` and `executed: false`. Detection is
explicitly heuristic and documented as such in the README.

---

## 5. Functional requirements

Phase tags: **P1** = Phase 1, **P2** = init, **P3** = review, **P4** = agent
integrations, **P5** = distribution and demo.

| ID | Phase | Requirement |
|---|---|---|
| FR-01 | P1 | Resolve the repository root with `git rev-parse --show-toplevel`; resolve the current directory relative to it |
| FR-02 | P1 | Report the current branch, or detached state with the commit |
| FR-03 | P1 | Report the configured upstream and ahead/behind counts; report absence explicitly |
| FR-04 | P1 | Count staged, modified, untracked, deleted, renamed, and conflicted entries using `git status --porcelain=v1 -z` |
| FR-05 | P1 | Report the last commit: full sha, short sha, subject, ISO date |
| FR-06 | P1 | Detect agent configuration files by presence, never by parsing their contents |
| FR-07 | P1 | Detect verification commands from manifests and label their source |
| FR-08 | P1 | Emit the versioned JSON document on `--json`, with no human decoration |
| FR-09 | P1 | Emit the human report with stable ordering and plain-language labels |
| FR-10 | P1 | Exit 0 on success, 1 on runtime error (not a repo, git missing), 2 on usage error |
| FR-11 | P1 | Disable color when stdout is not a TTY or `NO_COLOR` is set |
| FR-12 | P1 | `--help` and `--version` work without a repository |
| FR-13 | P1 | Handle empty repositories (unborn branch) and detached HEAD without crashing |
| FR-14 | P2 | `ziki init --plan` prints every file that would be created or amended, with contents, and writes nothing |
| FR-15 | P2 | `ziki init --apply` writes only after explicit approval; refuses to overwrite any existing file unless that specific file is confirmed |
| FR-16 | P2 | Record content hashes in `ziki.json`; refuse to overwrite a file that changed since it was recorded |
| FR-17 | P2 | Never modify `AGENTS.md`, `CLAUDE.md`, or agent skill/command files without a displayed diff and approval |
| FR-18 | P3 | Summarize the working diff by directory: files, insertions, deletions, plus the ten largest changed files; directory and list summaries are capped and the caps are reported |
| FR-19 | P3 | Report the state of each configured check as `not run`, `unknown`, or `observed` with the exact command and timestamp; never infer `passed`; a recorded `lastObserved` observation is labeled as recorded in `ziki.json`, never as verified by Ziki |
| FR-20 | P3 | Scan added diff lines (staged and unstaged) and scanned untracked text for secret-shaped strings and warn with file and line; redact the matched value from every report, log, and JSON; findings carry only path, line, scope, and rule |
| FR-21 | P4 | Install a shared skill in the cross-tool location that both Claude Code and OpenCode load |
| FR-22 | P4 | Generate a Claude Code slash command file using only documented frontmatter fields |
| FR-23 | P4 | Generate an OpenCode slash command file using only documented frontmatter fields |
| FR-24 | P4 | The `/ziki` command starts the fixed workflow: status, plan, human approval, work, verify, review, present decisions |
| FR-25 | P5 | Produce a packed tarball that installs and runs with zero dependencies |
| FR-26 | P5 | Emit deterministic demo fixtures tagged as mock data for the separate dashboard |

---

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | Node.js `>=20`; ESM only; no transpilation step |
| NFR-02 | Zero runtime dependencies; dev dependencies are limited to the Node built-in test runner and nothing that ships |
| NFR-03 | No network access at runtime, ever |
| NFR-04 | No telemetry, analytics, crash reporting, or update checks |
| NFR-05 | Deterministic output: stable key order, stable list order, ISO 8601 UTC timestamps |
| NFR-06 | Cross-platform: Windows, macOS, Linux; no shell interpolation of user paths; no Bash-only assumptions |
| NFR-07 | Startup budget: `ziki --version` under 200 ms excluding Node process start |
| NFR-08 | Report budget: `status` p95 under 2 s on the reference repo |
| NFR-09 | All Git invocations use `spawn` with `shell: false` and an explicit argument array |
| NFR-10 | Every user-visible error names the failed action and the next safe step; no stack traces unless `--debug` |
| NFR-11 | Output remains readable at 80 columns and with color disabled |
| NFR-12 | Code is organized so that Phase 2 to 4 features can be added without changing the Phase 1 JSON contract |

---

## 7. Safety, privacy, and read-only guarantees

These are product guarantees, not implementation preferences. Violating one is a
release blocker.

| ID | Guarantee |
|---|---|
| SP-01 | `status` and `review` never change tracked content, refs, or working-tree files. Git optional locks are disabled, so reading status does not refresh `.git/index`; review reads unstaged content with `git diff-files` for the same reason |
| SP-02 | The Git wrapper runs without a shell and exposes an explicit allowlist of read-only operations: `rev-parse`, `symbolic-ref`, `status`, `rev-list`, and `log`. Mutating commands (`add`, `commit`, `push`, `pull`, `merge`, `rebase`, `reset`, `checkout`, `switch`, `restore`, `clean`, `stash`, `tag`, `branch -d`, `remote set-url`) and config/diff execution paths are not implemented anywhere in the codebase. Repo-config-driven execution (`core.fsmonitor`, signature verification) is disabled. The one Phase 3 extension is a fixed-argument diff wrapper exposing exactly `git diff --cached` (staged) and `git diff-files` (unstaged); the wrapper always passes `--no-ext-diff --no-textconv --no-color --no-relative`, fixed `a/ b/` prefixes, `--submodule=short`, `--diff-algorithm=myers`, `--ignore-submodules=none`, `-M`, and `core.quotePath=true`, and scrubs `GIT_EXTERNAL_DIFF` and `GIT_DIFF_OPTS` from the child environment, so no caller can add flags, pathspecs, or an output path, and a repo-configured diff helper cannot execute |
| SP-03 | Ziki never executes project scripts or tests in Phases 1 to 3. Verification commands are reported, not run |
| SP-04 | No network calls, no package downloads, no update checks |
| SP-05 | No credentials, API keys, tokens, or environment dumps in any output or log |
| SP-06 | `status`, detection, and `init` do not read `.env` files, key material, or ignored-file contents. **Clarified 2026-10-28 (decision OD-13):** `review` is the deliberate exception — to warn about leaked secrets it reads exactly the content under review: added diff lines of changed files and, within its caps, untracked files that are part of the reviewed change set. It never reads unchanged files' full contents, never prints file contents or matched values in any output, JSON, error, or debug path, and findings carry only path, line, scope, and rule |
| SP-07 | Any future file write is atomic, confined to the repository root, and preceded by an approval gate |
| SP-08 | Symlinks are reported, never followed for writes; review additionally never follows symlinks when reading untracked files |
| SP-09 | The product never reports a check as passed unless that check was executed and its result observed. Phase 1 has no execution path at all, so every check is "not run". Phase 3 keeps review execution-free: an `observed` state comes only from a matching, valid `lastObserved` record in `ziki.json` and is always labeled as recorded there, never as Ziki-verified; review never writes observations |
| SP-10 | `--debug` may add diagnostics but must still redact Ziki's own absolute source paths and any value matching secret patterns |
| SP-11 | Uninstalling the CLI leaves no state behind: no cache directory, no global config, no daemon |

---

## 8. Scope boundaries

### 8.1 Explicitly excluded from Phase 1

- `ziki init` and any file generation
- `ziki review` and diff analysis
- Secret scanning and redaction (belongs to review)
- Skill and slash-command templates
- Changes to `AGENTS.md`, `CLAUDE.md`, or any agent configuration
- Any network call, telemetry, or update check
- Test execution of any kind
- npm publishing
- The Vercel demo
- Multiple agents, sessions, or orchestration
- Configuration file support (`ziki.json` arrives with `init`)

### 8.2 Later phases

| Phase | Scope |
|---|---|
| 2 | `ziki init`: plan, approval, `ziki.json`, no-clobber and hash tracking |
| 3 | `ziki review`: diff summary, check states, secret warnings and redaction |
| 4 | Skill and `/ziki` command generation for Claude Code and OpenCode |
| 5 | Packaging, optional publish, separate Vercel demo with mock fixtures |

### 8.3 Permanently out of scope

- Auto-commit, auto-push, auto-merge, auto-publish
- Hosted accounts, cloud sync, team dashboards with live data
- Running or judging tests on the user's behalf
- Any LLM call made by the CLI itself
- Multi-agent scheduling or bounty-platform features

---

## 9. Acceptance criteria

### 9.1 Phase 1 automated criteria

| ID | Criterion |
|---|---|
| AC-P1-01 | `ziki --version` exits 0 and prints exactly the `version` from `package.json` |
| AC-P1-02 | `ziki --help` exits 0 and lists `status` and the global flags |
| AC-P1-03 | An unknown command exits 2, writes usage to stderr, and prints no stack trace |
| AC-P1-04 | Running in a non-Git directory exits 1 with a clear message and no stack trace |
| AC-P1-05 | Fixture with 2 staged, 1 modified, 3 untracked reports exactly those counts and exits 0 |
| AC-P1-06 | Fixture with an upstream 2 ahead and 1 behind reports exactly 2 and 1 |
| AC-P1-07 | Fixture without an upstream reports `upstream: null` in JSON and a plain message in human output |
| AC-P1-08 | Detached HEAD reports `branch: null`, `detached: true`, and the commit in `head` |
| AC-P1-09 | Unborn branch exits 0 and reports `head: null` together with correct worktree counts |
| AC-P1-10 | Paths containing spaces parse correctly; newline-containing paths parse correctly where the operating system permits them, and the test is documented as skipped on Windows when it does not |
| AC-P1-11 | `status --json` parses as JSON, validates against the documented schema, and reports `schemaVersion: 1` |
| AC-P1-12 | JSON contains no ANSI escapes and all timestamps are ISO 8601 UTC |
| AC-P1-13 | After `status`, the working-tree file hashes and the output of `git rev-parse HEAD` and `git for-each-ref` are unchanged |
| AC-P1-14 | `package.json` has an empty `dependencies` object and no source file imports a network module |
| AC-P1-15 | Fixture containing `.claude/skills/ziki/SKILL.md`, `.opencode/commands/ziki.md`, `AGENTS.md`, and `CLAUDE.md` detects all four with repository-relative paths |
| AC-P1-16 | Fixture `package.json` with `test`, `lint`, and `build` scripts produces three checks with `executed: false` and the correct `source`; a stubbed process runner fails the test if any of them is invoked |
| AC-P1-17 | A dirty repository exits 0; dirtiness is informational, never an error |
| AC-P1-18 | Running `status` twice on the same input produces byte-identical JSON except `generatedAt` |
| AC-P1-19 | The reference benchmark reports p95 under 2 seconds over five runs on a 500-file fixture |

### 9.2 Phase 1 manual criteria

| ID | Criterion |
|---|---|
| AC-P1-M01 | README quickstart works from a clean clone in PowerShell and in Git Bash |
| AC-P1-M02 | Human output is readable at 80 columns with color disabled |
| AC-P1-M03 | On a real cloned repository, `ziki status` matches `git status` and `git log -1` checked side by side |
| AC-P1-M04 | With an `.env` file present in the repository, no secret value appears in output, because the file is never read |

### 9.3 Later-phase criteria (not Phase 1)

| ID | Criterion |
|---|---|
| AC-P2-01 | `init --plan` writes nothing; the filesystem snapshot before and after is identical |
| AC-P2-02 | `init --apply` refuses to overwrite any existing file without per-file confirmation |
| AC-P3-01 | A diff containing a fake API key is warned about with file and line, and the value is redacted from JSON, human output, errors, and debug output |
| AC-P3-02 | `review` never prints "passed" for a check it did not execute; `observed` appears only for a matching valid `lastObserved` record and is labeled `recorded in ziki.json` |
| AC-P3-03 | `review --json` conforms to `docs/review-schema-v1.md`: fixed key order, ISO timestamps, no ANSI escapes, documented nullability |
| AC-P3-04 | Staged, unstaged, untracked, renamed, binary, mode-change, conflicted, and unborn-HEAD scenarios are all reported explicitly, and unusual filenames survive `-z` parsing and C-quoting |
| AC-P3-05 | After `review`, tracked-file hashes, `git rev-parse HEAD`, refs, and `git diff --cached` are unchanged, and `.git/index` is byte-identical including its mtime |
| AC-P3-06 | A repository-configured external diff and textconv helper is not executed during review (a marker control proves the helper would run outside review) |
| AC-P3-07 | A diff containing a fake secret in a file whose added lines exceed the caps is reported `partial`/`not-scanned` with reasons, never as clean |
| AC-P3-08 | Review performs no file writes anywhere in its call tree (verified statically and behaviorally) and runs no project script |
| AC-P3-09 | When Git is missing or a diff read fails or times out, review fails or reports the scope unavailable with reasons; it never invents data |
| AC-P3-10 | `init` reruns preserve a recorded `lastObserved` block verbatim, and `review` resolves observations by latest valid timestamp, exact command match, and contradiction checks |
| AC-P4-01 | The generated skill loads in both Claude Code and OpenCode from the shared location. Automation proves the documented location, minimal frontmatter, and name/directory match (`tests/integration/harness-contract.test.js`); official docs confirm both harnesses read `.claude/skills/<name>/SKILL.md`. **Caveat verified 2026-10-28:** when a user-level skill named `ziki` also exists (the bounty platform on this machine), Claude Code resolves personal over project and OpenCode de-duplicates names, so the generated skill is shadowed — a live OpenCode probe in a generated repo reported the bounty skill's description |
| AC-P4-02 | Both slash command files load and invoke the workflow without a frontmatter warning. Automation proves documented paths and description-only frontmatter (Claude Code merges commands into skills; OpenCode reads `.opencode/commands/`). Live invocation is a manual check and is **not yet verified on this machine** |
| AC-P5-01 | `npm pack` tarball installs in a clean directory and runs with zero production dependencies |

---

## 10. Technical constraints and testing strategy

### 10.1 Constraints

- Node.js `>=20` (verified locally on 24.16.0), ESM, no build step.
- Git `>=2.20` (verified locally on 2.53.0), invoked as an external binary.
- Argument parsing with the Node standard library; no CLI framework.
- No YAML parsing dependency: generated templates are static files, and
  detection only checks file presence.
- JSON schema is documented in the repository and versioned by
  `schemaVersion`.
- Absolute timestamps in machine output; relative phrasing only in human output,
  which keeps golden tests deterministic.
- Windows is a first-class target: no shell interpolation, no POSIX-only path
  handling, no reliance on Bash.

### 10.2 Phase 1 structure (proposed)

```
ziki-cli/
├─ package.json
├─ bin/ziki.js                 # shebang + dispatch only
├─ src/
│  ├─ cli.js                   # arg parsing, routing, exit codes
│  ├─ commands/status.js       # orchestrates reads, renders nothing itself
│  ├─ git/{root,branch,upstream,worktree,lastCommit}.js
│  ├─ detect/{agents,checks}.js
│  └─ report/{human,json,color}.js
├─ docs/PRD.md                 # this document
├─ docs/status-schema-v1.md    # JSON contract
├─ tests/{unit,integration,fixtures}/
└─ README.md
```

### 10.3 Testing strategy

| Layer | Approach |
|---|---|
| Unit | Pure parser functions tested with fixture strings: porcelain `-z`, `rev-list --left-right --count`, detection tables |
| Integration | Temporary Git repositories created under the OS temp directory at test time; the CLI is spawned as a child process and its stdout, stderr, and exit code asserted |
| Contract | Golden JSON files plus a schema validator written in the test suite; required keys and types asserted explicitly |
| Determinism | Each scenario runs twice; outputs compared byte-for-byte except `generatedAt` |
| Safety | Snapshot hashes of the working tree, `HEAD`, and refs before and after read-only commands |
| Cross-platform | Windows gate in Phase 1; Linux and macOS added to CI before publish |
| No network | Tests fail if a network module is imported; no test requires connectivity |

Framework: the Node built-in test runner (`node --test`). No test framework
dependency. No coverage percentage gate in Phase 1; instead, every documented
parser case must have a corresponding test.

---

## 11. Risks, dependencies, assumptions, and open decisions

### 11.1 Risks

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R-01 | Git output parsing breaks on renames, submodules, or unusual filenames | Wrong counts, lost trust | `-z` parsing, fixture tests, explicit unsupported-case documentation |
| R-02 | Windows path and encoding differences | Platform-specific failures | Windows-first testing, no shell interpolation |
| R-03 | Agent configuration formats change between versions | Phase 4 templates stop loading | Generate only documented fields, verify in live sessions, keep templates isolated per harness |
| R-04 | Brand collision with an existing product also named Ziki | Confusion, unpublishable name | Use `ziki-cli` as the package; brand decision tracked as OD-01 |
| R-05 | Users read "not run" as "failing" or read status as a quality signal | Misunderstanding | Explicit wording, README limitations section |
| R-06 | Large diffs make `review` slow (Phase 3) | Poor experience | Areas and counts first, cap detailed file lists |
| R-07 | Secret scanning produces false negatives | False sense of security | Document as best-effort, never a security control |
| R-08 | Scope creep into orchestration, cloud, or dashboards | Delays Phase 1 | This document's exclusions are normative |
| R-09 | Single maintainer | Bus factor | Small surface, tests, documented architecture |
| R-10 | npm name ownership and publish rights | Distribution blocked | Package name verified available; publish is Phase 5 and optional |

### 11.2 Dependencies

| ID | Dependency | Needed by | Status |
|---|---|---|---|
| D-01 | Node.js `>=20` | All phases | Verified available (24.16.0) |
| D-02 | Git binary | All phases | Verified available (2.53.0) |
| D-03 | npm registry access | Phase 5 | Not required for Phase 1 |
| D-04 | Claude Code and OpenCode installed | Phase 4 verification | Available on this machine |
| D-05 | Vercel account | Phase 5 demo | Separate repository, not a runtime dependency |
| D-06 | Public repository host | Phase 1 | Open decision OD-04 |

### 11.3 Assumptions

| ID | Assumption |
|---|---|
| A-01 | The user runs the CLI inside a Git repository |
| A-02 | Node.js 20 or newer is available |
| A-03 | English-only output is acceptable for the internship scope |
| A-04 | Zero network access is acceptable and desirable |
| A-05 | Agent harnesses continue to support the documented skill and command directories |
| A-06 | Phase 1 does not need any configuration file to be useful |
| A-07 | Repository-relative paths are the right default for machine output |

### 11.4 Open decisions

None of these block Phase 1 unless marked.

| ID | Decision | Default if unresolved | Blocks Phase 1? |
|---|---|---|---|
| OD-01 | Relationship between this product's brand and the existing internal Ziki bounty platform | Treat as separate products; package name `ziki-cli` | No |
| OD-02 | Publish to npm or demonstration-only | Demonstration-only until Phase 5 review | No |
| OD-03 | License | Decide before publish | No |
| OD-04 | Repository host and organization | Local repository for Phase 1 | No |
| OD-05 | Minimum supported Node version | `>=20` | No |
| OD-06 | JSON versioning policy | Integer `schemaVersion`, additive changes only within a major | No |
| OD-07 | Exit code when the worktree is dirty | Exit 0, informational | No |
| OD-08 | OpenCode command directory: singular `command/` (observed on this machine) versus plural `commands/` (documented) | Detect both; write to the documented plural in Phase 4 | Resolved 2026-10-28: detection reads both, `init` writes only the plural |
| OD-09 | Whether `status` shows detected checks before `init` exists | Yes, labeled `detected`, `executed: false` | No |
| OD-10 | Demo site framework | Static or Next.js on Vercel | No (Phase 5) |
| OD-11 | Support for ecosystems beyond Node, Flutter, Go, and Rust | None in Phase 1 | No |
| OD-12 | Telemetry | None, permanently | No |
| OD-13 | SP-06 vs. review's need to read reviewed content | Resolved 2026-10-28: review reads only added diff lines and capped untracked files that are part of the reviewed change set, never prints contents or matched values; `status`/`init`/detection keep the original never-read guarantee | No (documented; see SP-06) |

---

## 12. CLI, agent integrations, and Vercel demo

Three artifacts, three consumers, one direction of dependency.

| Artifact | Consumer | Lives in | Phase | Depends on | Failure isolation |
|---|---|---|---|---|---|
| CLI (`ziki-cli` / `ziki`) | Humans and agents | Its own npm package and repository | 1 | Git and Node only | Works with no agent installed |
| Shared skill | Agents (Claude Code, OpenCode) | `.claude/skills/ziki/SKILL.md` in the target repository | 4 | CLI | Removing the skill leaves the CLI usable |
| Slash command `/ziki` | Humans, inside the agent harness | `.claude/commands/ziki.md` for Claude Code; `.opencode/commands/ziki.md` for OpenCode | 4 | The shared skill | Harness-specific; one may work while the other is broken |
| Vercel demo | Evaluators and public | Separate repository | 5 | Published JSON schema and committed fixtures only | CLI never imports, calls, or requires the site |

```
Human ──► CLI (source of truth)
  │           ▲
  │           │ executed by the agent
  ▼           │
Agent harness ──► shared skill ──► /ziki workflow
  │
  └─ generated by `ziki init` (Phase 2)

Vercel demo ◄── schema + mock fixtures only ── CLI (one-way, offline)
```

Rules:

1. The CLI is the only component that reads the repository. The demo never
   reads a real repository.
2. The skill and commands are generated artifacts, never runtime dependencies.
3. The demo never becomes a data source for the CLI.
4. Removing the demo changes nothing about the CLI. Removing the CLI disables
   the skill, the commands, and the demo fixtures, in that order.
5. The demo is always labeled **mock data, not live**, in the page itself.

---

## Appendix A — Verified facts behind this document (2026-10-28)

| Fact | Source |
|---|---|
| Node 24.16.0, npm 11.9.0, Git 2.53.0 on the development machine | Local environment check |
| The workspace is a multi-repository overlay, not a Git repository, and has no root `package.json` | Local inspection |
| npm package `ziki` is taken (v0.1.1); `ziki-cli`, `zikicli`, `ziki-dev`, `ziki-agent` were available | npm registry query |
| Claude Code skills: `.claude/skills/<name>/SKILL.md`; command files `.claude/commands/<name>.md` are merged into skills; skills follow the Agent Skills open standard | Official Claude Code documentation |
| OpenCode skills: `.opencode/skills/<name>/SKILL.md`, `~/.config/opencode/skills/`, and Claude-compatible `.claude/skills/`; commands `.opencode/commands/<name>.md` with `description`, `agent`, `subtask`, `model` | Official OpenCode documentation |
| One skill directory can serve both harnesses because OpenCode reads `.claude/skills/` | Official OpenCode documentation |
| Command files with `description` and `agent` frontmatter work in both harnesses today | Existing files on this machine |

Anything not listed here is an assumption and is tracked in 11.3.
