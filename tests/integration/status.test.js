import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, write, git, runCli, cleanup, tempDir } from '../helpers/repo.js';

function statusJson(cwd) {
  const run = runCli(['status', '--json'], { cwd });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('worktree tallies match Git state', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'modified.txt', 'one\n');
  write(dir, 'deleted.txt', 'gone\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add tracked files']);

  fs.writeFileSync(path.join(dir, 'modified.txt'), 'two\n');
  git(dir, ['rm', '-q', 'deleted.txt']);
  write(dir, 'staged.txt', 'new\n');
  git(dir, ['add', 'staged.txt']);
  write(dir, 'u1.txt', '1\n');
  write(dir, 'u2.txt', '2\n');
  write(dir, 'u3.txt', '3\n');

  const doc = statusJson(dir);
  assert.equal(doc.worktree.staged, 2);
  assert.equal(doc.worktree.modified, 1);
  assert.equal(doc.worktree.untracked, 3);
  assert.equal(doc.worktree.deleted, 1);
  assert.equal(doc.worktree.renamed, 0);
  assert.equal(doc.worktree.conflicted, 0);
  assert.equal(doc.worktree.clean, false);
});

test('paths with spaces survive rename and untracked detection', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'tracked file.txt', 'a\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add spaced file']);
  git(dir, ['mv', 'tracked file.txt', 'renamed file.txt']);
  write(dir, 'space untracked.txt', 'b\n');

  const doc = statusJson(dir);
  assert.equal(doc.worktree.renamed, 1);
  assert.equal(doc.worktree.staged, 1);
  assert.equal(doc.worktree.untracked, 1);
});

test('upstream divergence reports ahead and behind', (t) => {
  const origin = tempDir('ziki-origin-');
  const work = tempDir('ziki-work-');
  const other = tempDir('ziki-other-');
  t.after(() => {
    cleanup(origin);
    cleanup(work);
    cleanup(other);
  });

  git(origin, ['init', '-q', '--bare', '-b', 'main']);
  git(work, ['clone', '-q', origin, '.']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Ziki Test']);
  write(work, 'a.txt', 'a\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'base']);
  git(work, ['push', '-q', '-u', 'origin', 'main']);

  git(other, ['clone', '-q', origin, '.']);
  git(other, ['config', 'user.email', 'test@example.com']);
  git(other, ['config', 'user.name', 'Ziki Test']);
  write(other, 'b.txt', 'b\n');
  git(other, ['add', '.']);
  git(other, ['commit', '-q', '-m', 'remote advance']);
  git(other, ['push', '-q']);

  write(work, 'c.txt', 'c\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'local one']);
  write(work, 'd.txt', 'd\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'local two']);
  git(work, ['fetch', '-q', 'origin']);

  const doc = statusJson(work);
  assert.deepEqual(doc.repo.upstream, {
    name: 'origin/main',
    ahead: 2,
    behind: 1,
  });
});

test('no upstream is null', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  assert.equal(statusJson(dir).repo.upstream, null);
});

test('unborn branch has null head and last commit', (t) => {
  const dir = initRepo({ commit: false });
  t.after(() => cleanup(dir));
  write(dir, 'loose.txt', 'x\n');

  const doc = statusJson(dir);
  assert.equal(doc.repo.head, null);
  assert.equal(doc.repo.lastCommit, null);
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.worktree.untracked, 1);
  assert.equal(doc.worktree.clean, false);

  const human = runCli(['status'], { cwd: dir });
  assert.equal(human.status, 0);
  assert.match(human.stdout, /\(no commits yet\)/);
});

test('detached HEAD reports detached and a null branch', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  git(dir, ['checkout', '-q', '--detach', 'HEAD']);

  const doc = statusJson(dir);
  assert.equal(doc.repo.branch, null);
  assert.equal(doc.repo.detached, true);
  assert.match(doc.repo.head, /^[0-9a-f]{40}$/);

  const human = runCli(['status'], { cwd: dir });
  assert.match(human.stdout, /detached at [0-9a-f]{7}/);
});

test('invocation from a subdirectory reports a relative cwd', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'nested/deep/file.txt', 'x\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add nested file']);

  // Changes at the repository root must still be counted from a subdirectory.
  fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  write(dir, 'root-untracked.txt', 'y\n');

  const subdir = path.join(dir, 'nested', 'deep');
  const doc = statusJson(subdir);
  assert.equal(doc.repo.cwd, 'nested/deep');
  assert.equal(doc.repo.root, path.resolve(dir));
  assert.equal(doc.repo.branch, 'main');
  assert.equal(doc.worktree.modified, 1);
  assert.equal(doc.worktree.untracked, 1);
});

