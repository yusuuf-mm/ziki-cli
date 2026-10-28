import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { initRepo, write, runCli, cleanup, readPackage, git } from '../helpers/repo.js';

const PKG = readPackage();
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('status --json conforms to schema version 1', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, '.claude/skills/ziki/SKILL.md', '---\nname: ziki\ndescription: fixture\n---\n');
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }, null, 2));

  const run = runCli(['status', '--json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');

  const doc = JSON.parse(run.stdout);

  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(Object.keys(doc), [
    'schemaVersion',
    'tool',
    'generatedAt',
    'repo',
    'worktree',
    'agents',
    'checks',
  ]);

  assert.deepEqual(Object.keys(doc.tool), ['name', 'version']);
  assert.equal(doc.tool.name, 'ziki-cli');
  assert.equal(doc.tool.version, PKG.version);

  assert.match(doc.generatedAt, ISO_UTC);

  assert.deepEqual(Object.keys(doc.repo), [
    'root',
    'cwd',
    'isGitRepo',
    'branch',
    'detached',
    'head',
    'upstream',
    'lastCommit',
  ]);
  assert.equal(doc.repo.isGitRepo, true);
  assert.equal(typeof doc.repo.root, 'string');
  assert.equal(path.isAbsolute(doc.repo.root), true);
  assert.equal(doc.repo.cwd, '.');
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.repo.detached, false);
  assert.match(doc.repo.head, /^[0-9a-f]{40}$/);
  assert.equal(doc.repo.upstream, null);

  assert.deepEqual(Object.keys(doc.repo.lastCommit), ['sha', 'shortSha', 'subject', 'date']);
  assert.equal(doc.repo.lastCommit.sha, doc.repo.head);
  assert.equal(doc.repo.lastCommit.subject, 'initial commit');
  assert.match(doc.repo.lastCommit.date, ISO_UTC);

  assert.deepEqual(Object.keys(doc.worktree), [
    'staged',
    'modified',
    'untracked',
    'deleted',
    'renamed',
    'conflicted',
    'clean',
  ]);
  for (const key of ['staged', 'modified', 'untracked', 'deleted', 'renamed', 'conflicted']) {
    assert.equal(typeof doc.worktree[key], 'number', key);
    assert.ok(doc.worktree[key] >= 0, key);
  }
  assert.equal(typeof doc.worktree.clean, 'boolean');

  assert.ok(Array.isArray(doc.agents));
  assert.deepEqual(Object.keys(doc.agents[0]), ['kind', 'path']);
  assert.equal(doc.agents[0].kind, 'claude-skill');
  assert.equal(doc.agents[0].path, '.claude/skills/ziki/SKILL.md');

  assert.ok(Array.isArray(doc.checks));
  assert.deepEqual(Object.keys(doc.checks[0]), ['name', 'command', 'source', 'executed']);
  assert.equal(doc.checks[0].name, 'test');
  assert.equal(doc.checks[0].command, 'npm test');
  assert.equal(doc.checks[0].source, 'package.json#scripts.test');
  assert.equal(doc.checks[0].executed, false);

  assert.equal(run.stdout.includes('\u001b'), false);
});

