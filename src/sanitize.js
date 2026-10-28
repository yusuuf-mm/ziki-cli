const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Make untrusted text safe to print to a terminal.
 *
 * Commit subjects, repository paths, and file names come from the inspected
 * repository and may contain raw escape sequences. Replace every C0, DEL, C1,
 * and Unicode line separator with a visible escape so the output cannot move
 * the cursor, change colors, or inject extra lines.
 */
export function sanitizeText(value) {
  return String(value).replace(CONTROL_CHARS, (char) => {
    const code = char.codePointAt(0);
    if (code > 0xff) {
      return `\\u${code.toString(16).padStart(4, '0')}`;
    }
    return `\\x${code.toString(16).padStart(2, '0')}`;
  });
}
