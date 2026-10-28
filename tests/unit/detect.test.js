import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectAgents } from '../../src/detect/agents.js';
import { detectChecks } from '../../src/detect/checks.js';
import { tempDir, write, cleanup } from '../helpers/repo.js';

function withFixture(t) {
  const dir = tempDir();
  t.after(() => cleanup(dir));
  return dir;
}

test('no manifests means no checks', (t) => {
  const dir = withFixture(t);
  assert.deepEqual(detectChecks(dir), []);
});

test('node scripts become checks in a stable order', (t) => {
  const dir = withFixture(t);
  write(
    dir,
    'package.json',
    JSON.stringify({
      scripts: {
        build: 'tsc',
        test: 'node --test',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        dev: 'node server.js',
      },
    }),
  );

  assert.deepEqual(detectChecks(dir), [
    { name: 'test', command: 'npm test', source: 'package.json#scripts.test', executed: false },
    { name: 'lint', command: 'npm run lint', source: 'package.json#scripts.lint', executed: false },
    {
      name: 'typecheck',
      command: 'npm run typecheck',
      source: 'package.json#scripts.typecheck',
      executed: false,
    },
    { name: 'build', command: 'npm run build', source: 'package.json#scripts.build', executed: false },
  ]);
});

test('empty script values are ignored', (t) => {
  const dir = withFixture(t);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: '   ', lint: 'eslint .' } }));
  assert.deepEqual(detectChecks(dir), [
    { name: 'lint', command: 'npm run lint', source: 'package.json#scripts.lint', executed: false },
  ]);
});

test('malformed package.json does not throw and yields nothing', (t) => {
  const dir = withFixture(t);
  write(dir, 'package.json', '{ not json');
  assert.deepEqual(detectChecks(dir), []);
});

test('oversized package.json is skipped instead of read', (t) => {
  const dir = withFixture(t);
  const manifest = JSON.stringify({
    scripts: { test: 'node --test' },
    padding: 'x'.repeat(1024 * 1024 + 64),
  });
  write(dir, 'package.json', manifest);

  assert.deepEqual(detectChecks(dir), []);
});

test('flutter, go, and rust manifests are detected', (t) => {
  const dir = withFixture(t);
  write(dir, 'pubspec.yaml', 'name: fixture\n');
  write(dir, 'go.mod', 'module example.com/fixture\n');
  write(dir, 'Cargo.toml', '[package]\nname = "fixture"\n');

  assert.deepEqual(detectChecks(dir), [
    { name: 'test', command: 'flutter test', source: 'pubspec.yaml', executed: false },
    { name: 'analyze', command: 'flutter analyze', source: 'pubspec.yaml', executed: false },
    { name: 'test', command: 'go test ./...', source: 'go.mod', executed: false },
    { name: 'test', command: 'cargo test', source: 'Cargo.toml', executed: false },
  ]);
});

test('agent files are detected by presence and sorted by path', (t) => {
  const dir = withFixture(t);
  write(dir, '.claude/skills/ziki/SKILL.md', '---\nname: ziki\n---\n');
  write(dir, '.claude/skills/empty/README.md', 'not a skill\n');
  write(dir, '.claude/commands/ziki.md', 'command\n');
  write(dir, '.claude/commands/notes.txt', 'not a command\n');
  write(dir, '.opencode/skills/helper/SKILL.md', '---\nname: helper\n---\n');
  write(dir, '.opencode/commands/run.md', 'command\n');
  write(dir, '.agents/skills/shared/SKILL.md', '---\nname: shared\n---\n');
  write(dir, 'AGENTS.md', '# agents\n');
  write(dir, 'CLAUDE.md', '# claude\n');

  assert.deepEqual(detectAgents(dir), [
    { kind: 'agents-skill', path: '.agents/skills/shared/SKILL.md' },
    { kind: 'claude-command', path: '.claude/commands/ziki.md' },
    { kind: 'claude-skill', path: '.claude/skills/ziki/SKILL.md' },
    { kind: 'opencode-command', path: '.opencode/commands/run.md' },
    { kind: 'opencode-skill', path: '.opencode/skills/helper/SKILL.md' },
    { kind: 'instructions', path: 'AGENTS.md' },
    { kind: 'instructions', path: 'CLAUDE.md' },
  ]);
});

test('missing agent directories are not an error', (t) => {
  const dir = withFixture(t);
  assert.deepEqual(detectAgents(path.join(dir, 'does-not-exist')), []);
});

test('singular .opencode/command directory is detected as opencode-command', (t) => {
  const dir = withFixture(t);
  write(dir, '.opencode/command/ziki.md', 'command\n');
  const found = detectAgents(dir);
  const opencodeCommands = found.filter(
    (f) => f.kind === 'opencode-command' && f.path.endsWith('command/ziki.md')
  );
  assert.strictEqual(opencodeCommands.length, 1,
    `expected 1 opencode-command from singular dir, got ${opencodeCommands.length}`);
  assert.strictEqual(opencodeCommands[0].path, '.opencode/command/ziki.md');
});
