import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanup,
  git,
  initRepo,
  runCli,
  tempDir,
  write,
} from '../helpers/repo.js';
import { collectReview } from '../../src/commands/review.js';
import { REVIEW_LIMITS } from '../../src/review/limits.js';
import { serializeConfig, verifyIntegrity } from '../../src/config/zikiConfig.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseReview(run) {
  assert.equal(run.status, 0, run.stderr);
  const doc = JSON.parse(run.stdout);
  assert.equal(doc.schemaVersion, 1);
  return doc;
}

function listFiles(root) {
  const files = new Map();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue;
      }
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target);
      } else if (entry.isFile()) {
        const relative = path.relative(root, target).split(path.sep).join('/');
        files.set(
          relative,
          crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),
        );
      }
    }
  }
  walk(root);
  return files;
}

test('review --json reports staged, unstaged, untracked, rename, binary, and secrets', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'base.txt', 'one\ntwo\n');
  write(dir, 'old.txt', 'rename me\n');
  write(dir, 'gone.txt', 'delete me\n');
  write(dir, 'staged.txt', 'initial\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from('old\0binary'));
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);

  write(dir, 'base.txt', 'one\nTWO\nthree\n');
  git(dir, ['add', 'base.txt']);
  write(dir, 'staged.txt', 'api_key = "staged-secret-value-123"\nextra\n');
  git(dir, ['add', 'staged.txt']);
  git(dir, ['mv', 'old.txt', 'renamed.txt']);
  git(dir, ['rm', '-q', 'gone.txt']);
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from('\0AKIA1234567890ABCDEFchanged', 'utf8'));
  git(dir, ['add', 'blob.bin']);

  write(dir, 'base.txt', 'one\nTWO\nthree\nunstaged\n');
  write(dir, 'loose.txt', 'ghp_' + 'a'.repeat(36) + '\n');
  fs.writeFileSync(path.join(dir, 'loose.bin'), Buffer.from('\0loose-binary-value'));

  const run = runCli(['review', '--json'], { cwd: dir });
  const doc = parseReview(run);
  const human = runCli(['review'], { cwd: dir });
  assert.equal(human.status, 0, human.stderr);

  assert.deepEqual(Object.keys(doc), [
    'schemaVersion',
    'tool',
    'generatedAt',
    'repo',
    'changes',
    'areas',
    'largest',
    'checks',
    'secrets',
    'limits',
    'warnings',
  ]);
  assert.match(doc.generatedAt, ISO_UTC);
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.repo.unborn, false);
  assert.equal(doc.repo.head.length, 40);

  const stagedPaths = doc.changes.staged.files.map((file) => file.path);
  assert.deepEqual(stagedPaths, [
    'base.txt',
    'blob.bin',
    'gone.txt',
    'renamed.txt',
    'staged.txt',
  ]);
  const renamed = doc.changes.staged.files.find((file) => file.path === 'renamed.txt');
  assert.equal(renamed.oldPath, 'old.txt');
  assert.equal(renamed.change, 'renamed');
  assert.equal(doc.changes.staged.files.find((file) => file.path === 'blob.bin').binary, true);
  assert.equal(doc.changes.staged.files.find((file) => file.path === 'gone.txt').change, 'deleted');

  assert.deepEqual(doc.changes.unstaged.files.map((file) => file.path), ['base.txt']);
  assert.equal(doc.changes.unstaged.files[0].change, 'modified');

  const untrackedPaths = doc.changes.untracked.files.map((file) => file.path);
  assert.deepEqual(untrackedPaths, ['loose.bin', 'loose.txt']);
  assert.equal(doc.changes.untracked.files[0].content, 'binary');
  assert.equal(doc.changes.untracked.files[1].content, 'scanned');

  assert.equal(doc.changes.statsComplete, false);
  assert.equal(doc.changes.summary.files, 8);
  assert.equal(doc.changes.summary.binary, 2);
  assert.equal(doc.secrets.state, 'partial');
  assert.equal(doc.secrets.truncated, true);
  assert.ok(doc.secrets.reasons.some((reason) => /binary file/.test(reason)));
  assert.deepEqual(
    doc.secrets.findings.map((finding) => ({
      path: finding.path,
      scope: finding.scope,
      rule: finding.rule,
    })),
    [
      { path: 'staged.txt', scope: 'staged', rule: 'credential-assignment' },
      { path: 'loose.txt', scope: 'untracked', rule: 'github-token' },
    ],
  );
  assert.equal(doc.secrets.findings.some((finding) => finding.path === 'blob.bin'), false);
  assert.equal(doc.secrets.findings.some((finding) => finding.path === 'loose.bin'), false);

  for (const output of [run.stdout, run.stderr, human.stdout, human.stderr]) {
    assert.equal(output.includes('staged-secret-value-123'), false);
    assert.equal(output.includes('a'.repeat(36)), false);
    assert.equal(output.includes('AKIA1234567890ABCDEF'), false);
    assert.equal(output.includes('loose-binary-value'), false);
  }
  assert.match(human.stdout, /! staged\.txt:1/);
  assert.match(human.stdout, /recorded|checks/);
  assert.equal(doc.limits.hit.includes('file-list'), false);
  assert.ok(Array.isArray(doc.areas));
  assert.ok(Array.isArray(doc.largest));
  assert.ok(Array.isArray(doc.warnings));
});

