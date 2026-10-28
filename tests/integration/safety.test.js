import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PACKAGE_ROOT,
  initRepo,
  write,
  git,
  runCli,
  cleanup,
  readPackage,
  tempDir,
} from '../helpers/repo.js';
import { detectChecks } from '../../src/detect/checks.js';
import { READ_ONLY_GIT_SUBCOMMANDS, runGit } from '../../src/git/run.js';
import { getWorktree } from '../../src/git/worktree.js';

function hashTree(root) {
  return [...treeFiles(root)].map(([file, digest]) => `${file}:${digest}`).sort().join('\n');
}

function treeFiles(root) {
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
        const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        files.set(relative, digest);
      }
    }
  }

  walk(root);
  return files;
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(target));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(target);
    }
  }
  return files;
}

test('status does not modify the worktree, HEAD, or refs', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'tracked.txt', 'original\n');
  write(dir, 'untracked.txt', 'loose\n');
  git(dir, ['add', 'tracked.txt']);
  git(dir, ['commit', '-q', '-m', 'add tracked file']);

  // Rewrite identical content so the index stat data is stale. A plain
  // `git status` refreshes the index here; Ziki must leave it byte-identical.
  write(dir, 'tracked.txt', 'original\n');

  const before = {
    tree: hashTree(dir),
    head: git(dir, ['rev-parse', 'HEAD']).stdout,
    refs: git(dir, ['for-each-ref']).stdout,
    index: fs.readFileSync(path.join(dir, '.git', 'index')),
  };

  assert.equal(runCli(['status'], { cwd: dir }).status, 0);
  assert.equal(runCli(['status', '--json'], { cwd: dir }).status, 0);

  const after = {
    tree: hashTree(dir),
    head: git(dir, ['rev-parse', 'HEAD']).stdout,
    refs: git(dir, ['for-each-ref']).stdout,
    index: fs.readFileSync(path.join(dir, '.git', 'index')),
  };

  assert.equal(after.tree, before.tree);
  assert.equal(after.head, before.head);
  assert.equal(after.refs, before.refs);
  assert.deepEqual(after.index, before.index, 'status refreshed the Git index');
});

test('status never prints file contents or secrets', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, '.env', 'ZIKI_FAKE_SECRET=super-secret-value\n');
  write(dir, '.claude/skills/ziki/SKILL.md', 'TOKEN=skill-secret-value\n');
  write(
    dir,
    'package.json',
    JSON.stringify({
      scripts: { test: 'curl https://example.invalid/?token=script-secret-value' },
    }),
  );

  const json = runCli(['status', '--json'], { cwd: dir });
  const human = runCli(['status'], { cwd: dir });

  for (const output of [json.stdout, human.stdout, json.stderr, human.stderr]) {
    assert.equal(output.includes('super-secret-value'), false);
    assert.equal(output.includes('skill-secret-value'), false);
    assert.equal(output.includes('script-secret-value'), false);
  }

  // Paths are reported; contents are not.
  assert.match(json.stdout, /\.claude\/skills\/ziki\/SKILL\.md/);
});

test('the package has no runtime dependencies', () => {
  const pkg = readPackage();
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.devDependencies, undefined);
});

test('source modules do not import network APIs', () => {
  const forbidden = /node:(?:http|https|net|tls|dns)|from ['"](?:undici|node-fetch|axios)['"]/;
  for (const file of listSourceFiles(path.join(PACKAGE_ROOT, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbidden, path.relative(PACKAGE_ROOT, file));
  }
});

test('only the exact read-only git allowlist is accepted', () => {
  assert.deepEqual([...READ_ONLY_GIT_SUBCOMMANDS].sort(), [
    'log',
    'rev-list',
    'rev-parse',
    'status',
    'symbolic-ref',
  ]);

  const rejected = [
    ['commit', '-m', 'nope'],
    ['push'],
    ['reset', '--hard'],
    ['config', 'user.name', 'changed'],
    ['diff'],
    ['for-each-ref'],
  ];

  for (const args of rejected) {
    assert.throws(
      () => runGit(args, { cwd: PACKAGE_ROOT }),
      /read-only allowlist/,
      `git ${args[0]} was not rejected`,
    );
  }
});

test('terminal control characters in commit subjects are escaped', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  const messagePath = path.join(dir, 'message.txt');
  fs.writeFileSync(messagePath, '\u001b[31mPWNED\u0007\n', 'utf8');
  git(dir, ['commit', '-q', '--allow-empty', '-F', messagePath]);
  fs.rmSync(messagePath);

  const human = runCli(['status'], { cwd: dir });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout.includes('\u001b'), false);
  assert.equal(human.stdout.includes('\u0007'), false);
  assert.match(human.stdout, /\\x1b\[31mPWNED\\x07/);

  const json = runCli(['status', '--json'], { cwd: dir });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout.includes('\u001b'), false);
  assert.equal(json.stdout.includes('\u0007'), false);
  assert.equal(
    JSON.parse(json.stdout).repo.lastCommit.subject,
    '\u001b[31mPWNED\u0007',
  );
});

