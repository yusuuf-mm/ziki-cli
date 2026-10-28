# `ziki status --json` — schema version 1

**Status:** normative for Phase 1. Implementations must conform to this document.
**Consumer:** any script, agent, or dashboard that reads `ziki status --json`.
**Producer:** `ziki-cli` 0.1.x.

This document describes the machine contract only. Human output is not part of
the contract and may change without notice.

## 1. Encoding and determinism

| Rule | Value |
|---|---|
| Encoding | UTF-8 |
| Format | JSON object, 2-space indentation, trailing newline |
| Key order | Fixed by the producer; consumers must not rely on it but tests do |
| Timestamps | ISO 8601 UTC with milliseconds, e.g. `2026-10-28T12:00:00.000Z` |
| ANSI escapes | Never present |
| Localized text | Never present |
| Field stability | Same input produces byte-identical output except `generatedAt` |

## 2. Paths

| Field | Form |
|---|---|
| `repo.root` | Absolute path in the platform's native form |
| `repo.cwd` | Path of the invocation directory relative to `repo.root`, using `/` separators; `"."` when they are equal |
| `agents[].path` | Repository-relative path using `/` separators |
| `checks[].source` | Manifest reference such as `package.json#scripts.test`; never an absolute path |

Paths never contain a trailing slash. No path is percent-encoded.

## 3. Top-level object

| Key | Type | Null | Description |
|---|---|---|---|
| `schemaVersion` | integer | no | Always `1` for this document |
| `tool` | object | no | Producer identity, see 3.1 |
| `generatedAt` | string | no | ISO 8601 UTC timestamp of the run |
| `repo` | object | no | Repository facts, see 4 |
| `worktree` | object | no | Working-tree tallies, see 5 |
| `agents` | array | no | Agent configuration files detected, see 6; empty when none |
| `checks` | array | no | Verification commands detected, see 7; empty when none |

### 3.1 `tool`

| Key | Type | Description |
|---|---|---|
| `name` | string | `"ziki-cli"` |
| `version` | string | Semver of the running package |

## 4. `repo`

| Key | Type | Null | Description |
|---|---|---|---|
| `root` | string | no | Absolute repository root |
| `cwd` | string | no | Invocation directory relative to root, `/` separators |
| `isGitRepo` | boolean | no | Always `true`; a non-repository produces an error, not a document |
| `branch` | string | **yes** | Current branch; `null` on a detached HEAD |
| `detached` | boolean | no | `true` when HEAD is not on a branch |
| `head` | string | **yes** | Full 40-character commit SHA; `null` on an unborn branch |
| `upstream` | object | **yes** | See 4.1; `null` when no upstream is configured |
| `lastCommit` | object | **yes** | See 4.2; `null` when the repository has no commits |

### 4.1 `repo.upstream`

| Key | Type | Null | Description |
|---|---|---|---|
| `name` | string | no | Upstream reference, e.g. `origin/main` |
| `ahead` | integer | **yes** | Commits on HEAD not on the upstream; `null` when divergence cannot be computed |
| `behind` | integer | **yes** | Commits on the upstream not on HEAD; `null` when divergence cannot be computed |

`ahead` and `behind` are both integers or both `null`.

### 4.2 `repo.lastCommit`

| Key | Type | Description |
|---|---|---|
| `sha` | string | Full commit SHA |
| `shortSha` | string | Abbreviated SHA as reported by Git |
| `subject` | string | Commit subject line, single line |
| `date` | string | Committer date, ISO 8601 UTC with milliseconds |

## 5. `worktree`

All values are non-negative integers except `clean`.

| Key | Type | Counts |
|---|---|---|
| `staged` | integer | Entries with a non-space index status (`A`, `M`, `D`, `R`, `C`), excluding conflicts |
| `modified` | integer | Entries with unstaged worktree status `M` |
| `untracked` | integer | Entries with status `??` |
| `deleted` | integer | Entries with `D` in either column |
| `renamed` | integer | Entries with index status `R` or `C` |
| `conflicted` | integer | Unmerged entries: `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU` |
| `clean` | boolean | `true` only when all six counters are zero |