test('review handles an unborn HEAD with staged changes', (t) => {
  const dir = initRepo({ commit: false });
  t.after(() => cleanup(dir));

  write(dir, 'first.txt', 'first line\n');
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  git(dir, ['add', 'first.txt']);

  const doc = parseReview(runCli(['review', '--json'], { cwd: dir }));
  assert.equal(doc.repo.unborn, true);
  assert.equal(doc.repo.head, null);
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.changes.staged.files.length, 1);
  assert.equal(doc.changes.staged.files[0].path, 'first.txt');
  assert.equal(doc.changes.staged.files[0].change, 'added');
  assert.equal(doc.changes.untracked.files.length, 1);
  assert.equal(doc.checks.source, 'detected');
  assert.equal(doc.checks.items[0].state, 'not run');
  assert.equal(doc.secrets.state, 'scanned');
});

test('review limits are reported without pretending the result is complete', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    write(dir, `${name}.txt`, `${name} one\n${name} two\n`);
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'many files']);

  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    write(dir, `${name}.txt`, `${name} one\n${name} two changed\n`);
  }
  git(dir, ['add', '.']);
  fs.mkdirSync(path.join(dir, 'dir-a'));
  fs.mkdirSync(path.join(dir, 'dir-b'));
  write(dir, 'dir-a/one.txt', 'one\n');
  write(dir, 'dir-b/two.txt', 'two\n');

  const fileList = collectReview({
    cwd: dir,
    now: new Date('2026-10-28T12:00:00.000Z'),
    limits: { ...REVIEW_LIMITS, maxFilesListed: 2 },
  });
  assert.equal(fileList.changes.staged.filesTotal, 5);
  assert.equal(fileList.changes.staged.files.length, 2);
  assert.equal(fileList.changes.staged.truncated, true);
  assert.ok(fileList.limits.hit.includes('file-list'));

  const untracked = collectReview({
    cwd: dir,
    now: new Date('2026-10-28T12:00:00.000Z'),
    limits: { ...REVIEW_LIMITS, maxUntrackedFiles: 1 },
  });
  assert.equal(untracked.changes.untracked.filesTotal, 2);
  assert.ok(untracked.changes.untracked.omitted >= 1);
  assert.ok(untracked.limits.hit.includes('untracked-files'));
  assert.equal(untracked.warnings.some((warning) => warning.code === 'untracked-incomplete'), true);

  const untrackedBytes = collectReview({
    cwd: dir,
    now: new Date('2026-10-28T12:00:00.000Z'),
    limits: { ...REVIEW_LIMITS, maxUntrackedScanBytes: 3 },
  });
  const partialUntracked = untrackedBytes.changes.untracked.files.find(
    (file) => file.path === 'dir-a/one.txt',
  );
  assert.equal(partialUntracked.content, 'scanned-partial');
  assert.equal(partialUntracked.insertions, null);
  assert.ok(untrackedBytes.limits.hit.includes('untracked-scan-bytes'));

  const diffLimit = collectReview({
    cwd: dir,
    now: new Date('2026-10-28T12:00:00.000Z'),
    limits: { ...REVIEW_LIMITS, maxDiffBytes: 8 },
  });
  assert.equal(diffLimit.changes.staged.available, false);
  assert.equal(diffLimit.changes.complete, false);
  assert.equal(diffLimit.secrets.state, 'partial');
  assert.ok(diffLimit.secrets.reasons.some((reason) => /staged/.test(reason)));
  assert.ok(diffLimit.limits.hit.includes('diff-bytes'));
  assert.equal(diffLimit.warnings.some((warning) => warning.code === 'staged-unavailable'), true);

  const areas = collectReview({
    cwd: dir,
    now: new Date('2026-10-28T12:00:00.000Z'),
    limits: { ...REVIEW_LIMITS, maxAreas: 1 },
  });
  assert.ok(areas.areas.length <= 1);
  assert.ok(areas.limits.hit.includes('areas'));
});

