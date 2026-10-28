import { runGit } from './run.js';

/**
 * Parse `git rev-list --left-right --count @{u}...HEAD`.
 * The left count is the upstream side (behind), the right count is HEAD (ahead).
 */
export function parseAheadBehind(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) {
    return { ahead: null, behind: null };
  }

  const [behind, ahead] = parts.map(Number);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    return { ahead: null, behind: null };
  }

  return { ahead, behind };
}

/**
 * Configured upstream and divergence, or null when no upstream exists.
 */
export function getUpstream(cwd) {
  const nameResult = runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { cwd },
  );
  if (nameResult.status !== 0) {
    return null;
  }

  const name = nameResult.stdout.trim();
  if (name === '') {
    return null;
  }

  const counts = runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], { cwd });
  if (counts.status !== 0) {
    return { name, ahead: null, behind: null };
  }

  const { ahead, behind } = parseAheadBehind(counts.stdout);
  return { name, ahead, behind };
}
