import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BIN = path.resolve(HERE, '../../bin/ziki.js');
export const PACKAGE_ROOT = path.resolve(HERE, '../..');

/** Create a unique temporary directory. */
export function tempDir(prefix = 'ziki-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Run git in a fixture directory. Throws unless allowFailure is set. */
export function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result;
}

/** Create a committed repository in a fresh temporary directory. */
export function initRepo({ branch = 'main', commit = true } = {}) {
  const dir = tempDir();
  git(dir, ['init', '-q', '-b', branch]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Ziki Test']);
  if (commit) {
    fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'initial commit']);
  }
  return dir;
}

/** Write a file relative to dir, creating parent directories. */
export function write(dir, rel, content = '') {
  const target = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** Invoke the CLI with the current Node binary. */
export function runCli(args, { cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Remove a fixture directory. */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Read the package manifest once for assertions. */
export function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
}