test('review does not execute project scripts or modify the worktree or index', (t) => {
  const dir = initRepo();
  const marker = path.join(dir, 'script-ran.txt');
  t.after(() => cleanup(dir));

  write(dir, 'tracked.txt', 'original\n');
  write(
    dir,
    'package.json',
    JSON.stringify({
      scripts: {
        test: `node -e "require('fs').writeFileSync(process.env.ZIKI_REVIEW_MARKER,'ran')"`,
        build: `node -e "require('fs').writeFileSync(process.env.ZIKI_REVIEW_MARKER,'ran')"`,
      },
    }),
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);

  // Rewrite identical content so the index stat data is stale. A plain
  // `git diff` refreshes it; review must not.
  write(dir, 'tracked.txt', 'original\n');
  write(dir, 'untracked.txt', 'loose\n');

  const before = {
    tree: listFiles(dir),
    index: fs.readFileSync(path.join(dir, '.git', 'index')),
    head: git(dir, ['rev-parse', 'HEAD']).stdout,
    refs: git(dir, ['for-each-ref']).stdout,
  };

  const json = runCli(['review', '--json'], {
    cwd: dir,
    env: { ZIKI_REVIEW_MARKER: marker },
  });
  const human = runCli(['review'], {
    cwd: dir,
    env: { ZIKI_REVIEW_MARKER: marker },
  });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(human.status, 0, human.stderr);

  const after = {
    tree: listFiles(dir),
    index: fs.readFileSync(path.join(dir, '.git', 'index')),
    head: git(dir, ['rev-parse', 'HEAD']).stdout,
    refs: git(dir, ['for-each-ref']).stdout,
  };

  assert.deepEqual(after.tree, before.tree);
  assert.deepEqual(after.index, before.index, 'review refreshed the Git index');
  assert.equal(after.head, before.head);
  assert.equal(after.refs, before.refs);
  assert.equal(fs.existsSync(marker), false, 'review executed a project script');
  assert.equal(fs.existsSync(path.join(dir, 'ziki.json')), false);
  assert.equal(
    [...after.tree.keys()].some((file) => file.endsWith('.tmp')),
    false,
  );
});

