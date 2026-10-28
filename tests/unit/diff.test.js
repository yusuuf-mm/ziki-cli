import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUnifiedDiff, splitLines } from '../../src/report/diff.js';

test('splitLines normalizes CRLF and ignores the final newline', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('\n'), ['']);
});

test('identical text has no diff', () => {
  assert.equal(renderUnifiedDiff('a\nb\n', 'a\nb\n'), '');
});

test('an appended line produces one hunk', () => {
  const diff = renderUnifiedDiff('a\nb\n', 'a\nb\nc\n');
  assert.match(diff, /^@@ -1,2 \+1,3 @@/);
  assert.match(diff, /\n\+c$/);
});

test('a changed line keeps surrounding context', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n');
  const after = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven'].join('\n');
  const diff = renderUnifiedDiff(`${before}\n`, `${after}\n`);

  assert.match(diff, /^-three$/m);
  assert.match(diff, /^\+THREE$/m);
  assert.match(diff, /^ two$/m);
  assert.match(diff, /^ four$/m);
});

test('a trailing-newline-only change is still visible', () => {
  const diff = renderUnifiedDiff('a\nb', 'a\nb\n');
  assert.notEqual(diff, '');
  assert.match(diff, /^-b$/m);
  assert.match(diff, /^\+b$/m);
});

test('diff output escapes terminal control characters', () => {
  const diff = renderUnifiedDiff('safe\n', 'safe\n\u001b[31mred\u0007\n');
  assert.equal(diff.includes('\u001b'), false);
  assert.equal(diff.includes('\u0007'), false);
  assert.match(diff, /\\x1b\[31mred\\x07/);
});

test('unrelated text is shown as a full replacement', () => {
  const diff = renderUnifiedDiff('alpha\nbeta\n', 'gamma\ndelta\n');
  assert.match(diff, /^-alpha$/m);
  assert.match(diff, /^-beta$/m);
  assert.match(diff, /^\+gamma$/m);
  assert.match(diff, /^\+delta$/m);
});

test('very large diffs fall back instead of exhausting memory', () => {
  const before = Array.from({ length: 1300 }, (_, index) => `old ${index}`).join('\n');
  const after = Array.from({ length: 1300 }, (_, index) => `new ${index}`).join('\n');
  const diff = renderUnifiedDiff(`${before}\n`, `${after}\n`);

  assert.match(diff, /^-old 0$/m);
  assert.match(diff, /^\+new 1299$/m);
});
