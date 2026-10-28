# `ziki review --json` — schema version 1

**Status:** normative for Phase 3. Implementations must conform to this document.
**Consumer:** any script, agent, or dashboard that reads `ziki review --json`.
**Producer:** `ziki-cli` 0.1.x.

This document describes the machine contract. The human report is described in
§12; its exact layout is not a contract and may change between minor releases.

`ziki review` reports facts about the working tree. It is read-only: it writes
no file, changes no ref, does not refresh `.git/index`, runs no project
command, and touches no network. Every section is honest about what could not
be inspected instead of pretending it was scanned.

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
| Secret values | Never present, in any field, ever |

## 2. Paths

| Field | Form |
|---|---|
| `repo.root` | Absolute path in the platform's native form |
| `repo.cwd` | Invocation directory relative to `repo.root`, `/` separators; `"."` when equal |
| `files[].path`, `files[].oldPath` | Repository-relative, `/` separators |
| `areas[].path` | Repository-relative top-level directory, or `"."` for root files |

Paths never contain a trailing slash. No path is percent-encoded. Paths are
decoded from Git's quoting; when the path contains a control or non-ASCII
character the JSON string contains the real character (escaped as `\uXXXX`
per the JSON encoder), never Git's octal form.

## 3. Top-level object

| Key | Type | Null | Description |
|---|---|---|---|
| `schemaVersion` | integer | no | Always `1` for this document |
| `tool` | object | no | Producer identity: `{ "name": "ziki-cli", "version": "<semver>" }` |
| `generatedAt` | string | no | ISO 8601 UTC timestamp of the run |
| `repo` | object | no | Repository facts, see 4 |
| `changes` | object | no | Staged, unstaged, and untracked changes, see 5 |
| `areas` | array | no | Directory summaries, see 7; empty when the tree is clean |
| `largest` | array | no | The ten largest known-stat changes, see 8 |
| `checks` | object | no | Verification-check state, see 9 |
| `secrets` | object | no | Secret-pattern findings over added lines, see 10 |
| `limits` | object | no | Applied caps and which were hit, see 13 |
| `warnings` | array | no | Limitation notices, see 14; empty when nothing is incomplete |

`repo.head` is the full commit SHA. The `repo` object here has no
`lastCommit`/`upstream`/`isGitRepo` keys; consumers must not copy assumptions
from the `status` schema.

## 4. `repo`

| Key | Type | Null | Description |
|---|---|---|---|
| `root` | string | no | Absolute repository root |
| `cwd` | string | no | Invocation directory relative to root |
| `branch` | string | **yes** | Current branch; `null` on a detached HEAD |
| `detached` | boolean | no | `true` when HEAD is not on a branch |
| `head` | string | **yes** | Full commit SHA; `null` when unborn or unreadable |
| `unborn` | boolean | no | `true` when the branch has no commits |

When both `branch` and `head` are `null`, HEAD could not be read at all; a
`head-unavailable` warning is added and existence of commits is unknown.

## 5. `changes`

| Key | Type | Null | Meaning |
|---|---|---|---|
| `complete` | boolean | no | `true` only when the working-tree read, the staged diff, and the unstaged diff all succeeded. **Meaning changed-file metadata is complete;** untracked contents have their own availability |
| `statsComplete` | boolean | no | `true` when every total in `summary.insertions/deletions` is exact |
| `filesTruncated` | boolean | no | `true` when any detail list was capped (`maxFilesListed`, `maxUntrackedFiles`) |
| `staged` | object | no | Index-state scope, see 5.1 |
| `unstaged` | object | no | Worktree-state scope, same shape as `staged` |
| `untracked` | object | no | Untracked files with read contents, see 5.4 |
| `summary` | object | no | Whole-report tallies, see 5.5 |

Counts are metadata tallies taken from `status --porcelain`. A file can appear
in more than one scope (staged and unstaged); totals count occurrences per
scope, not distinct paths.

### 5.1 Scope view (`staged` / `unstaged`)