test('review reports a corrupt index instead of crashing or guessing', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'tracked.txt', 'content\n');
  git(dir, ['add', 'tracked.txt']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  fs.writeFileSync(path.join(dir, '.git', 'index'), 'not a real index');

  const run = runCli(['review', '--json'], { cwd: dir });
  const doc = parseReview(run);

  assert.equal(doc.changes.complete, false);
  assert.equal(doc.changes.staged.available, false);
  assert.equal(doc.changes.unstaged.available, false);
  assert.equal(doc.changes.untracked.available, false);
  assert.equal(doc.secrets.state, 'not-scanned');
  assert.equal(doc.changes.summary.files, null);
  assert.equal(
    doc.warnings.some((warning) => warning.code === 'worktree-unavailable'),
    true,
  );
  assert.equal(
    doc.warnings.some((warning) => warning.code === 'staged-unavailable'),
    true,
  );
  assert.equal(
    doc.warnings.some((warning) => warning.code === 'untracked-unavailable'),
    true,
  );
});

test('review fails cleanly when git is not on PATH', (t) => {
  const dir = initRepo();
  const empty = tempDir('ziki-empty-path-');
  t.after(() => {
    cleanup(empty);
    cleanup(dir);
  });

  const run = runCli(['review'], { cwd: dir, env: { PATH: empty } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /git executable not found on PATH/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  assert.equal(run.stdout, '');
});

test('init preserves a recorded lastObserved block verbatim', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));

  assert.equal(runCli(['init', '--apply', '--yes'], { cwd: dir }).status, 0);
  const configPath = path.join(dir, 'ziki.json');
  const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const lastObserved = [
    {
      name: 'test',
      command: 'npm test',
      source: 'package.json#scripts.test',
      result: 'passed',
      exitCode: 0,
      observedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ];
  doc.lastObserved = lastObserved;
  fs.writeFileSync(configPath, serializeConfig(doc));

  write(
    dir,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', lint: 'node --check .' } }),
  );
  const run = runCli(['init', '--apply', '--yes', '--confirm', 'ziki.json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);

  const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(updated.lastObserved, lastObserved);
  assert.equal(verifyIntegrity(updated), true);
  assert.equal(updated.checks.length, 2);

  const review = parseReview(runCli(['review', '--json'], { cwd: dir }));
  assert.equal(review.checks.source, 'ziki.json');
  assert.equal(review.checks.items.find((item) => item.name === 'test').state, 'observed');
  const human = runCli(['review'], { cwd: dir });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /recorded in ziki\.json/);
  assert.doesNotMatch(human.stdout, /verified/);
});

test('review keeps unusual filenames and escapes controls in human output', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  const names = ['space name.txt', 'caf\u00e9.txt'];
  if (process.platform !== 'win32') {
    names.push('quote"name.txt', 'tab\tname.txt', 'newline\nname.txt');
  }
  for (const name of names) {
    write(dir, name, `content for ${name.replace(/\n/g, '\\n')}\n`);
  }
  for (const name of names) {
    git(dir, ['add', '--', name]);
  }

  const doc = parseReview(runCli(['review', '--json'], { cwd: dir }));
  assert.deepEqual(
    doc.changes.staged.files.map((file) => file.path),
    [...names].sort(),
  );

  const human = runCli(['review'], { cwd: dir });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout.includes('\t'), false);
  assert.equal(human.stdout.includes('\nname.txt'), false);
  if (process.platform !== 'win32') {
    assert.match(human.stdout, /tab\\x09name\.txt/);
    assert.match(human.stdout, /newline\\x0aname\.txt/);
  }
});

test('review skips a symlinked untracked file instead of following it', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'target.txt', 'target content\n');
  try {
    fs.symlinkSync('target.txt', path.join(dir, 'link.txt'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('symlink creation is not permitted on this account');
      return;
    }
    throw error;
  }

  const doc = parseReview(runCli(['review', '--json'], { cwd: dir }));
  const link = doc.changes.untracked.files.find((file) => file.path === 'link.txt');
  assert.equal(link.content, 'not-scanned');
  assert.match(link.reason, /symlink/);
  assert.equal(doc.changes.untracked.truncated, true);
  assert.match(doc.secrets.reasons.join('\n'), /not a regular file/);
});