test('repo-configured fsmonitor is not executed by status', (t) => {
  const dir = initRepo();
  const stubDir = tempDir('ziki-fsmon-');
  const marker = path.join(stubDir, 'invoked.txt');

  t.after(() => {
    cleanup(stubDir);
    cleanup(dir);
  });

  const node = process.execPath.replace(/\\/g, '/');
  const command = `"${node}" -e "require('fs').writeFileSync(process.env.ZIKI_FSMONITOR_MARKER,'invoked')"`;

  git(dir, ['config', 'core.fsmonitor', command]);

  const originalMarker = process.env.ZIKI_FSMONITOR_MARKER;
  process.env.ZIKI_FSMONITOR_MARKER = marker;

  t.after(() => {
    if (originalMarker === undefined) {
      delete process.env.ZIKI_FSMONITOR_MARKER;
    } else {
      process.env.ZIKI_FSMONITOR_MARKER = originalMarker;
    }
  });

  // Control: plain `git status` does invoke the configured hook.
  git(dir, ['status', '--porcelain']);
  assert.equal(fs.existsSync(marker), true, 'the fsmonitor stub did not run');

  fs.rmSync(marker);
  const counts = getWorktree(dir);
  assert.equal(fs.existsSync(marker), false, 'status executed the repo fsmonitor');
  assert.equal(counts.clean, true);
});

test('detection modules have no process execution path', () => {
  for (const name of ['agents.js', 'checks.js']) {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'detect', name), 'utf8');
    assert.doesNotMatch(source, /child_process|spawnSync|execFile|execSync/, name);
  }
});

test('stub executables on PATH are never invoked by check detection', (t) => {
  const stubDir = tempDir('ziki-stub-');
  const marker = path.join(stubDir, 'invoked.txt');
  const tripwire = path.join(PACKAGE_ROOT, 'tests', 'fixtures', 'tripwire.cjs')
    .split(path.sep)
    .join('/');

  const names = ['npm', 'flutter', 'go', 'cargo'];
  let source = process.execPath;
  const stubs = names.map((name) => {
    const target = path.join(stubDir, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      fs.linkSync(source, target);
    } catch {
      fs.copyFileSync(source, target);
      source = target;
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(target, 0o755);
    }
    return target;
  });

  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalMarker = process.env.ZIKI_TRIPWIRE;

  process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
  process.env.NODE_OPTIONS = `--require ${tripwire}`;
  process.env.ZIKI_TRIPWIRE = marker;

  t.after(() => {
    process.env.PATH = originalPath;
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }
    if (originalMarker === undefined) {
      delete process.env.ZIKI_TRIPWIRE;
    } else {
      process.env.ZIKI_TRIPWIRE = originalMarker;
    }
    for (const stub of stubs) {
      fs.rmSync(stub, { force: true });
    }
    cleanup(stubDir);
  });

  const dir = tempDir('ziki-manifests-');
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'x', lint: 'x', build: 'x' } }));
  write(dir, 'pubspec.yaml', 'name: x\n');
  write(dir, 'go.mod', 'module x\n');
  write(dir, 'Cargo.toml', '[package]\nname = "x"\n');

  const checks = detectChecks(dir);
  assert.equal(checks.length, 7);
  assert.equal(fs.existsSync(marker), false, 'a detection stub was executed');
});

test('checks are reported as detected but never executed', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));

  const doc = JSON.parse(runCli(['status', '--json'], { cwd: dir }).stdout);
  assert.equal(doc.checks.length, 1);
  assert.equal(doc.checks[0].executed, false);
});

test('init apply writes only the contracted files and leaves everything else untouched', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  write(dir, 'notes.txt', 'keep me\n');

  const before = treeFiles(dir);
  const run = runCli(['init', '--apply', '--yes'], { cwd: dir });
  assert.equal(run.status, 0, run.stderr);

  const after = treeFiles(dir);
  const added = [...after.keys()].filter((file) => !before.has(file));
  // Phase 4: ziki.json plus the three managed agent files.
  assert.deepEqual(added, [
    '.claude/commands/ziki.md',
    '.claude/skills/ziki/SKILL.md',
    '.opencode/commands/ziki.md',
    'ziki.json',
  ]);
  assert.equal(after.size, before.size + 4);

  for (const [file, digest] of before) {
    assert.equal(after.get(file), digest, `${file} changed`);
  }
  assert.equal(
    [...after.keys()].some((file) => file.endsWith('.tmp')),
    false,
    'a temporary file was left behind',
  );
});

test('init plan leaves an existing configuration byte-identical', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));

  assert.equal(runCli(['init', '--apply', '--yes'], { cwd: dir }).status, 0);
  const before = treeFiles(dir);

  assert.equal(runCli(['init'], { cwd: dir }).status, 0);
  assert.equal(runCli(['init', '--plan'], { cwd: dir }).status, 0);

  const after = treeFiles(dir);
  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

test('init planning does not refresh the Git index', (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  write(dir, 'tracked.txt', 'original\n');
  git(dir, ['add', 'tracked.txt']);
  git(dir, ['commit', '-q', '-m', 'add tracked file']);
  write(dir, 'tracked.txt', 'original\n');

  const before = fs.readFileSync(path.join(dir, '.git', 'index'));

  assert.equal(runCli(['init'], { cwd: dir }).status, 0);
  assert.equal(runCli(['init', '--plan'], { cwd: dir }).status, 0);

  assert.deepEqual(
    fs.readFileSync(path.join(dir, '.git', 'index')),
    before,
    'init refreshed the Git index',
  );
});

test('init modules have no direct process or network execution path', () => {
  const modules = [
    'src/commands/init.js',
    'src/config/zikiConfig.js',
    'src/config/reasons.js',
    'src/fs/safeWrite.js',
    'src/report/initHuman.js',
    'src/report/diff.js',
  ];
  const forbidden = /child_process|spawnSync|execFile|execSync|node:(?:http|https|net|tls|dns)/;

  for (const module of modules) {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, module), 'utf8');
    assert.doesNotMatch(source, forbidden, module);
  }
});