test('status --json handles nullability: unborn repository', (t) => {
  const dir = initRepo({ commit: false });
  t.after(() => cleanup(dir));

  const run = runCli(['status', '--json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);

  const doc = JSON.parse(run.stdout);
  assert.equal(doc.repo.head, null);
  assert.equal(doc.repo.lastCommit, null);
  assert.equal(doc.repo.upstream, null);
  assert.equal(doc.repo.detached, false);
  assert.equal(typeof doc.repo.branch, 'string');
});

test('status --json handles nullability: detached HEAD', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  git(dir, ['checkout', '-q', '--detach', 'HEAD']);

  const run = runCli(['status', '--json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);

  const doc = JSON.parse(run.stdout);
  assert.equal(doc.repo.branch, null);
  assert.equal(doc.repo.detached, true);
  assert.match(doc.repo.head, /^[0-9a-f]{40}$/);
});

test('review --json conforms to schema version 1', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }, null, 2));
  write(dir, 'tracked.txt', 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);

  write(dir, 'tracked.txt', 'one\ntwo\n');
  git(dir, ['add', 'tracked.txt']);
  write(dir, 'tracked.txt', 'one\ntwo\nunstaged\n');
  write(dir, 'untracked.txt', 'loose\n');
  write(dir, 'staged-secret.txt', 'api_key = "contract-secret-value"\n');
  git(dir, ['add', 'staged-secret.txt']);

  const run = runCli(['review', '--json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.includes('\u001b'), false);

  const doc = JSON.parse(run.stdout);
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
  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(Object.keys(doc.tool), ['name', 'version']);
  assert.equal(doc.tool.name, 'ziki-cli');
  assert.equal(doc.tool.version, PKG.version);
  assert.match(doc.generatedAt, ISO_UTC);

  assert.deepEqual(Object.keys(doc.repo), [
    'root',
    'cwd',
    'branch',
    'detached',
    'head',
    'unborn',
  ]);
  assert.equal(path.isAbsolute(doc.repo.root), true);
  assert.equal(doc.repo.cwd, '.');
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.repo.detached, false);
  assert.match(doc.repo.head, /^[0-9a-f]{40}$/);
  assert.equal(doc.repo.unborn, false);

  assert.deepEqual(Object.keys(doc.changes), [
    'complete',
    'statsComplete',
    'filesTruncated',
    'staged',
    'unstaged',
    'untracked',
    'summary',
  ]);
  assert.equal(doc.changes.complete, true);
  assert.equal(doc.changes.statsComplete, true);
  assert.equal(doc.changes.filesTruncated, false);

  assert.deepEqual(Object.keys(doc.changes.staged), [
    'available',
    'complete',
    'error',
    'reasons',
    'files',
    'filesTotal',
    'filesListed',
    'truncated',
    'counts',
    'statsComplete',
    'insertions',
    'deletions',
    'binary',
    'contentAvailable',
    'contentComplete',
  ]);
  assert.equal(doc.changes.staged.available, true);
  assert.equal(doc.changes.staged.error, null);
  assert.equal(doc.changes.staged.files.length, 2);
  assert.deepEqual(Object.keys(doc.changes.staged.files[0]), [
    'path',
    'oldPath',
    'change',
    'status',
    'renamed',
    'copied',
    'conflicted',
    'binary',
    'insertions',
    'deletions',
    'stats',
    'modeChange',
    'scope',
  ]);

  assert.deepEqual(Object.keys(doc.changes.unstaged), Object.keys(doc.changes.staged));
  assert.equal(doc.changes.unstaged.files.length, 1);
  assert.equal(doc.changes.unstaged.files[0].path, 'tracked.txt');

  assert.deepEqual(Object.keys(doc.changes.untracked), [
    'available',
    'error',
    'files',
    'filesTotal',
    'filesListed',
    'truncated',
    'omitted',
    'insertions',
    'bytes',
    'binary',
    'scannedFiles',
    'scannedLines',
    'reasons',
  ]);
  assert.equal(doc.changes.untracked.files.length, 1);
  assert.deepEqual(Object.keys(doc.changes.untracked.files[0]), [
    'path',
    'content',
    'binary',
    'bytes',
    'insertions',
    'reason',
  ]);

  assert.deepEqual(Object.keys(doc.changes.summary), [
    'files',
    'insertions',
    'deletions',
    'binary',
    'added',
    'modified',
    'deleted',
    'renamed',
    'copied',
    'typechange',
    'conflicted',
    'unknown',
    'untracked',
    'statsComplete',
  ]);
  assert.equal(typeof doc.changes.summary.files, 'number');

  assert.ok(Array.isArray(doc.areas));
  assert.ok(Array.isArray(doc.largest));
  assert.deepEqual(Object.keys(doc.checks), ['source', 'detail', 'items']);
  assert.equal(doc.checks.source, 'detected');
  assert.equal(doc.checks.items[0].state, 'not run');
  assert.deepEqual(Object.keys(doc.checks.items[0]), [
    'name',
    'command',
    'source',
    'origin',
    'state',
    'observed',
    'detail',
  ]);

  assert.deepEqual(Object.keys(doc.secrets), [
    'state',
    'findings',
    'scanned',
    'truncated',
    'reasons',
  ]);
  assert.ok(['scanned', 'partial', 'not-scanned'].includes(doc.secrets.state));
  assert.deepEqual(Object.keys(doc.secrets.findings[0]), [
    'path',
    'line',
    'scope',
    'rule',
  ]);
  assert.deepEqual(Object.keys(doc.secrets.scanned), [
    'stagedLines',
    'unstagedLines',
    'untrackedLines',
    'totalLines',
  ]);

  assert.deepEqual(Object.keys(doc.limits), [
    'maxDiffBytes',
    'maxAddedLines',
    'maxLineLength',
    'maxFindings',
    'maxUntrackedFiles',
    'maxUntrackedFileBytes',
    'maxUntrackedScanBytes',
    'maxFilesListed',
    'maxAreas',
    'maxLargest',
    'hit',
  ]);
  assert.ok(Array.isArray(doc.limits.hit));
  assert.ok(Array.isArray(doc.warnings));
  for (const warning of doc.warnings) {
    assert.deepEqual(Object.keys(warning), ['code', 'message']);
  }
});

test('review --json handles nullability: unborn repository', (t) => {
  const dir = initRepo({ commit: false });
  t.after(() => cleanup(dir));

  const run = runCli(['review', '--json'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);

  const doc = JSON.parse(run.stdout);
  assert.equal(doc.repo.unborn, true);
  assert.equal(doc.repo.head, null);
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.changes.staged.available, true);
  assert.equal(doc.changes.staged.files.length, 0);
  assert.equal(doc.changes.untracked.files.length, 0);
  assert.equal(doc.changes.summary.files, 0);
});