**Counting semantics.** Counters are category tallies, not a partition. One
entry may increment more than one counter: a staged deletion increments both
`staged` and `deleted`. Conflicted entries are counted only in `conflicted`.
Ignored files are never counted.

## 6. `agents`

Each entry:

| Key | Type | Description |
|---|---|---|
| `kind` | string | One of `claude-skill`, `claude-command`, `opencode-skill`, `opencode-command`, `agents-skill`, `instructions` |
| `path` | string | Repository-relative path, `/` separators |

Detection is by file presence only. Contents are never parsed, and no file is
modified. Entries are sorted by `path` ascending, then `kind`.

Recognized locations:

| Kind | Location |
|---|---|
| `claude-skill` | `.claude/skills/<name>/SKILL.md` |
| `claude-command` | `.claude/commands/<name>.md` |
| `opencode-skill` | `.opencode/skills/<name>/SKILL.md` |
| `opencode-command` | `.opencode/commands/<name>.md` |
| `agents-skill` | `.agents/skills/<name>/SKILL.md` |
| `instructions` | `AGENTS.md` or `CLAUDE.md` at the repository root |

## 7. `checks`

Each entry:

| Key | Type | Description |
|---|---|---|
| `name` | string | Short label: `test`, `lint`, `typecheck`, `build`, or `analyze` |
| `command` | string | Suggested command, e.g. `npm test` |
| `source` | string | Where detection came from, e.g. `package.json#scripts.test` |
| `executed` | boolean | **Always `false` in schema version 1** |

`executed` exists so later phases can report observed execution without
changing the shape. In version 1 the CLI has no execution path, so every value
is `false`. Consumers must not treat a check as passing unless a later schema
version says it was executed and observed.

Detection is heuristic and additive:

| Ecosystem | Signal | Entries |
|---|---|---|
| Node | `package.json` scripts `test`, `lint`, `typecheck`, `build` | One per present script |
| Flutter | `pubspec.yaml` | `test` → `flutter test`; `analyze` → `flutter analyze` |
| Go | `go.mod` | `test` → `go test ./...` |
| Rust | `Cargo.toml` | `test` → `cargo test` |

An unreadable or invalid manifest contributes no entries and never causes an
error.

## 8. Nullability summary

A consumer must handle these without crashing:

| Condition | Fields set to `null` |
|---|---|
| Detached HEAD | `repo.branch`; `repo.detached` is `true` |
| Unborn branch | `repo.head`, `repo.lastCommit` |
| No upstream | `repo.upstream` |
| Upstream configured, divergence unavailable | `repo.upstream.ahead`, `repo.upstream.behind` |
| No agents detected | `agents` is `[]` |
| No checks detected | `checks` is `[]` |

## 9. Example

```json
{
  "schemaVersion": 1,
  "tool": {
    "name": "ziki-cli",
    "version": "0.1.0"
  },
  "generatedAt": "2026-10-28T12:00:00.000Z",
  "repo": {
    "root": "/home/dev/project",
    "cwd": ".",
    "isGitRepo": true,
    "branch": "feat/status",
    "detached": false,
    "head": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    "upstream": {
      "name": "origin/main",
      "ahead": 2,
      "behind": 1
    },
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
    {
      "kind": "claude-skill",
      "path": ".claude/skills/ziki/SKILL.md"
    }
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

## 10. Versioning

- `schemaVersion` is an integer and starts at `1`.
- Additive fields do not change the version. Consumers must ignore unknown keys.
- Removing or retyping a field, changing a field's meaning, or changing a
  non-null field to null is a breaking change and requires a new version.
- A change from `executed: false` to a richer execution object would require a
  new version.

## 11. Safety properties encoded in this contract

- The document contains no file contents, only paths.
- The document contains no environment variables, credentials, or diff text.
- Producing the document performs no writes and no network access.
- No field implies that a check ran; `executed` is `false` everywhere.
