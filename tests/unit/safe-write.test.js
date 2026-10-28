import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, cleanup } from '../helpers/repo.js';
import {
  assertWritableTarget,
  atomicWriteFile,
  resolveRepoPath,
} from '../../src/fs/safeWrite.js';

test('resolveRepoPath rejects absolute and escaping paths', () => {
  const root = path.resolve('/tmp/ziki-safe-root');

  assert.throws(() => resolveRepoPath(root, '../outside.json'), /outside the repository/);
  assert.throws(() => resolveRepoPath(root, 'nested/../../outside.json'), /outside the repository/);
  assert.throws(() => resolveRepoPath(root, '.'), /outside the repository/);
  assert.throws(() => resolveRepoPath(root, ''), /empty repository-relative path/);
  assert.throws(
    () => resolveRepoPath(root, path.resolve(root, 'absolute.json')),
    /absolute path/,
  );

  assert.equal(
    resolveRepoPath(root, 'nested/../ziki.json'),
    path.join(root, 'ziki.json'),
  );
});

test('atomicWriteFile replaces a file and leaves no temporary files', (t) => {
  const dir = tempDir('ziki-atomic-');
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'ziki.json');

  const first = atomicWriteFile(target, 'one\n', { displayPath: 'ziki.json' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'one\n');
  assert.equal(
    first.sha256,
    crypto.createHash('sha256').update('one\n').digest('hex'),
  );
  assert.deepEqual(fs.readdirSync(dir), ['ziki.json']);

  atomicWriteFile(target, 'two\n', { displayPath: 'ziki.json' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'two\n');
  assert.deepEqual(fs.readdirSync(dir), ['ziki.json']);
});

test('assertWritableTarget refuses a symlink target', (t) => {
  const dir = tempDir('ziki-symlink-');
  t.after(() => cleanup(dir));
  const target = path.join(dir, 'ziki.json');
  fs.writeFileSync(path.join(dir, 'elsewhere.json'), 'keep\n');

  try {
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), target, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('symlink creation is not permitted on this account');
      return;
    }
    throw error;
  }

  assert.throws(
    () => assertWritableTarget(dir, target, 'ziki.json'),
    /symlink/,
  );
});

test('assertWritableTarget accepts a missing file in a normal directory', (t) => {
  const dir = tempDir('ziki-safe-');
  t.after(() => cleanup(dir));

  assert.doesNotThrow(() =>
    assertWritableTarget(dir, path.join(dir, 'ziki.json'), 'ziki.json'),
  );
});
