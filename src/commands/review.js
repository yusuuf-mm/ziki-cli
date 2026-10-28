import fs from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '../git/root.js';
import { getBranchState } from '../git/branch.js';
import { collectWorktree } from '../git/worktree.js';
import { collectChangeScope } from '../git/changes.js';
import { collectUntracked } from '../review/untracked.js';
import { collectChecks } from '../review/checks.js';
import { createScanBudget, scanAddedLines } from '../review/secrets.js';
import { REVIEW_LIMITS } from '../review/limits.js';
import { RuntimeError } from '../errors.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

function realCwd(cwd) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function relativeCwd(root, cwd) {
  const relative = path.relative(root, realCwd(cwd));
  if (relative === '') {
    return '.';
  }
  return relative.split(path.sep).join('/');
}

function topLevelArea(filePath) {
  const slash = filePath.indexOf('/');
  return slash === -1 ? '.' : filePath.slice(0, slash);
}

function scopeView(scope) {
  return {
    available: scope.available,
    complete: scope.complete,
    error: scope.error,
    reasons: scope.reasons,
    files: scope.files,
    filesTotal: scope.filesTotal,
    filesListed: scope.filesListed,
    truncated: scope.truncated,
    counts: scope.counts,
    statsComplete: scope.statsComplete,
    insertions: scope.insertions,
    deletions: scope.deletions,
    binary: scope.binary,
    contentAvailable: scope.contentAvailable,
    contentComplete: scope.contentComplete,
  };
}

function unavailableUntracked() {
  return {
    available: false,
    error: 'working-tree state could not be read',
    files: [],
    filesTotal: null,
    filesListed: 0,
    truncated: true,
    omitted: null,
    insertions: null,
    bytes: null,
    binary: 0,
    scannedFiles: 0,
    scannedLines: 0,
    reasons: ['untracked files are unknown because git status failed'],
  };
}

function untrackedView(untracked) {
  return {
    available: untracked.available,
    error: untracked.error,
    files: untracked.files,
    filesTotal: untracked.filesTotal,
    filesListed: untracked.filesListed,
    truncated: untracked.truncated,
    omitted: untracked.omitted,
    insertions: untracked.insertions,
    bytes: untracked.bytes,
    binary: untracked.binary,
    scannedFiles: untracked.scannedFiles,
    scannedLines: untracked.scannedLines,
    reasons: untracked.reasons,
  };
}

function buildAreas({ staged, unstaged, untracked, maxAreas }) {
  const areas = new Map();

  const add = (filePath, insertions, deletions, scope) => {
    if (!filePath) {
      return;
    }
    const area = topLevelArea(filePath);
    let entry = areas.get(area);
    if (!entry) {
      entry = {
        path: area,
        files: 0,
        insertions: 0,
        deletions: 0,
        statsComplete: true,
        scopes: new Set(),
      };
      areas.set(area, entry);
    }
    entry.files += 1;
    entry.scopes.add(scope);
    if (typeof insertions === 'number' && typeof deletions === 'number') {
      entry.insertions += insertions;
      entry.deletions += deletions;
    } else {
      entry.statsComplete = false;
    }
  };

  for (const file of staged.allFiles) {
    add(file.path, file.insertions, file.deletions, 'staged');
  }
  for (const file of unstaged.allFiles) {
    add(file.path, file.insertions, file.deletions, 'unstaged');
  }
  for (const file of untracked.files) {
    add(file.path, file.insertions, file.deletions ?? 0, 'untracked');
  }

  const sorted = [...areas.values()]
    .map((entry) => ({
      path: entry.path,
      files: entry.files,
      insertions: entry.insertions,
      deletions: entry.deletions,
      statsComplete: entry.statsComplete,
      scopes: [...entry.scopes].sort(),
    }))
    .sort((left, right) => {
      const leftChange = left.insertions + left.deletions;
      const rightChange = right.insertions + right.deletions;
      if (rightChange !== leftChange) {
        return rightChange - leftChange;
      }
      if (right.files !== left.files) {
        return right.files - left.files;
      }
      return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    });

  return {
    items: sorted.slice(0, maxAreas),
    truncated: sorted.length > maxAreas,
  };
}

