import fs from 'node:fs';
import path from 'node:path';

const NODE_SCRIPTS = [
  ['test', 'npm test'],
  ['lint', 'npm run lint'],
  ['typecheck', 'npm run typecheck'],
  ['build', 'npm run build'],
];

// A status read should never pull an unbounded file into memory. Real
// package manifests are far below this; larger ones are skipped as unreadable.
const MAX_MANIFEST_BYTES = 1024 * 1024;

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function readManifest(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
      return null;
    }
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function nodeChecks(root) {
  const manifest = readManifest(path.join(root, 'package.json'));
  if (manifest === null) {
    return [];
  }

  const scripts =
    manifest && typeof manifest === 'object' && manifest.scripts && typeof manifest.scripts === 'object'
      ? manifest.scripts
      : {};

  return NODE_SCRIPTS.filter(
    ([name]) => typeof scripts[name] === 'string' && scripts[name].trim() !== '',
  ).map(([name, command]) => ({
    name,
    command,
    source: `package.json#scripts.${name}`,
    executed: false,
  }));
}

/**
 * Detect verification commands from manifests. Suggestions only: nothing here
 * executes a command, imports a process runner, or reads a script body.
 */
export function detectChecks(root) {
  const checks = [...nodeChecks(root)];

  if (isFile(path.join(root, 'pubspec.yaml'))) {
    checks.push({
      name: 'test',
      command: 'flutter test',
      source: 'pubspec.yaml',
      executed: false,
    });
    checks.push({
      name: 'analyze',
      command: 'flutter analyze',
      source: 'pubspec.yaml',
      executed: false,
    });
  }

  if (isFile(path.join(root, 'go.mod'))) {
    checks.push({
      name: 'test',
      command: 'go test ./...',
      source: 'go.mod',
      executed: false,
    });
  }

  if (isFile(path.join(root, 'Cargo.toml'))) {
    checks.push({
      name: 'test',
      command: 'cargo test',
      source: 'Cargo.toml',
      executed: false,
    });
  }

  return checks;
}
