import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, git, initRepo, runCli, tempDir, write } from '../helpers/repo.js';

/**
 * Contract tests for the generated agent integration. These prove the files
 * our `init` writes match the documented Claude Code and OpenCode layouts.
 * They do not launch the harnesses: they use disposable repositories and only
 * inspect the repository tree, never user-level (~/.claude, ~/.config)
 * configuration.
 */

const SKILL_PATH = '.claude/skills/ziki/SKILL.md';
const CLAUDE_COMMAND = '.claude/commands/ziki.md';
const OPENCODE_COMMAND = '.opencode/commands/ziki.md';

function fixtureRepo(t) {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  return dir;
}

function apply(dir) {
  const run = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

function read(dir, relative) {
  return fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8');
}

/** Extract the simple top-level `key: value` frontmatter fields we generate. */
function frontmatterKeys(text) {
  assert.equal(text.startsWith('---\n'), true, 'file must start with frontmatter');
  const end = text.indexOf('\n---\n', 4);
  assert.notEqual(end, -1, 'frontmatter must be closed');
  const block = text.slice(4, end);
  const keys = [];
  for (const line of block.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/);
    if (match) {
      keys.push(match[1]);
    }
  }
  return { keys, body: text.slice(end + 5) };
}

test('generated files land on the documented harness paths', (t) => {
  const dir = fixtureRepo(t);
  apply(dir);

  for (const relative of [SKILL_PATH, CLAUDE_COMMAND, OPENCODE_COMMAND]) {
    const target = path.join(dir, ...relative.split('/'));
    assert.equal(fs.statSync(target).isFile(), true, `${relative} must be a regular file`);
  }
});

test('the shared skill name matches its directory (Agent Skills convention)', (t) => {
  const dir = fixtureRepo(t);
  apply(dir);

  const text = read(dir, SKILL_PATH);
  const { keys } = frontmatterKeys(text);
  assert.deepEqual(keys, ['name', 'description'],
    'skill frontmatter must use only the documented name and description fields');

  const nameLine = text.match(/^name: (.+)$/m);
  assert.ok(nameLine, 'skill must declare a name');
  const skillDirectory = path.basename(path.dirname(path.join(...SKILL_PATH.split('/'))));
  assert.equal(nameLine[1].trim(), skillDirectory,
    'skill name must match its parent directory name');
});

test('command frontmatter uses only the documented description field', (t) => {
  const dir = fixtureRepo(t);
  apply(dir);

  for (const relative of [CLAUDE_COMMAND, OPENCODE_COMMAND]) {
    const { keys, body } = frontmatterKeys(read(dir, relative));
    assert.deepEqual(keys, ['description'],
      `${relative} frontmatter must contain description only`);
    assert.match(body, /\$ARGUMENTS/,
      `${relative} should pass the invocation arguments through`);
  }
});

test('init writes the documented plural directories, not OpenCode singular', (t) => {
  const dir = fixtureRepo(t);
  apply(dir);

  assert.equal(fs.existsSync(path.join(dir, '.claude', 'commands')), true);
  assert.equal(fs.existsSync(path.join(dir, '.opencode', 'commands')), true);
  assert.equal(fs.existsSync(path.join(dir, '.opencode', 'command')), false,
    'init must not create the undocumented singular directory');

  for (const relative of [SKILL_PATH, CLAUDE_COMMAND, OPENCODE_COMMAND]) {
    assert.equal(read(dir, relative).includes(dir), false,
      `${relative} must not embed the absolute repository path`);
  }
});

test('apply writes nothing outside the repository', (t) => {
  const parent = tempDir('ziki-harness-parent-');
  const dir = path.join(parent, 'repo');
  fs.mkdirSync(dir);
  t.after(() => cleanup(parent));

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Ziki Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);

  apply(dir);

  assert.deepEqual(fs.readdirSync(parent), ['repo'],
    'nothing should be created beside the repository');
  for (const relative of [SKILL_PATH, CLAUDE_COMMAND, OPENCODE_COMMAND, 'ziki.json']) {
    assert.equal(fs.existsSync(path.join(dir, ...relative.split('/'))), true,
      `${relative} should exist inside the repository`);
  }
});
