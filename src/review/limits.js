/**
 * Hard limits for `ziki review`. They are deliberately conservative: review
 * must stay fast and must not pull an unbounded repository into memory. When
 * one is reached the report says so instead of silently returning partial
 * results.
 */
export const REVIEW_LIMITS = Object.freeze({
  /** Maximum bytes of diff output retained for one raw/numstat/patch read. */
  maxDiffBytes: 8 * 1024 * 1024,
  /** Maximum added lines scanned for secrets across the whole review. */
  maxAddedLines: 20_000,
  /** Maximum characters of one added line inspected for secret patterns. */
  maxLineLength: 8 * 1024,
  /** Maximum secret findings retained. */
  maxFindings: 200,
  /** Maximum untracked files whose contents are read. */
  maxUntrackedFiles: 200,
  /** Maximum bytes read from one untracked file. */
  maxUntrackedFileBytes: 512 * 1024,
  /** Maximum total bytes read from untracked files. */
  maxUntrackedScanBytes: 4 * 1024 * 1024,
  /** Maximum changed-file entries included in the JSON/human detail lists. */
  maxFilesListed: 500,
  /** Maximum directory summaries. */
  maxAreas: 20,
  /** Maximum largest-file entries (FR-18 asks for ten). */
  maxLargest: 10,
});

export const LIMIT_MESSAGES = Object.freeze({
  'diff-bytes': 'a diff exceeded the 8 MiB read limit',
  'added-lines': 'secret scanning stopped at the 20,000 added-line limit',
  'line-length': 'some added lines were longer than 8 KiB and were only partly scanned',
  findings: 'the 200-finding limit was reached; more possible secrets may exist',
  'untracked-files': 'only the first 200 untracked files were read',
  'untracked-bytes': 'an untracked file was larger than 512 KiB and was only partly read',
  'untracked-scan-bytes': 'the 4 MiB untracked-file scan budget was exhausted',
  'file-list': 'the changed-file detail list was capped at 500 entries',
  areas: 'the directory summary was capped at 20 entries',
});

export function limitMessage(code) {
  return LIMIT_MESSAGES[code] ?? code;
}
