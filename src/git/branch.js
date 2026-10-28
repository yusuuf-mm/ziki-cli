import { runGit } from './run.js';

/**
 * Current branch and HEAD.
 *
 * - Normal branch: branch is the short name, head is a SHA.
 * - Unborn branch: branch is set, head is null.
 * - Detached HEAD: branch is null, detached is true, head is a SHA.
 */
export function getBranchState(cwd) {
  const symbolic = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd });
  const branch = symbolic.status === 0 ? symbolic.stdout.trim() : null;

  const revision = runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  const head = revision.status === 0 ? revision.stdout.trim() : null;

  return {
    branch,
    head,
    detached: branch === null && head !== null,
  };
}
