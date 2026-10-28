import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAheadBehind } from '../../src/git/upstream.js';
import { parseLastCommit } from '../../src/git/lastCommit.js';
import { formatRelative } from '../../src/report/human.js';
import { colorEnabled, makeColor } from '../../src/report/color.js';

test('parseAheadBehind reads behind then ahead', () => {
  assert.deepEqual(parseAheadBehind('3\t2\n'), { ahead: 2, behind: 3 });
  assert.deepEqual(parseAheadBehind('0 0'), { ahead: 0, behind: 0 });
});

test('parseAheadBehind returns nulls for malformed input', () => {
  assert.deepEqual(parseAheadBehind(''), { ahead: null, behind: null });
  assert.deepEqual(parseAheadBehind('one two'), { ahead: null, behind: null });
  assert.deepEqual(parseAheadBehind('1 2 3'), { ahead: null, behind: null });
});

test('parseLastCommit normalizes the date to UTC', () => {
  const commit = parseLastCommit(
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\u0000a1b2c3d\u0000fix: empty diff\u00002026-10-28T10:00:00+01:00\n',
  );
  assert.deepEqual(commit, {
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    shortSha: 'a1b2c3d',
    subject: 'fix: empty diff',
    date: '2026-10-28T09:00:00.000Z',
  });
});

test('parseLastCommit returns null for empty or malformed input', () => {
  assert.equal(parseLastCommit(''), null);
  assert.equal(parseLastCommit('\n'), null);
  assert.equal(parseLastCommit('only-a-sha\n'), null);
});

test('formatRelative covers every bucket', () => {
  const now = new Date('2026-10-28T12:00:00.000Z').getTime();
  const ago = (ms) => new Date(now - ms).toISOString();

  assert.equal(formatRelative(ago(30_000), now), 'just now');
  assert.equal(formatRelative(ago(60_000), now), '1 minute ago');
  assert.equal(formatRelative(ago(5 * 60_000), now), '5 minutes ago');
  assert.equal(formatRelative(ago(60 * 60_000), now), '1 hour ago');
  assert.equal(formatRelative(ago(26 * 60 * 60_000), now), '1 day ago');
  assert.equal(formatRelative(ago(3 * 24 * 60 * 60_000), now), '3 days ago');
  assert.equal(formatRelative(ago(-60_000), now), 'just now');
  assert.equal(formatRelative('not-a-date', now), 'unknown time');
});

test('color is enabled only on a TTY without NO_COLOR', () => {
  assert.equal(colorEnabled({ isTTY: true, noColor: undefined }), true);
  assert.equal(colorEnabled({ isTTY: true, noColor: '' }), false);
  assert.equal(colorEnabled({ isTTY: true, noColor: '1' }), false);
  assert.equal(colorEnabled({ isTTY: false, noColor: undefined }), false);
});

test('makeColor is a no-op when disabled', () => {
  assert.equal(makeColor(false).bold('x'), 'x');
  assert.match(makeColor(true).bold('x'), /\u001b\[1mx\u001b\[22m/);
});
