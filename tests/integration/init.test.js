import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanup,
  initRepo,
  runCli,
  tempDir,
  write,
} from '../helpers/repo.js';
import {
  parseConfigText,
  verifyIntegrity,
} from '../../src/config/zikiConfig.js';
import { applyInitPlan, buildInitPlan } from '../../src/commands/init.js';

function treeSnapshot(root) {
  const files = [];

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
        const digest = crypto
          .createHash('sha256')
          .update(fs.readFileSync(target))
          .digest('hex');
        files.push(`${relative}:${digest}`);
      }
    }
  }

  walk(root);
  return files.sort().join('\n');
}

function configPath(dir) {
  return path.join(dir, 'ziki.json');
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
}

function repoWithScripts(t) {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(
    dir,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
  );
  return dir;
}

function applyFresh(dir) {
  const run = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);
  return run;
}

test('init defaults to a plan and writes nothing', (t) => {
  const dir = repoWithScripts(t);
  const before = treeSnapshot(dir);

  const run = runCli(['init'], { cwd: dir });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^ziki init \(plan\)/);
  assert.match(run.stdout, /ziki\.json {2}\(new\)/);
  assert.match(run.stdout, /"schemaVersion": 1/);
  assert.match(run.stdout, /npm test/);
  assert.match(run.stdout, /No files written\. Re-run with --apply to write\./);
  assert.equal(fs.existsSync(configPath(dir)), false);
  assert.equal(treeSnapshot(dir), before);
});

test('init --plan is explicit and still writes nothing', (t) => {
  const dir = repoWithScripts(t);
  const before = treeSnapshot(dir);

  const run = runCli(['init', '--plan'], { cwd: dir });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\(new\)/);
  assert.equal(fs.existsSync(configPath(dir)), false);
  assert.equal(treeSnapshot(dir), before);
});

test('init --apply refuses without approval in a non-interactive shell', (t) => {
  const dir = repoWithScripts(t);

  const run = runCli(['init', '--apply'], { cwd: dir });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing to apply without approval/);
  assert.match(run.stderr, /--yes/);
  assert.equal(fs.existsSync(configPath(dir)), false);
});

test('init --apply --yes creates a valid hashed config with agent files', (t) => {
  const dir = repoWithScripts(t);

  const run = applyFresh(dir);

  assert.match(run.stdout, /ziki init \(applied\)/);
  assert.match(run.stdout, /created  .+  sha256:[0-9a-f]{12}/);

  const text = fs.readFileSync(configPath(dir), 'utf8');
  const parsed = parseConfigText(text);
  assert.equal(parsed.kind, 'valid');
  assert.equal(parsed.integrityValid, true);
  assert.equal(parsed.doc.schemaVersion, 1);
  assert.deepEqual(parsed.doc.checks, [
    {
      name: 'test',
      command: 'npm test',
      source: 'package.json#scripts.test',
    },
    {
      name: 'lint',
      command: 'npm run lint',
      source: 'package.json#scripts.lint',
    },
  ]);
  // managedFiles now records 3 agent-file hashes (skills and commands).
  assert.ok(parsed.doc.managedFiles && Object.keys(parsed.doc.managedFiles).length === 3,
    `expected 3 managedFiles entries, got ${Object.keys(parsed.doc.managedFiles ?? {}).length}`);
  assert.ok(
    '.claude/skills/ziki/SKILL.md' in parsed.doc.managedFiles,
    'managedFiles contains the skill path',
  );
  assert.ok(
    '.claude/commands/ziki.md' in parsed.doc.managedFiles,
    'managedFiles contains the claude command path',
  );
  assert.ok(
    '.opencode/commands/ziki.md' in parsed.doc.managedFiles,
    'managedFiles contains the opencode command path',
  );
  assert.equal(parsed.doc.generatedAt, undefined);
});

test('a second apply is a no-op and does not rewrite the file', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  const before = fs.readFileSync(configPath(dir));
  const statBefore = fs.statSync(configPath(dir));

  // Read-only is a second signal on platforms where rename would fail. On
  // POSIX the content and the explicit "No files written" message carry it.
  fs.chmodSync(configPath(dir), 0o444);
  try {
    const run = runCli(['init', '--apply', '--yes'], { cwd: dir });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ziki\.json {2}\(unchanged\)/);
    assert.match(run.stdout, /Summary: no changes\./);
    assert.match(run.stdout, /No files written\./);
  } finally {
    fs.chmodSync(configPath(dir), 0o666);
  }

  const after = fs.readFileSync(configPath(dir));
  assert.deepEqual(after, before);
  assert.equal(fs.statSync(configPath(dir)).mtimeMs, statBefore.mtimeMs);
});