| Key | Type | Null | Description |
|---|---|---|---|
| `available` | boolean | no | `false` when the diff could not be read at all |
| `complete` | boolean | no | `true` when the raw and numstat reads both succeeded |
| `error` | string | **yes** | Why the scope is unavailable; `null` otherwise |
| `reasons` | array of string | no | Human-readable limitation notes; empty when none |
| `files` | array | no | File records, see 5.2; capped at `maxFilesListed` |
| `filesTotal` | integer | **yes** | Total changed entries; `null` only when unavailable |
| `filesListed` | integer | no | Entries in `files` |
| `truncated` | boolean | no | `true` when `filesTotal` > `filesListed` |
| `counts` | object | no | Per-`change` tally, see 5.3 |
| `statsComplete` | boolean | no | `true` when every listed file has exact stats |
| `insertions` / `deletions` | integer | **yes** | Line totals for all changed entries; `null` when any entry lacks stats |
| `binary` | integer | no | Count of binary file entries |
| `contentAvailable` | boolean | no | `false` when the patch read failed (added lines could not be scanned) |
| `contentComplete` | boolean | no | `false` when the patch was truncated |

`insertions`/`deletions` are report-wide totals for the scope, not sums of the
listed `files` — with `truncated: true` the totals still cover every entry.

### 5.2 File record

| Key | Type | Null | Description |
|---|---|---|---|
| `path` | string | no | New path |
| `oldPath` | string | **yes** | Previous path for renames and copies |
| `change` | string | no | One of `added`, `modified`, `deleted`, `renamed`, `copied`, `typechange`, `conflicted`, `unknown` |
| `status` | string | no | Raw Git status code, e.g. `R100`, `M`, `??` |
| `renamed`, `copied`, `conflicted` | boolean | no | Convenience flags derived from `change` |
| `binary` | boolean | **yes** | `true` when Git reports a binary diff; `false` when text; `null` when stats are unavailable |
| `insertions`, `deletions` | integer | **yes** | Per-file line counts; `null` for binaries, conflicted entries, or unavailable stats |
| `stats` | string | no | One of `exact`, `binary`, `unavailable` |
| `modeChange` | boolean | no | `true` when the file mode changed; added/deleted entries (where one side has mode `000000`) never set it |
| `scope` | string | no | `staged` or `unstaged` |

A conflicted entry's per-file stats are `unavailable` because Git's combined
diff cannot produce them; the file is still counted and listed.

### 5.3 Scope `counts`

Non-negative integers, keyed `added`, `modified`, `deleted`, `renamed`,
`copied`, `typechange`, `conflicted`, `unknown`. This is a tally per `change`
value: entries counted `conflicted` occur once, in `conflicted`. It counts
every entry in the scope, including ones not in the capped `files` list.

### 5.4 Untracked scope

| Key | Type | Null | Description |
|---|---|---|---|
| `available` | boolean | no | `false` when `git status` failed; then `files` is empty |
| `error` | string | **yes** | Why unavailable |
| `files` | array | no | File records, see below; capped at `maxUntrackedFiles` |
| `filesTotal` | integer | **yes** | Total untracked entries |
| `filesListed` | integer | no | Entries in `files` |
| `truncated` | boolean | no | `true` when some files were not read (cap, bytes, symlink, unreadable, binary, or budget) |
| `omitted` | integer | **yes** | Count of entries read-skipped because the file cap was reached |
| `insertions` | integer | **yes** | Total added-line count over scanned text files; `null` when totals are unknown |
| `bytes` | integer | **yes** | Total bytes read; `null` only when unavailable |
| `binary` | integer | no | Count of binary untracked entries |
| `scannedFiles`, `scannedLines` | integer | no | Text files (or parts) actually scanned |
| `reasons` | array of string | no | Limitation notes |

Each untracked file record:

| Key | Type | Null | Description |
|---|---|---|---|
| `path` | string | no | Repository-relative path |
| `content` | string | no | One of `scanned`, `scanned-partial`, `binary`, `unreadable`, `not-scanned` |
| `binary` | boolean | **yes** | `true` for binary; `null` when it could not be determined |
| `bytes` | integer | **yes** | File size in bytes at read time (before any read truncation) |
| `insertions` | integer | **yes** | Counted lines; `null` unless scanned |
| `reason` | string | **yes** | Why the file was not fully inspected; `null` when scanned completely |

Only regular files are read. Symlinks are recorded `not-scanned` with reason
`symlink; not followed`. `scanned-partial` entries still contribute their
scanned lines to `scannedLines` and their read bytes to the global scan
budget, while `bytes` always reports the full file size.

### 5.5 `summary`

| Key | Type | Null | Description |
|---|---|---|---|
| `files` | integer | **yes** | `staged.filesTotal + unstaged.filesTotal + untracked.filesTotal`, per-scope occurrences; `null` when any scope is unavailable |
| `insertions`, `deletions` | integer | **yes** | Whole-report line totals; `null` when `statsComplete` is `false` |
| `binary` | integer | no | Binary entries across scopes |
| `added`, `modified`, `deleted`, `renamed`, `copied`, `typechange`, `conflicted`, `unknown` | integer | no | Tallies over staged ∪ unstaged scopes (`conflicted` counts distinct paths) |
| `untracked` | integer | no | `untracked.filesTotal`, or `0` when untracked state was unavailable — distinguish via `changes.untracked.available` |
| `statsComplete` | boolean | no | Same meaning as for the scope, across all three scopes |

`summary.files === 0` means the tree is clean in all three scopes; `null` means
state could not be read.

## 6. `staged` / `unstaged` semantics

- **Staged** changes are read with `git diff --cached`. On an unborn branch
  (`repo.unborn`) this works because Git diffs the index against the empty
  tree; stage-before-first-commit is therefore reported normally.
- **Unstaged** changes are read with `git diff-files`, not `git diff`: normal
  `git diff` refreshes `.git/index` even with `GIT_OPTIONAL_LOCKS=0`, and
  review must not modify the index. This is verified by tests.
- Unstaged delete-and-recreate of a file is **not** matched as a rename when
  the new path is untracked. Such a case is reported as a staged/untracked
  deletion plus an untracked file, not a rename.
- `git diff-files --raw` can mark a file as modified because cached stat
  information is stale even when content matches; numstat is authoritative for
  the unstaged file list, and raw-only entries are appended when they differ
  only in mode or state.
- Conflicted files: the combined diff is not parsed for added lines; the entry
  is listed, counted, excludes per-file stats, and a `conflicted-files`
  warning is emitted.

## 7. `areas`

Array of directory summaries; top-level directory (relative, `/`), or `"."`
when a changed file is at the root. Files at the same path in several scopes
count once per scope. A file appears under its **new** area after a rename.

| Key | Type | Null | Description |
|---|---|---|---|
| `path` | string | no | Top-level directory or `"."` |
| `files` | integer | no | File entries counted; one file present in two scopes counts twice |
| `insertions`, `deletions` | integer | no | Sum of known per-file stats; unknown entries contribute 0 and set `statsComplete: false` |
| `statsComplete` | boolean | no | `false` when at least one included file lacks exact stats |
| `scopes` | array of string | no | Sorted subset of `staged`, `unstaged`, `untracked` |

Order: descending by known lines (`insertions + deletions`), then `files`
descending, then path ascending; capped at `maxAreas` entries.

## 8. `largest`

The ten largest changes with known stats, ordered the same way (descending
converted lines, then path ascending, then scope).

| Key | Type | Description |
|---|---|---|
| `path` | string | Repository-relative |
| `scope` | string | `staged`, `unstaged`, or `untracked` |
| `change` | string | Same domain as `changes.*.files[].change`; untracked entries are `"untracked"` |
| `insertions`, `deletions` | integer | Exact line counts; files with unknown stats are never included |