test('the four documented agent locations are detected', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, '.claude/skills/ziki/SKILL.md', '---\nname: ziki\n---\n');
  write(dir, '.opencode/commands/ziki.md', 'command\n');
  write(dir, 'AGENTS.md', '# agents\n');
  write(dir, 'CLAUDE.md', '# claude\n');

  const doc = statusJson(dir);
  assert.deepEqual(doc.agents, [
    { kind: 'claude-skill', path: '.claude/skills/ziki/SKILL.md' },
    { kind: 'opencode-command', path: '.opencode/commands/ziki.md' },
    { kind: 'instructions', path: 'AGENTS.md' },
    { kind: 'instructions', path: 'CLAUDE.md' },
  ]);
});

test('test, lint, and build scripts become three checks, none executed', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(
    dir,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' } }),
  );

  const doc = statusJson(dir);
  assert.deepEqual(doc.checks, [
    { name: 'test', command: 'npm test', source: 'package.json#scripts.test', executed: false },
    { name: 'lint', command: 'npm run lint', source: 'package.json#scripts.lint', executed: false },
    { name: 'build', command: 'npm run build', source: 'package.json#scripts.build', executed: false },
  ]);
});

test(
  'newline-containing paths parse correctly',
  { skip: process.platform === 'win32' ? 'Windows filenames cannot contain newlines' : false },
  (t) => {
    const dir = initRepo();
    t.after(() => cleanup(dir));
    write(dir, 'line\nbreak.txt', 'x\n');

    const doc = statusJson(dir);
    assert.equal(doc.worktree.untracked, 1);
  },
);

test(
  'repository roots with trailing spaces are preserved',
  { skip: process.platform === 'win32' ? 'Windows filenames cannot end in a space' : false },
  (t) => {
    const parent = tempDir('ziki-trailing-');
    const dir = path.join(parent, 'repo ');
    t.after(() => cleanup(parent));
    fs.mkdirSync(dir);

    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Ziki Test']);
    write(dir, 'a.txt', 'x\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'base']);

    const doc = statusJson(dir);
    assert.equal(doc.repo.root, path.resolve(dir));
    assert.equal(doc.repo.cwd, '.');
  },
);

test('human output describes a clean repository', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  const run = runCli(['status'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ziki status\n/);
  assert.match(run.stdout, /branch\s+main {2}\(no upstream\)/);
  assert.match(run.stdout, /worktree {2}clean/);
  assert.match(run.stdout, /last\s+[0-9a-f]{7} {2}initial commit/);
  assert.match(run.stdout, /agents\s+\(none detected\)/);
  assert.match(run.stdout, /checks\s+\(none detected\)/);
  assert.equal(run.stdout.includes('\u001b'), false);
});

test('dirty repositories still exit 0', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(dir, 'untracked.txt', 'x\n');

  const run = runCli(['status'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 untracked/);
  assert.match(run.stdout, /\(not clean\)/);
});

test('two runs are byte-identical except generatedAt', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  const first = JSON.parse(runCli(['status', '--json'], { cwd: dir }).stdout);
  const second = JSON.parse(runCli(['status', '--json'], { cwd: dir }).stdout);
  delete first.generatedAt;
  delete second.generatedAt;
  assert.deepEqual(first, second);
});
