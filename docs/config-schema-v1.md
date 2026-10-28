# `ziki.json` — configuration schema, version 1

`ziki.json` lives at the repository root. It is written by `ziki init --apply`
and read by later Ziki commands (`status` reads it for check labels;
`review` reads it as a check-state input). In Phase 2 it is the only file
Ziki creates.

The file is ordinary JSON with a trailing newline. Nothing in it is executable:
`checks` are suggestions, never commands Ziki runs.

## Example

```json
{
  "schemaVersion": 1,
  "checks": [
    {
      "name": "test",
      "command": "npm test",
      "source": "package.json#scripts.test"
    }
  ],
  "managedFiles": {},
  "integrity": {
    "algorithm": "sha256",
    "hash": "1d75eb29b555d6c5a66f0acc7942a770db091da463bc54c9e47db78238c67035"
  }
}
```

## Fields

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | integer | `1`. A newer value blocks `init` instead of being downgraded. |
| `checks` | array | Verification commands detected from project manifests. Regenerated from the repository on each apply. |
| `managedFiles` | object | Map of repository-relative path to `sha256:<64 hex>` for files Ziki generated. Empty in Phase 2; reserved for the Phase 4 skill and command files. |
| `integrity` | object | `{ "algorithm": "sha256", "hash": "<64 hex>" }`, described below. |
| `lastObserved` | array | Optional. Recorded check observations, see [`lastObserved`](#lastobserved-recorded-observations) for the definition |
| any other key | any JSON value | Preserved verbatim across runs. Ziki does not interpret it. |

Each check is:

| Key | Type | Meaning |
|---|---|---|
| `name` | string | Short label, for example `test` or `lint`. |
| `command` | string | Suggested command, for example `npm test`. Never executed by Ziki. |
| `source` | string | Where detection found it, for example `package.json#scripts.test`. |

Checks duplicate freely when two ecosystems both define a `test` check; the
`source` distinguishes them. An invalid or oversized manifest contributes
nothing and does not fail the command.

## Integrity hash

`integrity.hash` detects edits made outside Ziki. It is not a signature and does
not prove who wrote the file.

The hash is SHA-256 over `canonicalJson(document without "integrity")`, where
`canonicalJson` is JSON with object keys sorted at every depth and no
insignificant whitespace. Concretely:

1. Parse `ziki.json`.
2. Remove the `integrity` field.
3. Recursively sort object keys.
4. Serialize compactly and hash the UTF-8 bytes.

Because the hash covers the whole document, it also covers unknown fields that
Ziki preserves. Moving keys or changing whitespace does not change the hash;
changing any value does.

When the recorded hash does not match, `ziki init` refuses to rewrite the file
without `--confirm ziki.json`. It labels the file `integrity mismatch` when the
values are unchanged and the hash alone is wrong, and `modified since last
write` when values changed as well. This catches hand edits, merge accidents,
and truncated files. It does not stop an attacker who rewrites both the body and
the hash.

## `lastObserved` (recorded observations)

`lastObserved` is an optional top-level array. It is the mechanism Phase 2
designed for when a future command wants to record that a check produced a
result, without forcing `init` to keep per-check metadata: `init` regenerates
`checks` from manifests but preserves unknown top-level fields, and
`lastObserved` rides on that reservation.

**Ziki Phase 3 never writes `lastObserved`; no command in Phase 3 does.**
`ziki review` is read-only and consumes the field as an input when resolving
check state (see [`review-schema-v1.md` § 9.1](review-schema-v1.md)). The
field exists in the schema so a future, explicit recording command has a
documented, approved shape to write. Until such a command exists, the field
is only ever produced by an external tool or by hand.

Each entry:

| Key | Type | Meaning |
|---|---|---|
| `name` | string | Must equal the `name` of a `checks` entry, treated as `name` + `source` pairs |
| `command` | string | Must equal the check's command exactly, character-for-character |
| `source` | string | Must equal the check's `source` |
| `result` | string | `"passed"` or `"failed"` only |
| `exitCode` | integer or `null` | Exit code observed when recorded; `null` when the recorder had none |
| `observedAt` | string | ISO 8601 UTC with milliseconds; latest valid timestamp wins |

Matching and derived state are defined by the review schema: match by
`name` + `source`, require exact `command`, resolve by latest valid
timestamp. `passed` agrees only with exit code `null` or `0`; `failed`
disagrees with exit code `0`. Contradictory, malformed, future-dated, or
command-mismatched records produce an honest `unknown`, never a plausible
passing call.

Guarantees and notes:

- The integrity hash covers the whole document, so it covers `lastObserved`
  too: a file whose observations are hand-tampered no longer matches
  `integrity.hash` unless the hash is recomputed by hand. An `init --apply`
  rewrite preserves a valid `lastObserved` verbatim and the rewrite itself
  requires per-file confirmation an existing file gets anyway.
- Since Phase 3 writes nothing, an observation recorded by an external tool
  survives `init` because `init` preserves unknown top-level fields.
- The CLI never runs a check to produce an entry. `lastObserved` never means
  "Ziki passed this check"; it always means "some external record, stored in
  `ziki.json`, claims this result". Review labels observations as
  `recorded in ziki.json` accordingly.
- Do not put secrets in entries: `ziki.json` is not encrypted and may be
  committed.

## How `ziki init` treats the file

`ziki init` always builds a plan first. The plan is read-only and prints either
the complete proposed file or a line diff against the current file.

| Current file | Plan label | Write rule |
|---|---|---|
| Missing | `new` | Created by `--apply`. |
| Valid, hash matches, same content | `unchanged` | No write. A rerun needs no confirmation. |
| Valid, hash matches, new manifests | `update · changed` | Needs `--apply` plus `--confirm ziki.json`. |
| Valid, hash does not match, same values | `update · integrity mismatch` | Needs `--confirm ziki.json`. |
| Valid, hash does not match, values differ | `update · modified since last write` | Needs `--confirm ziki.json`. |
| Valid, no `integrity` field | `update · no recorded integrity` | Needs `--confirm ziki.json`. |
| Invalid JSON | `replace · not valid JSON` | Needs `--confirm ziki.json`. |
| JSON that is not a Ziki config | `replace · not a Ziki configuration` | Needs `--confirm ziki.json`. |
| `schemaVersion` newer than 1 | `blocked` | Never written. Upgrade the CLI. |
| Symlink, directory, or special file | Refused before planning | Never written. |

`--apply` requires explicit approval:

- on a terminal, Ziki prints the plan and asks `Apply these changes? [y/N]`;
- in a non-interactive shell, pass `--yes`;
- an existing or changed file still needs its own `--confirm <path>`, even with
  `--yes`. A global yes is not a per-file overwrite approval.

Nothing is written when any required confirmation is missing. Every target is
checked before the first write. Immediately before writing, Ziki re-reads the
target; if it changed, disappeared, or appeared after the plan, the apply is
refused and you must re-run `ziki init`. Writes are atomic: a fresh temporary
file in the target directory, `fsync`, then rename over the target, so an
interrupted write never leaves a half-written `ziki.json`. Temporary files are
removed on failure.

Ziki refuses to write through symlinks, into a directory, or outside the
repository root. Relative paths are the only accepted form.

## Stable reruns

The file contains no timestamps, build identifiers, or random values. The same
repository manifests and the same preserved fields produce byte-identical
output. Running `ziki init --apply --yes` twice in a row is a no-op.

## Limitations

- Check detection is heuristic and manifest-based. It is not a test runner.
- The integrity hash detects accidental edits, not deliberate forgery.
- `managedFiles` is recorded but unused until Phase 4; Phase 2 does not create
  skill or command files.
- `lastObserved` is documented for future use only; no Phase 3 command
  records observations, so review shows them as recorded facts, not
  Ziki-verified results.
- The file is not encrypted and must not contain secrets. Ziki never puts
  environment values in it.
