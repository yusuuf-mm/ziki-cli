import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePorcelainZ } from '../../src/git/worktree.js';

test('empty status is clean', () => {
  assert.deepEqual(parsePorcelainZ(''), {
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
    clean: true,
  });
});

test('untracked files count individually', () => {
  const counts = parsePorcelainZ('?? a.txt\0?? b.txt\0');
  assert.equal(counts.untracked, 2);
  assert.equal(counts.clean, false);
});

test('staged addition counts as staged', () => {
  const counts = parsePorcelainZ('A  new.txt\0');
  assert.equal(counts.staged, 1);
  assert.equal(counts.modified, 0);
  assert.equal(counts.untracked, 0);
});

test('unstaged modification counts as modified', () => {
  const counts = parsePorcelainZ(' M tracked.txt\0');
  assert.equal(counts.modified, 1);
  assert.equal(counts.staged, 0);
});

test('staged deletion counts as staged and deleted', () => {
  const counts = parsePorcelainZ('D  gone.txt\0');
  assert.equal(counts.staged, 1);
  assert.equal(counts.deleted, 1);
});

test('worktree deletion counts as deleted', () => {
  const counts = parsePorcelainZ(' D gone.txt\0');
  assert.equal(counts.deleted, 1);
  assert.equal(counts.staged, 0);
});

test('rename consumes the original path field and counts once', () => {
  const counts = parsePorcelainZ('R  new name.txt\0old name.txt\0 M other.txt\0');
  assert.equal(counts.renamed, 1);
  assert.equal(counts.staged, 1);
  assert.equal(counts.modified, 1);
  assert.equal(counts.untracked, 0);
});

test('conflicted entries are counted only as conflicted', () => {
  const counts = parsePorcelainZ('UU conflict.txt\0');
  assert.equal(counts.conflicted, 1);
  assert.equal(counts.staged, 0);
  assert.equal(counts.modified, 0);
});

test('a file both staged and modified counts in both categories', () => {
  const counts = parsePorcelainZ('MM both.txt\0');
  assert.equal(counts.staged, 1);
  assert.equal(counts.modified, 1);
});
