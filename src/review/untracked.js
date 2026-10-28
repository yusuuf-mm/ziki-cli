import fs from 'node:fs';
import path from 'node:path';
import { scanAddedLines } from './secrets.js';

/** Count lines the way Git's numstat does: a final line needs no newline. */
export function countLines(text) {
  if (text === '') {
    return 0;
  }
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      count += 1;
    }
  }
  return text.endsWith('\n') ? count : count + 1;
}

/** Git treats a file with a NUL in its first 8000 bytes as binary. */
export function isBinaryBuffer(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function insideRoot(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readErrorReason(error) {
  if (!error || typeof error.code !== 'string') {
    return 'could not be read';
  }
  if (error.code === 'ENOENT') {
    return 'file disappeared before it could be read';
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return 'permission denied';
  }
  if (error.code === 'ELOOP') {
    return 'symlink loop';
  }
  if (error.code === 'EISDIR') {
    return 'not a regular file';
  }
  return `could not be read (${error.code})`;
}

/**
 * Read at most `maxBytes` from one untracked path. Symlinks and special files
 * are never followed. The returned object never contains file contents except
 * the internally used `text` field, which the caller must not serialize.
 */
export function readUntrackedFile(root, relativePath, { maxBytes = 512 * 1024 } = {}) {
  const absolute = path.resolve(root, ...String(relativePath).split('/'));
  if (!insideRoot(path.resolve(root), absolute)) {
    return { kind: 'skipped', reason: 'path is outside the repository', bytes: null };
  }

  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    return { kind: 'unreadable', reason: readErrorReason(error), bytes: null };
  }

  if (stat.isSymbolicLink()) {
    return { kind: 'skipped', reason: 'symlink; not followed', bytes: null };
  }
  if (!stat.isFile()) {
    return { kind: 'skipped', reason: 'not a regular file', bytes: null };
  }

  const limit = Math.max(0, Math.min(stat.size, maxBytes));
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

  let descriptor;
  try {
    descriptor = fs.openSync(absolute, flags);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      return { kind: 'skipped', reason: 'not a regular file', bytes: null };
    }

    const buffer = Buffer.alloc(limit);
    let read = 0;
    while (read < limit) {
      const chunk = fs.readSync(descriptor, buffer, read, limit - read, read);
      if (chunk === 0) {
        break;
      }
      read += chunk;
    }

    const bytes = opened.size;
    const truncated = opened.size > read;
    const content = buffer.subarray(0, read);

    if (isBinaryBuffer(content)) {
      return {
        kind: 'binary',
        bytes,
        scannedBytes: read,
        truncated,
      };
    }

    const text = content.toString('utf8');
    return {
      kind: 'text',
      bytes,
      scannedBytes: read,
      truncated,
      insertions: truncated ? null : countLines(text),
      text,
    };
  } catch (error) {
    return { kind: 'unreadable', reason: readErrorReason(error), bytes: null };
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The original result is more useful than a close failure.
      }
    }
  }
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Read and scan untracked files. Only text is scanned; binary, symlinked,
 * unreadable, oversized, and over-budget paths are reported explicitly.
 */
