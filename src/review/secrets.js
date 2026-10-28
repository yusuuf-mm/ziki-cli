/**
 * Best-effort secret detection over added lines.
 *
 * Findings contain a repository-relative path, a line number, a scope, and a
 * rule id. Matched text is never stored, returned, printed, or included in an
 * error. This is a warning system, not a security control: false positives and
 * false negatives are both expected.
 */
export const SECRET_RULES = Object.freeze([
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|ABIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/,
  },
  {
    id: 'gitlab-token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/,
  },
  {
    id: 'slack-token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/,
  },
  {
    id: 'stripe-key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/,
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/,
  },
  {
    id: 'openai-api-key',
    pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,255}\b/,
  },
  {
    id: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    id: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  },
  {
    id: 'credential-assignment',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|pwd)\b\s*[:=]\s*["'`]?([^\s"'`]{8,})/i,
  },
]);

const GENERIC_RULE = 'credential-assignment';

const MULTILINE_KEY =
  /\b(?:api[_-]?key|apikey|secret|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|pwd)\b\s*[:=]\s*["'`]?\s*(?:[|>][-+]?)?\s*$/i;

const MULTILINE_VALUE = /^\s*(?:-\s*)?["'`]?([^\s"'`]{8,})/;

const PLACEHOLDER =
  /^(?:process\.env|os\.environ|env\.|import\.meta\.env|\$\{?[A-Z_]|%[A-Z_]+%|<[^>]+>|\{\{[^}]+\}\}|changeme|change[_-]?me|example|your[_-]?(?:key|token|secret|password)|redacted|placeholder|xxx+|\*+|\.{3,})/i;

function isPlaceholder(value) {
  return PLACEHOLDER.test(String(value));
}

/** Rule ids that match one line. The matched text is discarded immediately. */
export function matchSecretRules(line) {
  const ids = new Set();
  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(line);
    if (!match) {
      continue;
    }
    if (rule.id === GENERIC_RULE && isPlaceholder(match[1] ?? '')) {
      continue;
    }
    ids.add(rule.id);
  }
  return [...ids];
}

/**
 * Shared scan budget. One budget spans staged, unstaged, and untracked text so
 * a very large repository cannot make review do unbounded work.
 */
export function createScanBudget({ maxFindings = 200, maxAddedLines = 20_000 } = {}) {
  return {
    maxFindings,
    maxAddedLines,
    findings: [],
    scannedLines: 0,
    longLines: 0,
    findingsTruncated: false,
    exhausted: false,
  };
}

function addFinding(budget, finding) {
  if (budget.findings.length >= budget.maxFindings) {
    budget.findingsTruncated = true;
    return false;
  }
  budget.findings.push(finding);
  return true;
}

/**
 * Scan an ordered list of added lines belonging to one path and scope.
 * `lines` entries are `{ number, text }`.
 *
 * Multiline secrets are detected only when the key is on an added line and
 * the value is on one of the next three added lines. This catches the common
 * YAML/JSON split without pretending to parse every format.
 */
export function scanAddedLines(
  lines,
  {
    path,
    scope,
    budget,
    maxLineLength = 8 * 1024,
  },
) {
  let scanned = 0;
  let longLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (budget.exhausted || budget.findingsTruncated) {
      break;
    }
    if (budget.scannedLines >= budget.maxAddedLines) {
      budget.exhausted = true;
      break;
    }

    const entry = lines[index];
    const text = String(entry.text ?? '');
    const view = text.length > maxLineLength ? text.slice(0, maxLineLength) : text;
    if (text.length > maxLineLength) {
      longLines += 1;
      budget.longLines += 1;
    }

    const ids = matchSecretRules(view);
    const specific = ids.filter((id) => id !== GENERIC_RULE);
    const generic = ids.includes(GENERIC_RULE);
    let lineHasFinding = false;

    // A specific provider pattern is more useful than a generic key match on
    // the same line; report only the specific rule.
    for (const id of specific) {
      if (addFinding(budget, { path, line: entry.number, scope, rule: id })) {
        lineHasFinding = true;
      }
    }
    if (!lineHasFinding && specific.length === 0 && generic) {
      if (addFinding(budget, { path, line: entry.number, scope, rule: GENERIC_RULE })) {
        lineHasFinding = true;
      }
    }

    if (!lineHasFinding && specific.length === 0 && MULTILINE_KEY.test(view)) {
      const lookahead = [];
      for (let cursor = index + 1; cursor < lines.length && cursor <= index + 3; cursor += 1) {
        const candidate = String(lines[cursor].text ?? '');
        if (candidate.trim() === '' || candidate.trim().startsWith('#')) {
          continue;
        }
        const match = MULTILINE_VALUE.exec(candidate);
        if (match && !isPlaceholder(match[1])) {
          lookahead.push({ number: lines[cursor].number, valid: true });
        }
        break;
      }
      if (lookahead.length > 0) {
        addFinding(budget, {
          path,
          line: entry.number,
          scope,
          rule: 'credential-assignment-multiline',
        });
      }
    }

    scanned += 1;
    budget.scannedLines += 1;
  }

  return {
    scanned,
    longLines,
    stopped:
      budget.exhausted ||
      budget.findingsTruncated ||
      scanned < lines.length,
  };
}

/** Match secret rules against one string without retaining the value. */
export function scanText(text, options = {}) {
  const value = String(text);
  const lines =
    value === ''
      ? []
      : value.split('\n').map((line, index) => ({ number: index + 1, text: line }));
  const budget = createScanBudget({
    maxFindings: options.maxFindings,
    maxAddedLines: options.maxAddedLines,
  });
  const result = scanAddedLines(lines, {
    path: options.path ?? '<text>',
    scope: options.scope ?? 'unknown',
    budget,
    maxLineLength: options.maxLineLength,
  });
  return {
    findings: budget.findings,
    scanned: result.scanned,
    longLines: result.longLines,
    truncated: budget.exhausted || budget.findingsTruncated,
  };
}
