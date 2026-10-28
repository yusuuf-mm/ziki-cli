const CODES = {
  bold: ['\u001b[1m', '\u001b[22m'],
  dim: ['\u001b[2m', '\u001b[22m'],
  cyan: ['\u001b[36m', '\u001b[39m'],
  yellow: ['\u001b[33m', '\u001b[39m'],
  red: ['\u001b[31m', '\u001b[39m'],
};

/** Color only on a TTY, and never when NO_COLOR is present (any value). */
export function colorEnabled({ isTTY, noColor } = {}) {
  return Boolean(isTTY) && noColor === undefined;
}

export function makeColor(enabled) {
  const wrap = (name) => (text) => {
    if (!enabled) {
      return String(text);
    }
    const [open, close] = CODES[name];
    return `${open}${text}${close}`;
  };

  return {
    bold: wrap('bold'),
    dim: wrap('dim'),
    cyan: wrap('cyan'),
    yellow: wrap('yellow'),
    red: wrap('red'),
  };
}
