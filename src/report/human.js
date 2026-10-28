import { makeColor } from './color.js';
import { sanitizeText } from '../sanitize.js';

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Short, human relative time. Dates in the future read as "just now". */
export function formatRelative(iso, now = Date.now()) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return 'unknown time';
  }

  const minutes = Math.floor(Math.max(0, now - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${plural(minutes, 'minute')} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${plural(hours, 'hour')} ago`;
  }

  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

function branchLine(repo) {
  if (repo.detached) {
    const short = repo.head ? repo.head.slice(0, 7) : 'unknown';
    return `detached at ${sanitizeText(short)}`;
  }
  if (!repo.branch) {
    return 'unknown';
  }

  if (!repo.upstream) {
    return `${sanitizeText(repo.branch)}  (no upstream)`;
  }

  const { name, ahead, behind } = repo.upstream;
  if (ahead === null || behind === null) {
    return `${sanitizeText(repo.branch)}  ->  ${sanitizeText(name)}  (divergence unavailable)`;
  }
  return `${sanitizeText(repo.branch)}  ->  ${sanitizeText(name)}  ahead ${ahead}, behind ${behind}`;
}

function worktreeLine(worktree) {
  if (worktree.clean) {
    return 'clean';
  }

  const parts = [];
  if (worktree.staged > 0) parts.push(`${worktree.staged} staged`);
  if (worktree.modified > 0) parts.push(`${worktree.modified} modified`);
  if (worktree.untracked > 0) parts.push(`${worktree.untracked} untracked`);
  if (worktree.deleted > 0) parts.push(`${worktree.deleted} deleted`);
  if (worktree.renamed > 0) parts.push(`${worktree.renamed} renamed`);
  if (worktree.conflicted > 0) parts.push(`${worktree.conflicted} conflicted`);

  return `${parts.join(' · ')}  (not clean)`;
}

/** Render the human report. `color` must already account for TTY and NO_COLOR. */
export function renderHuman(report, { color = false, now = Date.now() } = {}) {
  const paint = makeColor(color);
  const { repo, worktree, agents, checks } = report;
  const lines = [paint.bold('ziki status')];
  const cwdSuffix =
    repo.cwd === '.' ? '' : ` (cwd: ${sanitizeText(repo.cwd)})`;

  lines.push(`  repo      ${sanitizeText(repo.root)}${cwdSuffix}`);
  lines.push(`  branch    ${branchLine(repo)}`);
  lines.push(`  worktree  ${worktreeLine(worktree)}`);

  if (repo.lastCommit) {
    const commit = repo.lastCommit;
    lines.push(
      `  last      ${sanitizeText(commit.shortSha)}  ${sanitizeText(commit.subject)}  (${formatRelative(commit.date, now)})`,
    );
  } else {
    lines.push('  last      (no commits yet)');
  }

  if (agents.length === 0) {
    lines.push('  agents    (none detected)');
  } else {
    for (const [index, agent] of agents.entries()) {
      const lead = index === 0 ? '  agents    ' : '            ';
      lines.push(
        `${lead}${sanitizeText(agent.kind).padEnd(17)} ${sanitizeText(agent.path)}`,
      );
    }
  }

  if (checks.length === 0) {
    lines.push('  checks    (none detected)');
  } else {
    for (const [index, check] of checks.entries()) {
      const lead = index === 0 ? '  checks    ' : '            ';
      lines.push(
        `${lead}${sanitizeText(check.name).padEnd(9)} ${sanitizeText(check.command).padEnd(24)} (detected, not run)`,
      );
    }
  }

  return lines.join('\n');
}