function buildLargest({ staged, unstaged, untracked, maxLargest }) {
  const candidates = [];

  const add = (file, scope, change) => {
    if (typeof file.insertions !== 'number' || typeof file.deletions !== 'number') {
      return;
    }
    candidates.push({
      path: file.path,
      scope,
      change,
      insertions: file.insertions,
      deletions: file.deletions,
    });
  };

  for (const file of staged.allFiles) {
    add(file, 'staged', file.change);
  }
  for (const file of unstaged.allFiles) {
    add(file, 'unstaged', file.change);
  }
  for (const file of untracked.files) {
    add(
      { path: file.path, insertions: file.insertions, deletions: 0 },
      'untracked',
      'untracked',
    );
  }

  candidates.sort((left, right) => {
    const leftChange = left.insertions + left.deletions;
    const rightChange = right.insertions + right.deletions;
    if (rightChange !== leftChange) {
      return rightChange - leftChange;
    }
    if (left.path !== right.path) {
      return left.path < right.path ? -1 : 1;
    }
    return left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0;
  });

  return candidates.slice(0, maxLargest);
}

function scanScope(scope, budget, maxLineLength) {
  const groups = new Map();
  for (const addition of scope.additions) {
    let lines = groups.get(addition.path);
    if (!lines) {
      lines = [];
      groups.set(addition.path, lines);
    }
    lines.push({ number: addition.line, text: addition.text });
  }

  let scanned = 0;
  let stopped = false;
  let longLines = 0;

  for (const [filePath, lines] of groups) {
    const result = scanAddedLines(lines, {
      path: filePath,
      scope: scope.scope,
      budget,
      maxLineLength,
    });
    scanned += result.scanned;
    longLines += result.longLines;
    stopped = stopped || result.stopped;
    if (budget.exhausted || budget.findingsTruncated) {
      break;
    }
  }

  return { scanned, stopped, longLines };
}

