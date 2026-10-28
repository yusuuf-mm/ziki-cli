import { runGit } from './run.js';
import { RuntimeError } from '../errors.js';

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` into individual
 * entries. In -z mode a rename/copy entry is followed by the original path as
 * its own NUL-separated field; the entry's own path is the new path.
 */
export function parsePorcelainEntries(raw) {
  const fields = raw.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }

  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === '' || entry.length < 3) {
      continue;
    }

    const x = entry[0];
    const y = entry[1];
    const status = `${x}${y}`;
    let path = entry.slice(3);
    let origPath = null;

    if (x === 'R' || x === 'C') {
      origPath = fields[index + 1] ?? null;
      index += 1;
    }

    entries.push({
      x,
      y,
      status,
      path,
      origPath,
      untracked: status === '??',
      conflicted: UNMERGED.has(status),
    });
  }

  return entries;
}

/**
 * Count working-tree categories. Counters are category tallies, not a
 * partition: a staged deletion counts in both `staged` and `deleted`.
 * Conflicted entries count only as conflicted.
 */
export function parsePorcelainZ(raw) {
  const counts = {
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
    clean: true,
  };

  for (const entry of parsePorcelainEntries(raw)) {
    if (entry.untracked) {
      counts.untracked += 1;
      continue;
    }

    if (entry.conflicted) {
      counts.conflicted += 1;
      continue;
    }

    if (entry.x === 'R' || entry.x === 'C') {
      counts.renamed += 1;
    }

    if (entry.x !== ' ' && entry.x !== '?') {
      counts.staged += 1;
    }
    if (entry.y === 'M') {
      counts.modified += 1;
    }
    if (entry.x === 'D' || entry.y === 'D') {
      counts.deleted += 1;
    }
  }

  counts.clean =
    counts.staged === 0 &&
    counts.modified === 0 &&
    counts.untracked === 0 &&
    counts.deleted === 0 &&
    counts.renamed === 0 &&
    counts.conflicted === 0;

  return counts;
}

/**
 * Read the working-tree state once and return both tallies and entries for
 * the review path.
 *
 * Repo config can point `core.fsmonitor` at an executable and
 * `status.submoduleSummary` at a diff summary; both are disabled so reading
 * status cannot trigger repo-controlled commands.
 */
export function collectWorktree(cwd) {
  const result = runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    {
      cwd,
      config: {
        'core.fsmonitor': 'false',
        'status.submoduleSummary': 'false',
      },
    },
  );
  if (result.status !== 0) {
    throw new RuntimeError(
      `git status failed: ${result.stderr.trim() || 'unknown error'}`,
    );
  }

  const entries = parsePorcelainEntries(result.stdout);
  return {
    counts: parsePorcelainZ(result.stdout),
    entries,
  };
}

/** Working-tree tallies for the repository containing cwd. */
export function getWorktree(cwd) {
  return collectWorktree(cwd).counts;
}