## 9. `checks`

Verification commands as state, never execution. Review never runs a check,
never replaces `not run` with evidence, and does not claim `passed`.

| Key | Type | Null | Description |
|---|---|---|---|
| `source` | string | no | `"ziki.json"` or `"detected"` |
| `detail` | string | **yes** | Explanation when the source is degraded or unavailable |
| `items` | array | no | Check records |

Check record:

| Key | Type | Null | Description |
|---|---|---|---|
| `name` | string | no | Short label |
| `command` | string | no | The suggested command string; Ziki never runs it |
| `source` | string | no | Where it came from |
| `origin` | string | no | `"ziki.json"` or `"detected"` |
| `state` | string | no | One of `not run`, `unknown`, `observed` |
| `observed` | object | **yes** | See below; exactly `null` unless `state === "observed"` |
| `detail` | string | **yes** | Why state is `unknown`; used by the human renderer |

State meanings:

| State | Meaning |
|---|---|
| `not run` | Recorded or detected, but no verified evidence that it produced a result |
| `unknown` | Evidence exists but is unusable, contradictory, out of date, or from a different command |
| `observed` | A recorded observation matching the check's exact name+source+command exists in `ziki.json` |

`observed` object (exactly these keys):

| Key | Type | Description |
|---|---|---|
| `result` | string | `"passed"` or `"failed"` |
| `exitCode` | integer (`null` allowed) | Exit code recorded alongside the result; omitted/`null` when the recorder did not provide one |
| `observedAt` | string | ISO 8601 UTC timestamp recorded with the observation |
| `recordedIn` | string | Always `"ziki.json#lastObserved"` |

### 9.1 `lastObserved` resolution rules

