import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanup,
  initRepo,
  runCli,
  tempDir,
  write,
  git,
} from '../helpers/repo.js';
import {
  DIFF_OUTPUT_MODES,
  READ_ONLY_GIT_SUBCOMMANDS,
  describeGitSpawnError,
  runGit,
  runGitDiff,
} from '../../src/git/run.js';

test('the safe Git surface stays allowlisted and the diff surface stays fixed', () => {
  assert.deepEqual([...READ_ONLY_GIT_SUBCOMMANDS].sort(), [
    'log',
    'rev-list',
    'rev-parse',
    'status',
    'symbolic-ref',
  ]);
  for (const subcommand of ['diff', 'config', 'push', 'fetch', 'checkout']) {
    assert.throws(
      () => runGit([subcommand]),
      /not on the read-only allowlist/,
      subcommand,
    );
  }

  assert.deepEqual(DIFF_OUTPUT_MODES, ['patch', 'numstat', 'raw']);
  assert.throws(
    () => runGitDiff({ mode: 'names' }),
    /unknown diff mode/,
  );
});

test('spawn failures map to fixed, non-repository messages', () => {
  assert.equal(
    describeGitSpawnError({ code: 'ENOENT' }),
    'git executable not found on PATH',
  );
  assert.equal(
    describeGitSpawnError({ code: 'ETIMEDOUT' }, { timeoutMs: 250 }),
    'git timed out after 0.25 seconds',
  );
  assert.equal(
    describeGitSpawnError({ code: 'ENOBUFS' }),
    'git output exceeded the configured size limit',
  );
  assert.equal(
    describeGitSpawnError({ message: 'boom' }),
    'failed to run git: boom',
  );
  assert.equal(
    describeGitSpawnError(null),
    'failed to run git: unknown error',
  );
});

test('review does not run an external diff or textconv helper', (t) => {
  const dir = initRepo();
  const helperDir = tempDir('ziki-diff-helper-');
  const marker = path.join(helperDir, 'marker.txt');
  const prelude = path.join(helperDir, 'prelude.cjs');
  const localNode = path.join(
    helperDir,
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  t.after(() => {
    cleanup(helperDir);
    cleanup(dir);
  });

  write(dir, 'a.txt', 'one\n');
  write(dir, '.gitattributes', '*.txt diff=ziki\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  write(dir, 'a.txt', 'one\ntwo\n');
  git(dir, ['add', 'a.txt']);

  // A copied Node binary gives the external diff a path without spaces. The
  // prelude writes a marker only when Git invokes it with external-diff argv.
  fs.copyFileSync(process.execPath, localNode);
  if (process.platform !== 'win32') {
    fs.chmodSync(localNode, 0o755);
  }
  fs.writeFileSync(
    prelude,
    "if (process.argv.length >= 6) { require('node:fs').writeFileSync(process.env.ZIKI_EXT_MARKER, 'ran'); }\n",
  );
  const externalEnv = {
    ...process.env,
    GIT_EXTERNAL_DIFF: localNode.split(path.sep).join('/'),
    NODE_OPTIONS: `--require=${prelude.split(path.sep).join('/')}`,
    ZIKI_EXT_MARKER: marker,
  };

  // Prove the helper is capable of running without the review path.
  spawnSync('git', ['diff', '--cached', '--ext-diff'], {
    cwd: dir,
    encoding: 'utf8',
    env: externalEnv,
  });
  assert.equal(fs.existsSync(marker), true, 'external-diff control did not run');
  fs.rmSync(marker, { force: true });

  // The textconv helper is configured in the repository itself. --textconv
  // is needed for the control; review must ignore it.
  git(dir, [
    'config',
    'diff.ziki.textconv',
    "node -e \"require('fs').writeFileSync(process.env.ZIKI_TEXT_MARKER,'ran')\"",
  ]);
  const textEnv = { ...process.env, ZIKI_TEXT_MARKER: marker };
  spawnSync('git', ['diff', '--cached', '--textconv'], {
    cwd: dir,
    encoding: 'utf8',
    env: textEnv,
  });
  assert.equal(fs.existsSync(marker), true, 'textconv control did not run');
  fs.rmSync(marker, { force: true });

  const review = runCli(['review', '--json'], { cwd: dir, env: externalEnv });
  assert.equal(review.status, 0, review.stderr);
  assert.equal(fs.existsSync(marker), false, 'review ran an external diff');

  const textReview = runCli(['review', '--json'], { cwd: dir, env: textEnv });
  assert.equal(textReview.status, 0, textReview.stderr);
  assert.equal(fs.existsSync(marker), false, 'review ran a textconv helper');
  assert.equal(JSON.parse(review.stdout).changes.staged.files.length, 1);
});

test('a timeout from the diff wrapper becomes a bounded RuntimeError', (t) => {
  if (process.platform === 'win32') {
    t.skip('the fake-git PATH shim is POSIX-only');
    return;
  }

  const bin = tempDir('ziki-fake-git-');
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    cleanup(bin);
  });

  const fake = path.join(bin, 'git');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 5\n');
  fs.chmodSync(fake, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`;

  assert.throws(
    () => runGitDiff({ cwd: bin, timeoutMs: 100 }),
    (error) => {
      assert.equal(error.code, 'ETIMEDOUT');
      assert.match(error.message, /timed out after 0\.1 seconds/);
      return true;
    },
  );
});

test('review modules contain no write or process-execution path', () => {
  const files = [
    'src/commands/review.js',
    'src/git/changes.js',
    'src/git/worktree.js',
    'src/review/checks.js',
    'src/review/limits.js',
    'src/review/secrets.js',
    'src/review/untracked.js',
    'src/report/reviewHuman.js',
  ];
  const root = path.resolve(import.meta.dirname, '../..');

  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(
      source,
      /\b(?:child_process|execSync|spawnSync|execFileSync)\b/,
      relative,
    );
    assert.doesNotMatch(
      source,
      /fs\.(?:writeFile|appendFile|rm|unlink|rename|copyFile|mkdir|chmod|symlink|truncate|utimes)/,
      relative,
    );
  }
});
