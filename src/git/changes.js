import { runGitDiff } from './run.js';

const CHANGE_BY_LETTER = Object.freeze({
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted',
});

function splitNul(raw) {
  const fields = raw.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  return fields;
}

/**
 * Decode the path form Git uses on a `+++ ` line. Git C-quotes paths that
 * contain controls, quotes, backslashes, or non-ASCII bytes when
 * core.quotePath is true. Octal escapes are bytes, not Unicode code points.
 */
export function decodeGitPath(text) {
  if (typeof text !== 'string') {
    return '';
  }

  // Git appends a tab after a path containing spaces in patch headers. A
  // path that genuinely ends in a tab is quoted, so one trailing tab is
  // always a separator.
  const value = text.endsWith('\t') ? text.slice(0, -1) : text;
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
    return value;
  }

  const inner = value.slice(1, -1);
  const bytes = [];
  const simple = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    '\\': 0x5c,
  };

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }

    const next = inner[index + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }

    if (/[0-7]/.test(next)) {
      let digits = next;
      let cursor = index + 2;
      while (digits.length < 3 && cursor < inner.length && /[0-7]/.test(inner[cursor])) {
        digits += inner[cursor];
        cursor += 1;
      }
      bytes.push(parseInt(digits, 8) & 0xff);
      index = cursor - 1;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(simple, next)) {
      bytes.push(simple[next]);
      index += 1;
      continue;
    }

    // Unknown escape: keep the escaped character rather than dropping data.
    bytes.push(...Buffer.from(next, 'utf8'));
    index += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse `git diff --raw -z --no-abbrev`.
 *
 * Header format: `:oldmode newmode oldsha newsha status` followed by NUL.
 * A rename or copy is followed by the source path and then the destination
 * path. For every other status the next field is the path.
 */
export function parseRawZ(raw) {
  const fields = splitNul(raw);
  const records = [];

  for (let index = 0; index < fields.length; ) {
    const header = fields[index];
    index += 1;
    if (header === '') {
      continue;
    }

    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])(\d*)$/.exec(
      header,
    );
    if (!match) {
      continue;
    }

    const [, oldMode, newMode, oldSha, newSha, letter, score] = match;
    const firstPath = fields[index] ?? '';
    index += 1;
    if (firstPath === '') {
      continue;
    }

    let path = firstPath;
    let oldPath = null;
    if (letter === 'R' || letter === 'C') {
      oldPath = firstPath;
      path = fields[index] ?? '';
      index += 1;
      if (path === '') {
        continue;
      }
    }

    records.push({
      path,
      oldPath,
      change: CHANGE_BY_LETTER[letter] ?? 'unknown',
      status: `${letter}${score}`,
      score: score === '' ? null : Number(score),
      oldMode,
      newMode,
      oldSha,
      newSha,
    });
  }

  return records;
}

/**
 * Parse `git diff --numstat -z`.
 *
 * A normal record is `insertions\tdeletions\tpath`; a rename/copy record has
 * an empty path followed by the source and destination fields. Split only the
 * first two tabs: a path may itself contain a tab.
 */
export function parseNumstatZ(raw) {
  const fields = splitNul(raw);
  const records = [];

  for (let index = 0; index < fields.length; ) {
    const entry = fields[index];
    index += 1;
    if (entry === '') {
      continue;
    }

    const firstTab = entry.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : entry.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      continue;
    }

    const added = entry.slice(0, firstTab);
    const deleted = entry.slice(firstTab + 1, secondTab);
    let path = entry.slice(secondTab + 1);
    let oldPath = null;

    if (path === '') {
      oldPath = fields[index] ?? '';
      index += 1;
      path = fields[index] ?? '';
      index += 1;
    }

    if (path === '') {
      continue;
    }

    records.push({
      path,
      oldPath,
      insertions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
      binary: added === '-' || deleted === '-',
    });
  }

  return records;
}

/**
 * Extract the destination path from a `diff --git` or `diff --cc` header.
 * Git does not quote spaces here, so the ` b/` separator is the practical
 * delimiter. Quoted headers are parsed token-wise.
 */