`lastObserved` is an optional `ziki.json` top-level field; see
[`config-schema-v1.md`](config-schema-v1.md#lastObserved-recorded-observations)
for the storage format. **Review is read-only. Phase 3 never writes `lastObserved`;
no command in this release does.** It is an input to check resolution only.

Resolution rules for each check:

1. Candidate observations match `name` **and** `source`; the `command` must
   also match exactly, character-for-character.
2. The **latest valid timestamp wins** (largest `observedAt`).
3. An observation is valid only if its `result` is `passed`/`failed`, its
   `observedAt` parses as ISO 8601 UTC, it is not more than 5 minutes in the
   future, and `exitCode` is consistent (`passed` disagrees when `exitCode`
   is a non-zero integer; `failed` disagrees when `exitCode === 0`). A
   malformed, future-dated, contradictory, or command-mismatched record never
   produces `observed`; it produces `unknown` with a `detail` explanation.
   A malformed matching record with no valid alternative also produces
   `unknown`.

4. Observations that match no configured check are reported via warning
   `observations-unmatched`; malformed entries via `observations-invalid`.
5. When `ziki.json` is absent, `source` is `"detected"` and every item is
   `not run`. When `ziki.json` exists but cannot be used, `source` is
   `"detected"` with `detail` and every item is `unknown`.
6. An integrity mismatch adds warning `config-integrity-mismatch`; recorded
   observations are still resolved, but a consumer cannot trust a hash a
   mismatched file's secrets or observations.

## 10. `secrets`

Best-effort pattern pass over **added** lines only (staged patch additions,
unstaged patch additions, and scanned untracked text). It is a **warning
system, not a security control**. Findings do not mean a secret is valid;
absence of findings never implies the tree is clean. Unscanned channels
(binary files, substitution-diff conflicts, >8 KiB lines, exhausted budgets)
are stated explicitly rather than counted as clean.

| Key | Type | Null | Description |
|---|---|---|---|
| `state` | string | no | One of `scanned`, `partial`, `not-scanned` |
| `findings` | array | no | Findings, sorted; capped at `maxFindings` |
| `scanned` | object | no | `{ stagedLines, unstagedLines, untrackedLines, totalLines }` |
| `truncated` | boolean | no | Same as the boolean that drives `state` below |
| `reasons` | array of string | no | Why completeness was not reached; empty when `state === "scanned"` |

State semantics — the state must reflect what was actually scanned, never what
was skipped as equivalent:

| State | Meaning |
|---|---|
| `scanned` | Every scannable channel was scanned; nothing was skipped, truncated, or over-limit |
| `partial` | At least one added line was scanned, but some channel was skipped, truncated, or over-limit |
| `not-scanned` | No added line was scanned at all (for example, every diff read failed) |

`partial` versus `not-scanned` is honest: review does not report `not-scanned`
just because one binary file was skipped, nor `scanned` when a channel was
dropped. `reasons` always explains exactly what was missed.

Secret finding (only these four keys — **the matched value is never stored,
serialized, logged, or included in any error**, and cannot be recovered from a
finding):

| Key | Type | Description |
|---|---|---|
| `path` | string | Repository-relative path |
| `line` | integer | Line in the file (untracked: line within the scanned prefix) |
| `scope` | string | `staged`, `unstaged`, or `untracked` |
| `rule` | string | Pattern identifier, see 10.1 |

### 10.1 Rule identifiers

| Rule id | Detects |
|---|---|
| `private-key` | PEM private-key header (`-----BEGIN ... PRIVATE KEY-----`) |
| `aws-access-key-id` | 20-character access-key prefixes (`AKIA…`, `ASIA…`, and friends) |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and `github_pat_` tokens |
| `gitlab-token` | `glpat-` tokens |
| `slack-token` | `xoxa/b/p/r/s-` tokens |
| `stripe-key` | `sk/pk/rk_(live|test)_` keys |
| `google-api-key` | `AIza…` keys |
| `anthropic-api-key` | `sk-ant-…` keys |
| `openai-api-key` | `sk-…` keys |
| `npm-token` | 36-character `npm_` tokens |
| `jwt` | Three-segment `eyJ…` JWTs |
| `bearer-token` | `Bearer <16-char+>` values |
| `url-credentials` | `scheme://user:password@host` built-ins |
| `credential-assignment` | Generic `password/secret/api-key = value` assignments; ignores process-env references, template placeholders, and example values by pattern; single-line value must be ≥ 8 chars |
| `credential-assignment-multiline` | Generic assignment whose value follows in one of the next three added lines (YAML literal blocks) |

One line can produce multiple findings when several distinct patterns match.
A specific provider pattern wins over the generic rule for the same line.
Findings are deduplicated, then sorted: scope (staged, unstaged, untracked),
then path, line, rule.

## 11. What review never claims

- `state: "scanned"` for secrets does **not** mean the tree has no secrets; it
  means every scannable channel was checked against the listed patterns.
- `run complete` / `changes.complete` says nothing about untracked file
  contents (`untracked.truncated` covers those).
- No check is ever claimed `passed` by the CLI. Only a matching, valid
  `lastObserved` record can produce `observed`, and it is labeled as
  recorded-in-`ziki.json`, not observed-by-Ziki.
- No commit, push, merge, or review decision is ever taken by review; it is
  read-only, and it never writes `ziki.json`.

## 12. Human output (not a contract)

Plain terminal text with the same facts in sections: repo header (branch,
HEAD, scope counts, summary), `changed files` per scope with splice/capped
markers, `areas`, `largest changes`, `checks` with per-check states and any
detail, `secrets` with a scanned/lines-guard statement, reasons, and `!`-lines
for findings (`path:line [scope] rule`), followed by `limits hit` and
`warnings` and the footer
`read-only: no files were written and no project commands were run`.
Up to 20 files per scope and 20 findings are shown inline; `--json` holds the
complete data. Secret values never appear; findings name path, line, scope,
and rule only.

## 13. `limits`

All numeric limits; the `hit` array lists the names of the caps that were
reached, sorted, using these names:

| Key | Type | Meaning |
|---|---|---|
| `maxDiffBytes` | integer | Retained bytes per `--raw`/`--numstat`/`--patch` read (8 MiB) |
| `maxAddedLines` | integer | Added lines scanned across the whole review (20,000) |
| `maxLineLength` | integer | Added-line length scanned for patterns (8 KiB; longer lines are truncated and counted) |
| `maxFindings` | integer | Retained secret findings (200) |
| `maxUntrackedFiles` | integer | Untracked files fully read (200) |
| `maxUntrackedFileBytes` | integer | Bytes read per untracked file (512 KiB) |
| `maxUntrackedScanBytes` | integer | Total bytes read across untracked files (4 MiB) |
| `maxFilesListed` | integer | File entries in changed-file detail lists (500) |
| `maxAreas` | integer | Directory summaries (20) |
| `maxLargest` | integer | Largest-change entries (10) |
| `hit` | array | Names of caps reached this run: one of `diff-bytes`, `added-lines`, `line-length`, `findings`, `untracked-files`, `untracked-bytes`, `untracked-scan-bytes`, `file-list`, `areas` |

`hit: []` means no cap prevented a complete report.

## 14. `warnings`

Array of `{ "code": string, "message": string }`, deduplicated and sorted by
`code`. Active codes:

| Code | Reason |
|---|---|
| `config-unusable` | `ziki.json` exists but cannot be read as a valid Ziki config |
| `config-integrity-mismatch` | `ziki.json` does not match its recorded integrity hash |
| `last-observed-invalid` | `lastObserved` is not an array |
| `observations-invalid` | Some recorded observations are not objects |
| `observations-unmatched` | Some recorded observations match no configured check |
| `head-unavailable` | `HEAD` could not be read at all |
| `worktree-unavailable` | The working tree state could not be read (`git status` failed) |
| `staged-unavailable` | The staged diff could not be read |
| `unstaged-unavailable` | The unstaged diff could not be read |
| `untracked-incomplete` | Untracked files were not fully inspected for any reason |
| `untracked-unavailable` | Untracked files are unknown because status failed |
| `conflicted-files` | Conflicted files exist; their combined diffs were not scanned |
| `file-list-truncated` | Changed-file detail lists hit the `maxFilesListed` cap |

## 15. Errors and exit codes

| Situation | Behavior |
|---|---|
| Not a repository (or any parent) | Error, exit 1 |
| `git` missing | Error, exit 1 |
| Any single read fails | No crash and no invented data; the relation is marked unavailable, with `reasons` and a warning |
| A malformed request (`--plan`, extra argument) | Usage error, exit 2, no stack trace |
| `--debug` | Adds a stack trace; still redacts absolute paths outside the repository and never adds secret values |

## 16. Safety notes for implementers and reviewers

- The Git surface is allowlisted. `review` uses `rev-parse`, `symbolic-ref`,
  `status`, `rev-list`, `log`, plus the fixed diff wrapper exposing exactly
  three modes: `git diff --cached` (staged), `git diff-files` (unstaged),
  both with the fixed flag set; no caller can add flags, pathspecs, or output
  files.
- The wrapper always sets `--no-ext-diff --no-textconv --no-color --no-relative`,
  fixed `a/ b/` prefixes, `--submodule=short`, `--diff-algorithm=myers`,
  `--ignore-submodules=none`, `-M`, and `core.quotePath=true`, and scrubs
  `GIT_EXTERNAL_DIFF` and `GIT_DIFF_OPTS` from the child environment. A
  repository-configured diff helper therefore cannot execute during review
  (proven by tests).
- Every Git invocation has a 30-second timeout and a spawn-output cap.
- Untracked content is read with `fs.lstat`/`open`/`read` synchronous calls:
  regular files only, no symlink following, capped bytes per file and total,
  and never a write.
- Review never writes `ziki.json`, never touches the index, never runs a
  project command, and never takes user-visible action beyond printing.
- A consumer must supply its own approval workflow before acting on any
  review finding; the review result is a report, not a decision.
