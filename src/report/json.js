const CONTROL_CHARS = /[\u007f-\u009f]/g;

/**
 * Serialize a status report with a trailing newline.
 *
 * JSON.stringify already escapes C0 controls (including ESC) inside strings.
 * Escaping DEL and C1 here as well keeps the document free of raw terminal
 * control bytes without changing what JSON.parse returns.
 */
export function renderJson(report) {
  const json = JSON.stringify(report, null, 2).replace(CONTROL_CHARS, (char) => {
    const code = char.codePointAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
  return `${json}\n`;
}