export function collectUntracked({ root, entries, limits, budget }) {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  const files = [];
  const reasons = [];
  const limitsHit = [];
  let scanBytes = 0;
  let scannedFiles = 0;
  let scannedLines = 0;
  let partialFiles = 0;
  let binaryFiles = 0;
  let skippedFiles = 0;
  let unreadableFiles = 0;

  for (const entry of sorted) {
    if (files.length >= limits.maxUntrackedFiles) {
      limitsHit.push('untracked-files');
      break;
    }

    const remainingBudget = limits.maxUntrackedScanBytes - scanBytes;
    if (remainingBudget <= 0) {
      limitsHit.push('untracked-scan-bytes');
      files.push({
        path: entry.path,
        content: 'not-scanned',
        binary: null,
        bytes: null,
        insertions: null,
        reason: 'the untracked-file scan budget was exhausted',
      });
      partialFiles += 1;
      continue;
    }

    const maxBytes = Math.min(limits.maxUntrackedFileBytes, remainingBudget);
    const read = readUntrackedFile(root, entry.path, { maxBytes });

    if (read.kind === 'skipped') {
      skippedFiles += 1;
      files.push({
        path: entry.path,
        content: 'not-scanned',
        binary: null,
        bytes: read.bytes ?? null,
        insertions: null,
        reason: read.reason,
      });
      continue;
    }

    if (read.kind === 'unreadable') {
      unreadableFiles += 1;
      files.push({
        path: entry.path,
        content: 'unreadable',
        binary: null,
        bytes: null,
        insertions: null,
        reason: read.reason,
      });
      continue;
    }

    if (read.kind === 'binary') {
      binaryFiles += 1;
      scanBytes += read.scannedBytes;
      files.push({
        path: entry.path,
        content: 'binary',
        binary: true,
        bytes: read.bytes,
        insertions: null,
        reason: 'binary content was not scanned',
      });
      if (read.truncated) {
        limitsHit.push('untracked-bytes');
      }
      continue;
    }

    scanBytes += read.scannedBytes;
    scannedFiles += 1;

    // Split the way Git's numstat counts: a trailing newline does not create
    // an extra empty final line to scan.
    const rawLines = read.text.split('\n');
    if (rawLines.at(-1) === '') {
      rawLines.pop();
    }
    const lines = rawLines.map((text, index) => ({
      number: index + 1,
      text,
    }));
    const scan = scanAddedLines(lines, {
      path: entry.path,
      scope: 'untracked',
      budget,
      maxLineLength: limits.maxLineLength,
    });
    scannedLines += scan.scanned;

    if (read.truncated) {
      limitsHit.push('untracked-bytes');
    }
    if (scan.stopped) {
      limitsHit.push(budget.exhausted ? 'added-lines' : 'findings');
    }
    if (scan.longLines > 0) {
      limitsHit.push('line-length');
    }

    const incomplete = read.truncated || scan.stopped || scan.longLines > 0;
    if (incomplete) {
      partialFiles += 1;
    }

    files.push({
      path: entry.path,
      content: incomplete ? 'scanned-partial' : 'scanned',
      binary: false,
      bytes: read.bytes,
      insertions: read.truncated ? null : read.insertions,
      reason: incomplete
        ? 'only part of this file was scanned'
        : null,
    });
  }

  const omitted = Math.max(0, sorted.length - files.length);
  if (omitted > 0) {
    limitsHit.push('untracked-files');
  }
  if (partialFiles > 0) {
    reasons.push(
      `${partialFiles} untracked file${partialFiles === 1 ? ' was' : 's were'} only partly scanned`,
    );
  }
  if (binaryFiles > 0) {
    reasons.push(
      `${binaryFiles} binary untracked file${binaryFiles === 1 ? ' was' : 's were'} not scanned`,
    );
  }
  if (skippedFiles > 0) {
    reasons.push(
      `${skippedFiles} untracked path${skippedFiles === 1 ? ' was' : 's were'} not a regular file and was not read`,
    );
  }
  if (unreadableFiles > 0) {
    reasons.push(
      `${unreadableFiles} untracked file${unreadableFiles === 1 ? '' : 's'} could not be read`,
    );
  }

  const complete =
    omitted === 0 &&
    partialFiles === 0 &&
    skippedFiles === 0 &&
    unreadableFiles === 0 &&
    binaryFiles === 0;
  const insertionsKnown = complete && files.every((file) => typeof file.insertions === 'number');
  const bytesKnown = omitted === 0 && files.every((file) => typeof file.bytes === 'number');

  return {
    available: true,
    error: null,
    files,
    filesTotal: sorted.length,
    filesListed: files.length,
    truncated: !complete,
    omitted,
    insertions: insertionsKnown
      ? files.reduce((total, file) => total + file.insertions, 0)
      : null,
    bytes: bytesKnown
      ? files.reduce((total, file) => total + file.bytes, 0)
      : null,
    binary: binaryFiles,
    scannedFiles,
    scannedLines,
    reasons: unique(reasons),
    limitsHit: unique(limitsHit),
  };
}