test('manifest changes need per-file confirmation before rewriting', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  const before = fs.readFileSync(configPath(dir));
  write(
    dir,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' } }),
  );

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to overwrite "ziki\.json"/);
  assert.match(refused.stderr, /--confirm ziki\.json/);
  assert.deepEqual(fs.readFileSync(configPath(dir)), before);

  const applied = runCli(
    ['init', '--apply', '--yes', '--confirm', 'ziki.json'],
    { cwd: dir },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /ziki init \(applied\)/);

  const config = readConfig(dir);
  assert.equal(config.integrity.algorithm, 'sha256');
  assert.equal(verifyIntegrity(config), true);
  assert.equal(config.checks.length, 3);
  assert.equal(config.checks[2].name, 'build');
});

test('a hand-edited config is reported and preserved after confirmation', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  const edited = readConfig(dir);
  edited.team = 'neo';
  fs.writeFileSync(configPath(dir), `${JSON.stringify(edited, null, 2)}\n`);

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\(update · integrity mismatch\)/);

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /integrity mismatch/);

  const applied = runCli(
    ['init', '--apply', '--yes', '--confirm', './ziki.json'],
    { cwd: dir },
  );
  assert.equal(applied.status, 0, applied.stderr);

  const config = readConfig(dir);
  assert.equal(config.team, 'neo');
  assert.equal(verifyIntegrity(config), true);
});

test('invalid JSON is replaced only after confirmation', (t) => {
  const dir = repoWithScripts(t);
  write(dir, 'ziki.json', '{ this is not json\n');

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\(replace · not valid JSON\)/);

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), '{ this is not json\n');

  const applied = runCli(
    ['init', '--apply', '--yes', '--confirm', 'ziki.json'],
    { cwd: dir },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(parseConfigText(fs.readFileSync(configPath(dir), 'utf8')).kind, 'valid');
});

test('a foreign JSON file is not silently replaced', (t) => {
  const dir = repoWithScripts(t);
  const foreign = `${JSON.stringify({ hello: 'world' }, null, 2)}\n`;
  write(dir, 'ziki.json', foreign);

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\(replace · not a Ziki configuration\)/);

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), foreign);
});

test('a newer schemaVersion blocks init instead of downgrading it', (t) => {
  const dir = repoWithScripts(t);
  const future = `${JSON.stringify({ schemaVersion: 2 }, null, 2)}\n`;
  write(dir, 'ziki.json', future);

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 1);
  assert.match(plan.stdout, /blocked · schemaVersion 2 is not supported/);
  assert.match(plan.stderr, /newer schemaVersion/);

  const apply = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(apply.status, 1);
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), future);
});

test('ziki.json as a directory is refused', (t) => {
  const dir = repoWithScripts(t);
  fs.mkdirSync(configPath(dir));

  const run = runCli(['init'], { cwd: dir });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /it is a directory/);
  assert.equal(fs.statSync(configPath(dir)).isDirectory(), true);
});

test(
  'ziki.json as a symlink is refused and its target is untouched',
  (t) => {
    const dir = repoWithScripts(t);
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, '{"keep":"me"}\n');

    try {
      fs.symlinkSync(target, configPath(dir), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip('symlink creation is not permitted on this account');
        return;
      }
      throw error;
    }

    const run = runCli(['init', '--apply', '--yes'], { cwd: dir });

    assert.equal(run.status, 1);
    assert.match(run.stderr, /symlink/);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"keep":"me"}\n');
  },
);

