import path from 'node:path';
import { runGit } from './run.js';

/**
 * Absolute repository root, or null when cwd is not inside a Git repository.
 */
export function getRepoRoot(cwd) {
  const result = runGit(['rev-parse', '--show-toplevel'], { cwd });
  if (result.status !== 0) {
    return null;
  }

  // Strip only the line terminator: a POSIX path may legitimately end in a
  // space, and trim() would silently corrupt it.
  const root = result.stdout.replace(/\r?\n$/, '');
  if (root === '') {
    return null;
  }
  return path.resolve(root);
}
