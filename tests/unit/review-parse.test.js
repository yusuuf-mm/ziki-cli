import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countChanges,
  decodeGitPath,
  mergeChangeRecords,
  parseNumstatZ,
  parsePatchAdditions,
  parseRawZ,
} from '../../src/git/changes.js';
import { countLines, isBinaryBuffer } from '../../src/review/untracked.js';

const N = '\0';

test('parseRawZ reads added, deleted, renamed, and conflicted records', () => {
  const raw = [
    ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A',
    'new.txt',
    ':100644 000000 1111111111111111111111111111111111111111 0000000000000000000000000000000000000000 D',
    'gone.txt',
    ':100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R087',
    'old name.txt',
    'new name.txt',
    ':100644 100644 3333333333333333333333333333333333333333 4444444444444444444444444444444444444444 U',
    'conflict.txt',
  ].join(N) + N;

  const records = parseRawZ(raw);
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((record) => ({
      path: record.path,
      oldPath: record.oldPath,
      change: record.change,
      status: record.status,
      score: record.score,
    })),
    [
      { path: 'new.txt', oldPath: null, change: 'added', status: 'A', score: null },
      { path: 'gone.txt', oldPath: null, change: 'deleted', status: 'D', score: null },
      {
        path: 'new name.txt',
        oldPath: 'old name.txt',
        change: 'renamed',
        status: 'R087',
        score: 87,
      },
      {
        path: 'conflict.txt',
        oldPath: null,
        change: 'conflicted',
        status: 'U',
        score: null,
      },
    ],
  );
});

test('parseRawZ keeps raw filenames, including tabs and newlines', () => {
  const raw =
    ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A' +
    N +
    'tab\tname' +
    N +
    ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A' +
    N +
    'line\nname' +
    N;

  assert.deepEqual(
    parseRawZ(raw).map((record) => record.path),
    ['tab\tname', 'line\nname'],
  );
});

test('parseRawZ ignores malformed headers and truncated records', () => {
  assert.deepEqual(parseRawZ('not a header\0path\0'), []);
  assert.deepEqual(parseRawZ(':000000 100644 00 11 A\0path\0'), []);
  assert.deepEqual(parseRawZ(':000000 100644 000 111 R100\0only-old\0'), []);
});

test('parseNumstatZ reads normal, rename, binary, and tabbed paths', () => {
  const raw = [
    '1\t2\ta.txt',
    '0\t0\t',
    'old name.txt',
    'new name.txt',
    '-\t-\tblob.bin',
    '4\t5\tname\twith\ttabs.txt',
  ].join(N) + N;

  const records = parseNumstatZ(raw);
  assert.deepEqual(
    records.map((record) => ({
      path: record.path,
      oldPath: record.oldPath,
      insertions: record.insertions,
      deletions: record.deletions,
      binary: record.binary,
    })),
    [
      { path: 'a.txt', oldPath: null, insertions: 1, deletions: 2, binary: false },
      {
        path: 'new name.txt',
        oldPath: 'old name.txt',
        insertions: 0,
        deletions: 0,
        binary: false,
      },
      { path: 'blob.bin', oldPath: null, insertions: null, deletions: null, binary: true },
      {
        path: 'name\twith\ttabs.txt',
        oldPath: null,
        insertions: 4,
        deletions: 5,
        binary: false,
      },
    ],
  );
});

test('decodeGitPath decodes C-style quoted paths without mangling spaces', () => {
  assert.equal(decodeGitPath('b/plain.txt\t'), 'b/plain.txt');
  assert.equal(decodeGitPath('b/space name.txt\t'), 'b/space name.txt');
  assert.equal(decodeGitPath('"b/quote\\"name"'), 'b/quote"name');
  assert.equal(decodeGitPath('"b/tab\\tname"'), 'b/tab\tname');
  assert.equal(decodeGitPath('"b/newline\\nname"'), 'b/newline\nname');
  assert.equal(decodeGitPath('"b/back\\\\slash"'), 'b/back\\slash');
  assert.equal(decodeGitPath('"b/caf\\303\\251.txt"'), 'b/caf\u00e9.txt');
  assert.equal(decodeGitPath('b/literal'), 'b/literal');
  assert.equal(decodeGitPath(''), '');
});

test('parsePatchAdditions attributes new-file line numbers and paths', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' one',
    '+two',
    ' three',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    'diff --git a/blob.bin b/blob.bin',
    'index 444..555 100644',
    'Binary files a/blob.bin and b/blob.bin differ',
  ].join('\n');

  const parsed = parsePatchAdditions(patch);
  assert.deepEqual(parsed.additions, [
    { path: 'a.txt', line: 2, text: 'two' },
    { path: 'new.txt', line: 1, text: 'first' },
    { path: 'new.txt', line: 2, text: 'second' },
  ]);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.reasons, []);
  assert.deepEqual(parsed.sections, [
    { path: 'a.txt', conflicted: false, binary: false },
    { path: 'new.txt', conflicted: false, binary: false },
    { path: 'blob.bin', conflicted: false, binary: true },
  ]);
});

