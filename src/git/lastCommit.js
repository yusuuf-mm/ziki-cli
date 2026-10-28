import { runGit } from './run.js';

const FORMAT = '%H%x00%h%x00%s%x00%cI';

/** Parse the NUL-separated `git log -1` format used below. */
export function parseLastCommit(text) {
  const line = text.replace(/\r?\n$/, '');
  if (line === '') {
    return null;
  }

  const [sha, shortSha, subject, date] = line.split('\0');
  if (!sha || !shortSha || subject === undefined || !date) {
    return null;
  }

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return {
    sha,
    shortSha,
    subject,
    date: parsed.toISOString(),
  };
}

/** Latest commit on HEAD, or null on an unborn branch. */
export function getLastCommit(cwd) {
  // --no-show-signature keeps repo config from invoking a configured GPG
  // program just to print the subject line.
  const result = runGit(
    ['log', '-1', '--no-show-signature', `--format=${FORMAT}`],
    { cwd },
  );
  if (result.status !== 0) {
    return null;
  }
  return parseLastCommit(result.stdout);
}