function diffHeaderPath(line) {
  if (line.startsWith('diff --cc ')) {
    const value = decodeGitPath(line.slice('diff --cc '.length));
    return value.startsWith('a/') || value.startsWith('b/') ? value.slice(2) : value;
  }

  const rest = line.slice('diff --git '.length);
  if (rest === '') {
    return null;
  }

  let first;
  let second;
  if (rest[0] === '"') {
    let end = -1;
    for (let index = 1; index < rest.length; index += 1) {
      if (rest[index] === '\\') {
        index += 1;
        continue;
      }
      if (rest[index] === '"') {
        end = index + 1;
        break;
      }
    }
    if (end === -1) {
      return null;
    }
    first = rest.slice(0, end);
    let cursor = end;
    while (rest[cursor] === ' ') {
      cursor += 1;
    }
    second = rest.slice(cursor);
  } else {
    const separator = rest.lastIndexOf(' b/');
    if (separator === -1) {
      return null;
    }
    first = rest.slice(0, separator);
    second = rest.slice(separator + 1);
  }

  const target = decodeGitPath(second);
  if (target === '') {
    return null;
  }
  return target.startsWith('b/') ? target.slice(2) : target;
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  return {
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/**
 * Parse added lines out of a unified diff. Only added lines are returned:
 * secret scanning never reads deleted or context lines.
 *
 * Line numbers are new-file line numbers. Combined diffs (`@@@`, used for
 * conflicted files) are deliberately skipped because there is no single new
 * side to attribute an added line to.
 */
export function parsePatchAdditions(
  patch,
  { maxAddedLines = 20_000 } = {},
) {
  const lines = String(patch).split('\n');
  const additions = [];
  const sections = [];
  const reasons = [];
  let current = null;
  let inHunk = false;
  let newLine = 0;
  let truncated = false;
  let combinedSections = 0;
  let unattributedLines = 0;

  const finishSection = () => {
    if (current && (current.path || current.combined || current.binary)) {
      sections.push({
        path: current.path,
        conflicted: current.combined,
        binary: current.binary,
      });
    }
  };

  for (const line of lines) {
    if (line === '') {
      continue;
    }

    // A new file header also ends the previous hunk. Check it before the
    // inHunk guard: the last hunk line does not necessarily reset the flag.
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      finishSection();
      current = {
        path: diffHeaderPath(line),
        combined: line.startsWith('diff --cc '),
        binary: false,
      };
      inHunk = false;
      if (current.combined) {
        combinedSections += 1;
      }
      continue;
    }

    if (!inHunk && line.startsWith('+++ ')) {
      const rawPath = line.slice(4);
      const decoded = decodeGitPath(rawPath);
      if (decoded === '' || decoded === '/dev/null') {
        if (current) {
          current.path = null;
        }
      } else if (current) {
        current.path = decoded.startsWith('b/') ? decoded.slice(2) : decoded;
      }
      continue;
    }

    if (!inHunk && line.startsWith('Binary files ')) {
      if (current) {
        current.binary = true;
      }
      continue;
    }

    if (line.startsWith('@@@')) {
      inHunk = true;
      if (current) {
        current.combined = true;
      }
      continue;
    }

    if (line.startsWith('@@ ')) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        inHunk = true;
        newLine = hunk.newStart;
      }
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (current && current.combined) {
      // Combined diff lines have more than one prefix column. Skip them all.
      continue;
    }

    if (line.startsWith('+')) {
      if (current && current.path) {
        if (additions.length >= maxAddedLines) {
          truncated = true;
          break;
        }
        additions.push({
          path: current.path,
          line: newLine,
          text: line.slice(1),
        });
      } else {
        unattributedLines += 1;
      }
      newLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      newLine += 1;
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }

    // A `-` line consumes no new-file line. Any other line ends the hunk.
    if (!line.startsWith('-')) {
      inHunk = false;
    }
  }

  finishSection();

  if (truncated) {
    reasons.push(
      `secret scan stopped after ${maxAddedLines} added lines`,
    );
  }
  if (combinedSections > 0) {
    reasons.push(
      `${combinedSections} combined (conflicted) diff${combinedSections === 1 ? '' : 's'} were not scanned`,
    );
  }
  if (unattributedLines > 0) {
    reasons.push(
      `${unattributedLines} added line${unattributedLines === 1 ? '' : 's'} could not be attributed to a file`,
    );
  }

  return {
    additions,
    sections,
    truncated,
    scannedLines: additions.length,
    reasons,
  };
}

function normalizeNumstatMap(records) {
  const map = new Map();
  for (const record of records) {
    if (!map.has(record.path)) {
      map.set(record.path, record);
    }
  }
  return map;
}

