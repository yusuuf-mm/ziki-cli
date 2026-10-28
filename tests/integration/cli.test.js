import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, tempDir, cleanup, readPackage, PACKAGE_ROOT } from '../helpers/repo.js';

const PKG = readPackage();

test('--version prints the package version', () => {
  const run = runCli(['--version']);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${PKG.version}\n`);
  assert.equal(run.stderr, '');
});

test('-v is an alias for --version', () => {
  const run = runCli(['-v']);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `${PKG.version}\n`);
});

test('--help prints usage and lists status', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage: ziki <command> \[options\]/);
  assert.match(run.stdout, /status/);
  assert.match(run.stdout, /init/);
  assert.match(run.stdout, /--json/);
  assert.match(run.stdout, /--apply/);
  assert.match(run.stdout, /--confirm/);
  assert.match(run.stdout, /--version/);
  assert.equal(run.stderr, '');
});

test('help and version work outside a repository', () => {
  const dir = tempDir();
  try {
    assert.equal(runCli(['--help'], { cwd: dir }).status, 0);
    assert.equal(runCli(['--version'], { cwd: dir }).status, 0);
  } finally {
    cleanup(dir);
  }
});

test('no command is a usage error', () => {
  const run = runCli([]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /missing command/);
  assert.match(run.stderr, /Usage: ziki/);
  assert.equal(run.stdout, '');
});

test('unknown command is a usage error', () => {
  const run = runCli(['frobnicate']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown command "frobnicate"/);
  assert.match(run.stderr, /Usage: ziki/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});

test('usage errors escape terminal control characters', () => {
  const run = runCli(['\u001b[31mBAD\u0007']);
  assert.equal(run.status, 2);
  assert.equal(run.stderr.includes('\u001b'), false);
  assert.equal(run.stderr.includes('\u0007'), false);
  assert.match(run.stderr, /unknown command "\\x1b\[31mBAD\\x07"/);
});

test('unknown flag is a usage error', () => {
  const run = runCli(['status', '--nope']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unknown option/);
});

test('extra positional argument is a usage error', () => {
  const run = runCli(['status', 'extra']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unexpected argument "extra"/);
});

test('--help prints usage and lists review options', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /review\s+Inspect staged, unstaged, and untracked changes/);
  assert.match(run.stdout, /Review options:\s*\n\s+--json/);
  assert.equal(run.stderr, '');
});

test('review rejects init-only options', () => {
  const run = runCli(['review', '--plan']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--plan is not supported by "review"/);
  assert.equal(run.stdout, '');
});

test('review rejects extra positionals', () => {
  const run = runCli(['review', 'extra']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unexpected argument "extra"/);
});

test('review outside a repository is a runtime error without a stack trace', () => {
  const dir = tempDir();
  try {
    const run = runCli(['review'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a git repository/);
    assert.doesNotMatch(run.stderr, /\n\s+at /);
    assert.equal(run.stdout, '');
  } finally {
    cleanup(dir);
  }
});

test('outside a repository is a runtime error without a stack trace', () => {
  const dir = tempDir();
  try {
    const run = runCli(['status'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a git repository/);
    assert.doesNotMatch(run.stderr, /\n\s+at /);
  } finally {
    cleanup(dir);
  }
});

test('--debug adds a stack trace to runtime errors', () => {
  const dir = tempDir();
  try {
    const run = runCli(['status', '--debug'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /RuntimeError: not a git repository/);
    assert.match(run.stderr, /\n\s+at /);
  } finally {
    cleanup(dir);
  }
});

test('--debug redacts absolute paths outside the repository', () => {
  const dir = tempDir();
  try {
    const run = runCli(['status', '--debug'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /<ziki>/);
    assert.equal(run.stderr.includes(PACKAGE_ROOT), false);
    assert.doesNotMatch(run.stderr, /ziki-cli[\\/]src/);
  } finally {
    cleanup(dir);
  }
});