test('parsePatchAdditions skips combined diffs and reports the limitation', () => {
  const patch = [
    'diff --cc conflict.txt',
    'index 111,222..333',
    '--- a/conflict.txt',
    '+++ b/conflict.txt',
    '@@@ -1,1 -1,1 +1,1 @@@',
    '++both sides',
    'diff --git a/plain.txt b/plain.txt',
    '--- a/plain.txt',
    '+++ b/plain.txt',
    '@@ -1 +1 @@',
    '+safe',
  ].join('\n');

  const parsed = parsePatchAdditions(patch);
  assert.deepEqual(parsed.additions, [{ path: 'plain.txt', line: 1, text: 'safe' }]);
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.sections, [
    { path: 'conflict.txt', conflicted: true, binary: false },
    { path: 'plain.txt', conflicted: false, binary: false },
  ]);
  assert.match(parsed.reasons.join('\n'), /combined \(conflicted\) diff/);
});

test('parsePatchAdditions counts an empty added line and respects the cap', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,1 +1,3 @@',
    ' keep',
    '+',
    '+last',
  ].join('\n');

  const full = parsePatchAdditions(patch);
  assert.deepEqual(full.additions, [
    { path: 'a.txt', line: 2, text: '' },
    { path: 'a.txt', line: 3, text: 'last' },
  ]);

  const capped = parsePatchAdditions(patch, { maxAddedLines: 1 });
  assert.deepEqual(capped.additions, [{ path: 'a.txt', line: 2, text: '' }]);
  assert.equal(capped.truncated, true);
  assert.match(capped.reasons.join('\n'), /stopped after 1 added line/);
});

test('mergeChangeRecords merges raw and numstat, and reports renames once', () => {
  const raw = parseRawZ(
    [
      ':000000 100644 0000000000000000000000000000000000000000 1111111111111111111111111111111111111111 A',
      'added.txt',
      ':100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 R100',
      'old.txt',
      'renamed.txt',
    ].join(N) + N,
  );
  const numstat = parseNumstatZ(
    ['1\t0\tadded.txt', '0\t0\t', 'old.txt', 'renamed.txt'].join(N) + N,
  );

  const files = mergeChangeRecords({
    scope: 'staged',
    rawRecords: raw,
    numstatRecords: numstat,
    conflictedPaths: new Set(),
  });

  assert.deepEqual(
    files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath,
      change: file.change,
      insertions: file.insertions,
      deletions: file.deletions,
      modeChange: file.modeChange,
      scope: file.scope,
    })),
    [
      {
        path: 'added.txt',
        oldPath: null,
        change: 'added',
        insertions: 1,
        deletions: 0,
        modeChange: false,
        scope: 'staged',
      },
      {
        path: 'renamed.txt',
        oldPath: 'old.txt',
        change: 'renamed',
        insertions: 0,
        deletions: 0,
        modeChange: false,
        scope: 'staged',
      },
    ],
  );
});

test('mergeChangeRecords marks conflicts and ignores stale unstaged raw-only entries', () => {
  const conflicted = mergeChangeRecords({
    scope: 'staged',
    rawRecords: [
      { path: 'c.txt', change: 'modified', status: 'M', oldMode: '100644', newMode: '100644' },
      { path: 'c.txt', change: 'conflicted', status: 'U', oldMode: '100644', newMode: '100644' },
    ],
    numstatRecords: [{ path: 'c.txt', insertions: 1, deletions: 0, binary: false }],
    conflictedPaths: new Set(['c.txt']),
  });
  assert.equal(conflicted.length, 1);
  assert.equal(conflicted[0].change, 'conflicted');
  assert.equal(conflicted[0].stats, 'unavailable');
  assert.equal(conflicted[0].insertions, null);

  const stale = mergeChangeRecords({
    scope: 'unstaged',
    rawRecords: [
      { path: 'stale.txt', change: 'modified', status: 'M', oldMode: '100644', newMode: '100644' },
    ],
    numstatRecords: [],
    conflictedPaths: new Set(),
  });
  assert.deepEqual(stale, []);

  const mode = mergeChangeRecords({
    scope: 'unstaged',
    rawRecords: [
      { path: 'mode.sh', change: 'modified', status: 'M', oldMode: '100644', newMode: '100755' },
    ],
    numstatRecords: [],
    conflictedPaths: new Set(),
  });
  assert.equal(mode.length, 1);
  assert.equal(mode[0].modeChange, true);
  assert.equal(mode[0].stats, 'exact');
  assert.equal(mode[0].insertions, 0);
});

test('mergeChangeRecords adds a conflict path even without a raw record', () => {
  const files = mergeChangeRecords({
    scope: 'unstaged',
    rawRecords: [],
    numstatRecords: [],
    conflictedPaths: new Set(['both.txt']),
  });
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'both.txt');
  assert.equal(files[0].change, 'conflicted');
});

test('countChanges tallies every change kind and unknown values', () => {
  assert.deepEqual(
    countChanges([
      { change: 'added' },
      { change: 'modified' },
      { change: 'renamed' },
      { change: 'conflicted' },
      { change: 'mystery' },
    ]),
    {
      added: 1,
      modified: 1,
      deleted: 0,
      renamed: 1,
      copied: 0,
      typechange: 0,
      conflicted: 1,
      unknown: 1,
    },
  );
});

test('countLines and isBinaryBuffer match Git line and binary rules', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\ntwo'), 2);
  assert.equal(countLines('one\ntwo\n'), 2);
  assert.equal(isBinaryBuffer(Buffer.from('text')), false);
  assert.equal(isBinaryBuffer(Buffer.from('text\0more')), true);
  assert.equal(isBinaryBuffer(Buffer.from('a'.repeat(8000) + '\0')), false);
});