function normalizeRawMap(records) {
  const map = new Map();
  for (const record of records) {
    const existing = map.get(record.path);
    if (!existing) {
      map.set(record.path, record);
      continue;
    }
    if (existing.change !== 'conflicted' && record.change === 'conflicted') {
      map.set(record.path, record);
    }
  }
  return map;
}

function makeFile({ raw, numstat, conflicted, scope, statsAvailable = true }) {
  const change = conflicted ? 'conflicted' : raw ? raw.change : 'unknown';
  const binary = conflicted
    ? null
    : numstat
      ? Boolean(numstat.binary)
      : statsAvailable
        ? false
        : null;

  let insertions = null;
  let deletions = null;
  let stats = 'unavailable';

  if (conflicted) {
    stats = 'unavailable';
  } else if (numstat && numstat.binary) {
    stats = 'binary';
  } else if (numstat) {
    insertions = numstat.insertions;
    deletions = numstat.deletions;
    stats = 'exact';
  } else if (statsAvailable) {
    insertions = 0;
    deletions = 0;
    stats = 'exact';
  }

  return {
    path: raw?.path ?? numstat?.path ?? '',
    oldPath: raw?.oldPath ?? numstat?.oldPath ?? null,
    change,
    status: raw?.status ?? '?',
    renamed: change === 'renamed',
    copied: change === 'copied',
    conflicted,
    binary,
    insertions,
    deletions,
    stats,
    modeChange: hasModeChange(raw),
    scope,
  };
}

/**
 * Merge raw status and numstat records into the per-file review shape.
 *
 * Staged changes are driven by raw records, because the index is the source
 * of truth. Unstaged changes are driven by numstat records: `diff-files
 * --raw` can report a file whose stat data is stale but whose content is
 * unchanged, and there is no numstat record for it. Raw entries without a
 * numstat record are added only when a real mode change exists or the file is
 * conflicted.
 */
export function mergeChangeRecords({
  scope,
  rawRecords = null,
  numstatRecords = null,
  conflictedPaths = new Set(),
}) {
  const rawMap = rawRecords === null ? null : normalizeRawMap(rawRecords);
  const numstatMap = numstatRecords === null ? null : normalizeNumstatMap(numstatRecords);
  const files = [];
  const seen = new Set();

  const add = (raw, numstat) => {
    const path = raw?.path ?? numstat?.path;
    if (!path || seen.has(path)) {
      return;
    }
    seen.add(path);
    files.push(
      makeFile({
        raw,
        numstat,
        conflicted: conflictedPaths.has(path) || raw?.change === 'conflicted',
        scope,
        statsAvailable: numstatMap !== null,
      }),
    );
  };

  if (scope === 'staged') {
    if (rawMap) {
      for (const raw of rawMap.values()) {
        add(raw, numstatMap?.get(raw.path) ?? null);
      }
    }
    if (numstatMap) {
      for (const numstat of numstatMap.values()) {
        if (!seen.has(numstat.path)) {
          add(null, numstat);
        }
      }
    }
  } else {
    if (numstatMap) {
      for (const numstat of numstatMap.values()) {
        add(rawMap?.get(numstat.path) ?? null, numstat);
      }
    }
    if (rawMap) {
      for (const raw of rawMap.values()) {
        if (seen.has(raw.path)) {
          continue;
        }
        const conflicted = conflictedPaths.has(raw.path) || raw.change === 'conflicted';
        if (conflicted || hasModeChange(raw) || raw.change === 'typechange') {
          add(raw, null);
        }
      }
    }
  }

  for (const path of conflictedPaths) {
    if (!seen.has(path)) {
      const raw = rawMap?.get(path) ?? null;
      add(raw ?? { path, change: 'conflicted', status: 'U' }, null);
    }
  }

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function hasModeChange(raw) {
  return Boolean(
    raw &&
      raw.oldMode !== '000000' &&
      raw.newMode !== '000000' &&
      raw.oldMode !== raw.newMode,
  );
}

function markFileConflicted(file) {
  file.change = 'conflicted';
  file.conflicted = true;
  file.renamed = false;
  file.copied = false;
  file.binary = null;
  file.insertions = null;
  file.deletions = null;
  file.stats = 'unavailable';
}

export function countChanges(files) {
  const counts = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    typechange: 0,
    conflicted: 0,
    unknown: 0,
  };
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(counts, file.change)) {
      counts[file.change] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return counts;
}