function uniqueSortedFindings(findings) {
  const scopeOrder = { staged: 0, unstaged: 1, untracked: 2 };
  const seen = new Set();
  const result = [];
  for (const finding of findings) {
    const key = `${finding.scope}\0${finding.path}\0${finding.line}\0${finding.rule}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(finding);
  }
  result.sort((left, right) => {
    const scope = (scopeOrder[left.scope] ?? 9) - (scopeOrder[right.scope] ?? 9);
    if (scope !== 0) {
      return scope;
    }
    if (left.path !== right.path) {
      return left.path < right.path ? -1 : 1;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0;
  });
  return result;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}

/**
 * Collect a review report. Read-only: it starts allowlisted git reads and
 * reads untracked files, but it never writes a project file, changes the
 * index, runs a project command, or touches the network.
 */
export function collectReview({ cwd, now = Date.now(), limits = REVIEW_LIMITS } = {}) {
  const root = getRepoRoot(cwd);
  if (!root) {
    throw new RuntimeError(`not a git repository (or any parent): ${cwd}`);
  }

  const generatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const { branch, head, detached } = getBranchState(root);
  const unborn = Boolean(branch && !head);
  const headUnavailable = !branch && !head;

  let worktree = null;
  let worktreeError = null;
  try {
    worktree = collectWorktree(root);
  } catch {
    worktreeError = 'working-tree state could not be read';
  }

  const conflictedPaths = new Set(
    worktree ? worktree.entries.filter((entry) => entry.conflicted).map((entry) => entry.path) : [],
  );

  const staged = collectChangeScope({
    cwd: root,
    staged: true,
    conflictedPaths,
    limits,
  });
  const unstaged = collectChangeScope({
    cwd: root,
    staged: false,
    conflictedPaths,
    limits,
  });

  const budget = createScanBudget({
    maxFindings: limits.maxFindings,
    maxAddedLines: limits.maxAddedLines,
  });

  const stagedScan = scanScope(staged, budget, limits.maxLineLength);
  const unstagedScan = scanScope(unstaged, budget, limits.maxLineLength);

  const untrackedEntries = worktree
    ? worktree.entries.filter((entry) => entry.untracked)
    : [];
  const untracked = worktree
    ? collectUntracked({
        root,
        entries: untrackedEntries,
        limits,
        budget,
      })
    : unavailableUntracked();

  const checksResult = collectChecks({ root, now });
  const limitsHit = new Set([
    ...staged.limitsHit,
    ...unstaged.limitsHit,
    ...(untracked.limitsHit ?? []),
  ]);

  if (budget.exhausted) {
    limitsHit.add('added-lines');
  }
  if (budget.findingsTruncated) {
    limitsHit.add('findings');
  }
  if (budget.longLines > 0) {
    limitsHit.add('line-length');
  }

  const areas = buildAreas({
    staged,
    unstaged,
    untracked,
    maxAreas: limits.maxAreas,
  });
  if (areas.truncated) {
    limitsHit.add('areas');
  }
  const largest = buildLargest({
    staged,
    unstaged,
    untracked,
    maxLargest: limits.maxLargest,
  });

  const secretReasons = [];
  for (const scope of [staged, unstaged]) {
    if (!scope.available) {
      secretReasons.push(`${scope.scope} changes were unavailable, so they were not scanned`);
      continue;
    }
    if (!scope.contentAvailable) {
      secretReasons.push(`${scope.scope} diff text was unavailable, so added lines were not scanned`);
    }
    if (scope.contentComplete === false && scope.contentAvailable) {
      secretReasons.push(...scope.contentReasons);
    }
    if (scope.binary > 0) {
      secretReasons.push(
        `${scope.binary} binary file${scope.binary === 1 ? ' in' : 's in'} ${scope.scope} changes ${scope.binary === 1 ? 'was' : 'were'} not scanned`,
      );
    }
    if (scope.conflicted > 0) {
      secretReasons.push(
        `${scope.conflicted} conflicted file${scope.conflicted === 1 ? ' in' : 's in'} ${scope.scope} changes ${scope.conflicted === 1 ? 'was' : 'were'} not scanned`,
      );
    }
  }
  secretReasons.push(...untracked.reasons);
  if (budget.exhausted) {
    secretReasons.push(`secret scanning stopped at the ${limits.maxAddedLines} added-line limit`);
  }
  if (budget.findingsTruncated) {
    secretReasons.push(`the ${limits.maxFindings}-finding limit was reached`);
  }
  if (budget.longLines > 0) {
    secretReasons.push(
      `${budget.longLines} added line${budget.longLines === 1 ? '' : 's'} were longer than ${limits.maxLineLength} characters and were only partly scanned`,
    );
  }

  const scopeIncomplete = [staged, unstaged].some(
    (scope) =>
      !scope.available ||
      !scope.contentAvailable ||
      !scope.contentComplete ||
      scope.binary > 0 ||
      scope.conflicted > 0,
  );
  const secretsTruncated =
    scopeIncomplete ||
    untracked.truncated ||
    budget.exhausted ||
    budget.findingsTruncated ||
    budget.longLines > 0;
  const anyScanned = budget.scannedLines > 0;
  const secretsState = !secretsTruncated
    ? 'scanned'
    : anyScanned
      ? 'partial'
      : 'not-scanned';

  const warnings = [...checksResult.warnings];
  if (headUnavailable) {
    warnings.push({
      code: 'head-unavailable',
      message: 'HEAD could not be read; commit state is unknown',
    });
  }
  if (worktreeError) {
    warnings.push({
      code: 'worktree-unavailable',
      message: worktreeError,
    });
  }
  if (!staged.available) {
    warnings.push({
      code: 'staged-unavailable',
      message: 'staged changes could not be inspected',
    });
  }
  if (!unstaged.available) {
    warnings.push({
      code: 'unstaged-unavailable',
      message: 'unstaged changes could not be inspected',
    });
  }
  if (untracked.truncated) {
    warnings.push({
      code: 'untracked-incomplete',
      message: 'untracked files were not fully inspected',
    });
  }
  if (staged.conflicted + unstaged.conflicted > 0) {
    warnings.push({
      code: 'conflicted-files',
      message: 'conflicted files are present; their combined diffs were not scanned',
    });
  }
  if (staged.truncated || unstaged.truncated) {
    warnings.push({
      code: 'file-list-truncated',
      message: `changed-file details are capped at ${limits.maxFilesListed} entries`,
    });
  }
  if (worktreeError) {
    warnings.push({
      code: 'untracked-unavailable',
      message: 'untracked files are unknown because working-tree state could not be read',
    });
  }

  const warningSeen = new Set();
  const dedupedWarnings = warnings
    .filter((warning) => {
      const key = `${warning.code}\0${warning.message}`;
      if (warningSeen.has(key)) {
        return false;
      }
      warningSeen.add(key);
      return true;
    })
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));

  const counts = {
    added: staged.counts.added + unstaged.counts.added,
    modified: staged.counts.modified + unstaged.counts.modified,
    deleted: staged.counts.deleted + unstaged.counts.deleted,
    renamed: staged.counts.renamed + unstaged.counts.renamed,
    copied: staged.counts.copied + unstaged.counts.copied,
    typechange: staged.counts.typechange + unstaged.counts.typechange,
    conflicted: new Set(
      [...staged.allFiles, ...unstaged.allFiles]
        .filter((file) => file.conflicted)
        .map((file) => file.path),
    ).size,
    unknown: staged.counts.unknown + unstaged.counts.unknown,
    untracked: untracked.filesTotal ?? 0,
  };

  const filesAvailable = staged.available && unstaged.available && untracked.available;
  const statsComplete =
    staged.statsComplete &&
    unstaged.statsComplete &&
    (untracked.filesTotal === 0 || untracked.insertions !== null);
  const insertions =
    filesAvailable && statsComplete
      ? staged.insertions + unstaged.insertions + (untracked.insertions ?? 0)
      : null;
  const deletions =
    filesAvailable && statsComplete ? staged.deletions + unstaged.deletions : null;

  const changes = {
    complete: Boolean(worktree) && staged.complete && unstaged.complete,
    statsComplete,
    filesTruncated: staged.truncated || unstaged.truncated || (untracked.omitted ?? 0) > 0,
    staged: scopeView(staged),
    unstaged: scopeView(unstaged),
    untracked: untrackedView(untracked),
    summary: {
      files: filesAvailable
        ? staged.filesTotal + unstaged.filesTotal + untracked.filesTotal
        : null,
      insertions,
      deletions,
      binary: staged.binary + unstaged.binary + untracked.binary,
      added: counts.added,
      modified: counts.modified,
      deleted: counts.deleted,
      renamed: counts.renamed,
      copied: counts.copied,
      typechange: counts.typechange,
      conflicted: counts.conflicted,
      unknown: counts.unknown,
      untracked: counts.untracked,
      statsComplete,
    },
  };

  const report = {
    schemaVersion: 1,
    tool: {
      name: PACKAGE_NAME,
      version: VERSION,
    },
    generatedAt,
    repo: {
      root,
      cwd: relativeCwd(root, cwd),
      branch,
      detached,
      head,
      unborn,
    },
    changes,
    areas: areas.items,
    largest,
    checks: checksResult.checks,
    secrets: {
      state: secretsState,
      findings: uniqueSortedFindings(budget.findings),
      scanned: {
        stagedLines: stagedScan.scanned,
        unstagedLines: unstagedScan.scanned,
        untrackedLines: untracked.scannedLines,
        totalLines: budget.scannedLines,
      },
      truncated: secretsTruncated,
      reasons: uniqueStrings(secretReasons),
    },
    limits: {
      maxDiffBytes: limits.maxDiffBytes,
      maxAddedLines: limits.maxAddedLines,
      maxLineLength: limits.maxLineLength,
      maxFindings: limits.maxFindings,
      maxUntrackedFiles: limits.maxUntrackedFiles,
      maxUntrackedFileBytes: limits.maxUntrackedFileBytes,
      maxUntrackedScanBytes: limits.maxUntrackedScanBytes,
      maxFilesListed: limits.maxFilesListed,
      maxAreas: limits.maxAreas,
      maxLargest: limits.maxLargest,
      hit: [...limitsHit].sort(),
    },
    warnings: dedupedWarnings,
  };

  return report;
}