test('confirm paths must be safe and part of the plan', (t) => {
  const dir = repoWithScripts(t);

  for (const [args, message] of [
    [
      ['init', '--apply', '--yes', '--confirm', 'other.json'],
      /not part of this plan/,
    ],
    [
      ['init', '--apply', '--yes', '--confirm', '../ziki.json'],
      /repository-relative path/,
    ],
    [['init', '--confirm', 'ziki.json'], /--confirm requires --apply/],
    [['init', '--yes'], /--yes requires --apply/],
    [['init', '--plan', '--apply'], /cannot be used together/],
  ]) {
    const run = runCli(args, { cwd: dir });
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr}`);
    assert.match(run.stderr, message);
  }

  assert.equal(fs.existsSync(configPath(dir)), false);
});

test('init and status reject each other\'s options', (t) => {
  const dir = repoWithScripts(t);

  const initJson = runCli(['init', '--json'], { cwd: dir });
  assert.equal(initJson.status, 2);
  assert.match(initJson.stderr, /--json is not supported by "init"/);

  const statusApply = runCli(['status', '--apply'], { cwd: dir });
  assert.equal(statusApply.status, 2);
  assert.match(statusApply.stderr, /--apply is not supported by "status"/);
});

test('init writes at the repository root when run from a subdirectory', (t) => {
  const dir = repoWithScripts(t);
  write(dir, 'nested/file.txt', 'x\n');

  const run = runCli(['init', '--apply', '--yes'], {
    cwd: path.join(dir, 'nested'),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(configPath(dir)), true);
  assert.equal(fs.existsSync(path.join(dir, 'nested', 'ziki.json')), false);
});

test('plan output escapes control characters from an unreadable config', (t) => {
  const dir = repoWithScripts(t);
  write(dir, 'ziki.json', '{\n  "\u001b[31mkey\u0007": true\n}\n');

  const run = runCli(['init'], { cwd: dir });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.includes('\u001b'), false);
  assert.equal(run.stdout.includes('\u0007'), false);
  assert.match(run.stdout, /\\x1b\[31mkey\\x07/);
});

test('plan output is deterministic', (t) => {
  const dir = repoWithScripts(t);

  const first = runCli(['init'], { cwd: dir });
  const second = runCli(['init'], { cwd: dir });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stderr, second.stderr);
});

test('an oversized config is not read and needs confirmation', (t) => {
  const dir = repoWithScripts(t);
  const huge = `${'x'.repeat(1024 * 1024 + 1)}\n`;
  write(dir, 'ziki.json', huge);

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\(replace · larger than 1 MiB\)/);
  assert.match(plan.stdout, /existing contents were not read/);

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), huge);
});

test('init works when no checks are detected', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /checks {4}\(none detected\)/);

  const applied = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(applied.status, 0, applied.stderr);

  const config = readConfig(dir);
  assert.deepEqual(config.checks, []);
  assert.equal(verifyIntegrity(config), true);
});

test('init works on an unborn branch', (t) => {
  const dir = initRepo({ commit: false });
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));

  const run = runCli(['init', '--apply', '--yes'], { cwd: dir });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(configPath(dir)), true);
  assert.equal(parseConfigText(fs.readFileSync(configPath(dir), 'utf8')).kind, 'valid');
});

test('apply refuses when the config changed after the plan', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  write(
    dir,
    'package.json',
    JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc' } }),
  );
  const plan = buildInitPlan({ cwd: dir });
  assert.equal(plan.summary.update, 1);

  fs.writeFileSync(configPath(dir), 'edited after the plan\n');

  assert.throws(
    () => applyInitPlan(plan, { confirm: ['ziki.json'] }),
    /changed after the plan was generated/,
  );
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), 'edited after the plan\n');
});

test('apply refuses when the config appears after the plan', (t) => {
  const dir = repoWithScripts(t);
  const plan = buildInitPlan({ cwd: dir });
  // Agent files are now part of the init plan; 4 creates: ziki.json + skill + 2 commands.
  assert.equal(plan.summary.create, 4);

  fs.writeFileSync(configPath(dir), 'appeared after the plan\n');

  assert.throws(
    () => applyInitPlan(plan, {}),
    /appeared after the plan was generated/,
  );
  assert.equal(fs.readFileSync(configPath(dir), 'utf8'), 'appeared after the plan\n');
});

test('init outside a repository fails without writing', () => {
  const dir = tempDir();
  try {
    const run = runCli(['init'], { cwd: dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a git repository/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Phase 4: agent skill/command files
// ---------------------------------------------------------------------------

const AGENT_FILES = [
  '.claude/skills/ziki/SKILL.md',
  '.claude/commands/ziki.md',
  '.opencode/commands/ziki.md',
];

function sha256File(dir, relative) {
  const target = path.join(dir, ...relative.split('/'));
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

test('init plans ziki.json plus three agent files, writing nothing', (t) => {
  const dir = repoWithScripts(t);
  const before = treeSnapshot(dir);

  const run = runCli(['init'], { cwd: dir });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /config {4}ziki\.json {2}\(new\)/);
  assert.match(run.stdout, /agent {5}\.claude\/skills\/ziki\/SKILL\.md {2}\(new\)/);
  assert.match(run.stdout, /agent {5}\.claude\/commands\/ziki\.md {2}\(new\)/);
  assert.match(run.stdout, /agent {5}\.opencode\/commands\/ziki\.md {2}\(new\)/);
  assert.match(run.stdout, /Summary: 4 files to create\./);
  assert.equal(treeSnapshot(dir), before);
});

test('apply writes every agent file and records hashes that match disk', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  for (const relative of AGENT_FILES) {
    assert.equal(fs.existsSync(path.join(dir, ...relative.split('/'))), true,
      `${relative} should exist after apply`);
  }

  const config = readConfig(dir);
  for (const relative of AGENT_FILES) {
    assert.equal(
      config.managedFiles[relative],
      `sha256:${sha256File(dir, relative)}`,
      `${relative} hash should match the written bytes`,
    );
  }
});

test('an agent file changed after apply needs its own confirmation', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  const skillPath = path.join(dir, '.claude', 'skills', 'ziki', 'SKILL.md');
  fs.appendFileSync(skillPath, '\nhand edit\n');

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\(update · modified since last write\)/);
  assert.match(plan.stdout, /ziki\.json {2}\(unchanged\)/);

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\.claude\/skills\/ziki\/SKILL\.md/);
  assert.match(refused.stderr, /modified since last write/);
  assert.match(fs.readFileSync(skillPath, 'utf8'), /hand edit/);

  const applied = runCli(
    ['init', '--apply', '--yes', '--confirm', '.claude/skills/ziki/SKILL.md'],
    { cwd: dir },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(skillPath, 'utf8').includes('hand edit'), false);

  const config = readConfig(dir);
  assert.equal(
    config.managedFiles['.claude/skills/ziki/SKILL.md'],
    `sha256:${sha256File(dir, '.claude/skills/ziki/SKILL.md')}`,
    'hash should be updated after the confirmed rewrite',
  );
});

test('an agent file created outside ziki init is not silently replaced', (t) => {
  const dir = repoWithScripts(t);
  write(dir, '.claude/commands/ziki.md', 'my own command file\n');

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /\(update · not written by ziki init\)/);

  const refused = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--confirm \.claude\/commands\/ziki\.md/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'commands', 'ziki.md'), 'utf8'), 'my own command file\n');

  const applied = runCli(
    ['init', '--apply', '--yes', '--confirm', '.claude/commands/ziki.md'],
    { cwd: dir },
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(fs.readFileSync(path.join(dir, '.claude', 'commands', 'ziki.md'), 'utf8'), /ziki-cli repository workflow/);
});

test('an agent file target that is a directory is refused', (t) => {
  const dir = repoWithScripts(t);
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'ziki', 'SKILL.md'), { recursive: true });

  const run = runCli(['init'], { cwd: dir });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing to write "\.claude\/skills\/ziki\/SKILL\.md"/);
  assert.match(run.stderr, /is a directory/);
  assert.equal(fs.existsSync(configPath(dir)), false);
});

test('an agent file target that is a symlink is refused', (t) => {
  const dir = repoWithScripts(t);
  const target = path.join(dir, 'skill-target.md');
  fs.writeFileSync(target, 'shared skill\n');
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'ziki'), { recursive: true });

  try {
    fs.symlinkSync(target, path.join(dir, '.claude', 'skills', 'ziki', 'SKILL.md'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('symlink creation is not permitted on this account');
      return;
    }
    throw error;
  }

  const run = runCli(['init', '--apply', '--yes'], { cwd: dir });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing to write "\.claude\/skills\/ziki\/SKILL\.md"/);
  assert.match(run.stderr, /is a symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'shared skill\n');
});

test('a newer schemaVersion plans no agent files either', (t) => {
  const dir = repoWithScripts(t);
  write(dir, 'ziki.json', `${JSON.stringify({ schemaVersion: 2 }, null, 2)}\n`);

  const plan = runCli(['init'], { cwd: dir });
  assert.equal(plan.status, 1);
  assert.equal(plan.stdout.includes('.claude/skills/ziki/SKILL.md'), false,
    'blocked config should not propose agent files');
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});

test('a pre-existing singular .opencode/command file is detected but never written', (t) => {
  const dir = repoWithScripts(t);
  write(dir, '.opencode/command/ziki.md', 'legacy singular placement\n');

  const applied = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(applied.status, 0, applied.stderr);

  assert.equal(
    fs.readFileSync(path.join(dir, '.opencode', 'command', 'ziki.md'), 'utf8'),
    'legacy singular placement\n',
    'the singular directory is read for detection, never written',
  );
  assert.equal(fs.existsSync(path.join(dir, '.opencode', 'commands', 'ziki.md')), true);

  const status = runCli(['status', '--json'], { cwd: dir });
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  const kinds = report.agents.map((agent) => `${agent.kind}:${agent.path}`);
  assert.ok(kinds.includes('opencode-command:.opencode/command/ziki.md'),
    `status should detect the singular placement, got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('opencode-command:.opencode/commands/ziki.md'));
});

test('init for an already-configured repository reports everything unchanged', (t) => {
  const dir = repoWithScripts(t);
  applyFresh(dir);

  const run = runCli(['init', '--apply', '--yes'], { cwd: dir });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Summary: no changes\./);
  assert.match(run.stdout, /No files written\./);
});
