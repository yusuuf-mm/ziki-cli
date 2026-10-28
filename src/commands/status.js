import fs from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '../git/root.js';
import { getBranchState } from '../git/branch.js';
import { getUpstream } from '../git/upstream.js';
import { getWorktree } from '../git/worktree.js';
import { getLastCommit } from '../git/lastCommit.js';
import { detectAgents } from '../detect/agents.js';
import { detectChecks } from '../detect/checks.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { RuntimeError } from '../errors.js';

function realCwd(cwd) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function relativeCwd(root, cwd) {
  const relative = path.relative(root, realCwd(cwd));
  if (relative === '') {
    return '.';
  }
  return relative.split(path.sep).join('/');
}

/**
 * Collect a status report. Read-only: the only subprocesses are allowlisted
 * git reads, and the only writes are to stdout by the caller.
 */
export function collectStatus({ cwd, now = new Date() }) {
  const root = getRepoRoot(cwd);
  if (!root) {
    throw new RuntimeError(`not a git repository (or any parent): ${cwd}`);
  }

  // Run every git read from the root so a subdirectory invocation still sees
  // the whole repository and a single, canonical working context.
  const { branch, head, detached } = getBranchState(root);
  const upstream = getUpstream(root);
  const worktree = getWorktree(root);
  const lastCommit = getLastCommit(root);
  const agents = detectAgents(root);
  const checks = detectChecks(root);

  return {
    schemaVersion: 1,
    tool: {
      name: PACKAGE_NAME,
      version: VERSION,
    },
    generatedAt: now.toISOString(),
    repo: {
      root,
      cwd: relativeCwd(root, cwd),
      isGitRepo: true,
      branch,
      detached,
      head,
      upstream,
      lastCommit,
    },
    worktree,
    agents,
    checks,
  };
}