function diffResult(cwd, staged, mode, maxBytes) {
  try {
    const result = runGitDiff({ cwd, staged, mode, maxBytes });
    if (result.status !== 0) {
      return {
        ok: false,
        error: `git ${staged ? 'diff --cached' : 'diff-files'} exited with status ${result.status}`,
        limit: null,
      };
    }
    return { ok: true, stdout: result.stdout, error: null, limit: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      limit: error && error.code === 'ENOBUFS' ? 'diff-bytes' : null,
    };
  }
}

/**
 * Collect one change scope (staged or unstaged). Git failures are reported as
 * unavailable data, not thrown, so the rest of the review still runs.
 */
export function collectChangeScope({
  cwd,
  staged,
  conflictedPaths = new Set(),
  limits,
}) {
  const raw = diffResult(cwd, staged, 'raw', limits.maxDiffBytes);
  const numstat = diffResult(cwd, staged, 'numstat', limits.maxDiffBytes);
  const available = raw.ok || numstat.ok;
  const complete = raw.ok && numstat.ok;
  const reasons = [];
  const limitsHit = [];

  if (!raw.ok && numstat.ok) {
    reasons.push('file change types are unavailable');
  }
  if (raw.ok && !numstat.ok) {
    reasons.push('line statistics are unavailable');
  }
  if (raw.limit) {
    limitsHit.push(raw.limit);
  }
  if (numstat.limit) {
    limitsHit.push(numstat.limit);
  }

  let files = [];
  if (available) {
    files = mergeChangeRecords({
      scope: staged ? 'staged' : 'unstaged',
      rawRecords: raw.ok ? parseRawZ(raw.stdout) : null,
      numstatRecords: numstat.ok ? parseNumstatZ(numstat.stdout) : null,
      conflictedPaths,
    });
  }

  let contentAvailable = true;
  let contentComplete = true;
  let additions = [];
  const contentReasons = [];
  const combinedPaths = new Set();

  if (files.length > 0) {
    const patch = diffResult(cwd, staged, 'patch', limits.maxDiffBytes);
    if (!patch.ok) {
      contentAvailable = false;
      contentComplete = false;
      contentReasons.push('diff text is unavailable, so added lines were not scanned');
      if (patch.limit) {
        limitsHit.push(patch.limit);
      }
    } else {
      const parsed = parsePatchAdditions(patch.stdout, {
        maxAddedLines: limits.maxAddedLines,
      });
      additions = parsed.additions;
      contentComplete = !parsed.truncated;
      if (parsed.truncated) {
        limitsHit.push('added-lines');
      }
      contentReasons.push(...parsed.reasons);
      for (const section of parsed.sections) {
        if (section.conflicted && section.path) {
          combinedPaths.add(section.path);
        }
      }
    }
  }

  // If status was unavailable, the combined-diff header is the only conflict
  // signal. Mark those files and add any path that raw/numstat did not see.
  for (const path of combinedPaths) {
    const file = files.find((candidate) => candidate.path === path);
    if (file) {
      markFileConflicted(file);
    } else {
      files.push(
        makeFile({
          raw: { path, change: 'conflicted', status: 'U' },
          numstat: null,
          conflicted: true,
          scope: staged ? 'staged' : 'unstaged',
          statsAvailable: false,
        }),
      );
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const filesTotal = files.length;
  const filesListed = Math.min(filesTotal, limits.maxFilesListed);
  const truncated = filesTotal > filesListed;
  if (truncated) {
    limitsHit.push('file-list');
  }

  const statsComplete = files.every(
    (file) =>
      typeof file.insertions === 'number' && typeof file.deletions === 'number',
  );
  const insertions = statsComplete
    ? files.reduce((total, file) => total + file.insertions, 0)
    : null;
  const deletions = statsComplete
    ? files.reduce((total, file) => total + file.deletions, 0)
    : null;
  const binary = files.filter((file) => file.binary === true).length;
  const conflicted = files.filter((file) => file.conflicted).length;

  return {
    scope: staged ? 'staged' : 'unstaged',
    available,
    complete,
    error: available
      ? null
      : `${staged ? 'staged' : 'unstaged'} changes could not be inspected (${raw.error ?? numstat.error ?? 'unknown error'})`,
    reasons: [...reasons, ...contentReasons],
    contentReasons,
    files: files.slice(0, filesListed),
    allFiles: files,
    filesTotal,
    filesListed,
    truncated,
    counts: countChanges(files),
    conflicted,
    statsComplete,
    insertions,
    deletions,
    binary,
    contentAvailable,
    contentComplete,
    additions,
    limitsHit: [...new Set(limitsHit)],
  };
}
