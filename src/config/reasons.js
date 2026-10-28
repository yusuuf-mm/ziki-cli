const REASON_LABELS = {
  generated: 'changed',
  'modified-since-recorded': 'modified since last write',
  'integrity-mismatch': 'integrity mismatch',
  'integrity-missing': 'no recorded integrity',
  unverified: 'not written by ziki init',
  'invalid-json': 'not valid JSON',
  'invalid-schema': 'invalid structure',
  unmanaged: 'not a Ziki configuration',
  'unsupported-version': 'newer schemaVersion',
  'too-large': 'larger than 1 MiB',
  'read-error': 'could not be read',
  symlink: 'is a symlink',
  directory: 'is a directory',
  'not-file': 'is not a regular file',
};

/** Short, stable wording shared by the plan and refusal messages. */
export function describeFileReason(reason) {
  return REASON_LABELS[reason] ?? String(reason ?? 'unknown');
}
