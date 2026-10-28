import { sanitizeText } from '../sanitize.js';

// Above this many differing lines, fall back to a full replacement block. The
// plan only ever diffs ziki.json, so this is a guard, not a supported mode.
const MAX_DP_LINES = 1200;

export function splitLines(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') {
    return [];
  }
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function replaceAll(before, after) {
  return [
    ...before.map((text) => ({ type: '-', text })),
    ...after.map((text) => ({ type: '+', text })),
  ];
}

/** Line diff using a longest-common-subsequence table. Returns null if too large. */
export function diffLines(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);

  if (middleBefore.length * middleAfter.length > MAX_DP_LINES * MAX_DP_LINES) {
    return null;
  }

  const rows = middleBefore.length + 1;
  const columns = middleAfter.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(columns));

  for (let i = middleBefore.length - 1; i >= 0; i -= 1) {
    for (let j = middleAfter.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        middleBefore[i] === middleAfter[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const middle = [];
  let i = 0;
  let j = 0;
  while (i < middleBefore.length && j < middleAfter.length) {
    if (middleBefore[i] === middleAfter[j]) {
      middle.push({ type: ' ', text: middleBefore[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      middle.push({ type: '-', text: middleBefore[i] });
      i += 1;
    } else {
      middle.push({ type: '+', text: middleAfter[j] });
      j += 1;
    }
  }
  while (i < middleBefore.length) {
    middle.push({ type: '-', text: middleBefore[i] });
    i += 1;
  }
  while (j < middleAfter.length) {
    middle.push({ type: '+', text: middleAfter[j] });
    j += 1;
  }

  return [
    ...before.slice(0, prefix).map((text) => ({ type: ' ', text })),
    ...middle,
    ...before
      .slice(before.length - suffix)
      .map((text) => ({ type: ' ', text })),
  ];
}

/**
 * Unified diff for display. Returns null when the inputs are too large to diff
 * cheaply, and '' when the texts are identical.
 */
export function renderUnifiedDiff(beforeText, afterText, { context = 3 } = {}) {
  if (beforeText === afterText) {
    return '';
  }

  const before = splitLines(beforeText);
  const after = splitLines(afterText);

  let ops = diffLines(before, after);

  // A trailing-newline-only change leaves every line equal. Show it as a full
  // replacement rather than an empty diff.
  const hasChange = ops !== null && ops.some((op) => op.type !== ' ');
  if (ops === null || !hasChange) {
    ops = replaceAll(before, after);
    if (!ops.some((op) => op.type !== ' ')) {
      return '';
    }
  }

  const oldLine = new Array(ops.length);
  const newLine = new Array(ops.length);
  let oldCounter = 1;
  let newCounter = 1;
  for (let index = 0; index < ops.length; index += 1) {
    oldLine[index] = oldCounter;
    newLine[index] = newCounter;
    if (ops[index].type !== '+') {
      oldCounter += 1;
    }
    if (ops[index].type !== '-') {
      newCounter += 1;
    }
  }

  const changedIndices = ops
    .map((op, index) => (op.type === ' ' ? -1 : index))
    .filter((index) => index !== -1);

  const hunks = [];
  let start = Math.max(0, changedIndices[0] - context);
  let end = Math.min(ops.length - 1, changedIndices[0] + context);

  for (const index of changedIndices.slice(1)) {
    if (index - end - 1 <= context * 2) {
      end = Math.min(ops.length - 1, index + context);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(ops.length - 1, index + context);
    }
  }
  hunks.push([start, end]);

  const output = [];
  for (const [hunkStart, hunkEnd] of hunks) {
    const slice = ops.slice(hunkStart, hunkEnd + 1);
    const oldCount = slice.filter((op) => op.type !== '+').length;
    const newCount = slice.filter((op) => op.type !== '-').length;
    const oldStart = oldCount === 0 ? oldLine[hunkStart] - 1 : oldLine[hunkStart];
    const newStart = newCount === 0 ? newLine[hunkStart] - 1 : newLine[hunkStart];
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

    for (const op of slice) {
      output.push(`${op.type}${sanitizeText(op.text)}`);
    }
  }

  return output.join('\n');
}
