import { makeColor } from './color.js';
import { sanitizeText } from '../sanitize.js';
import { LIMIT_MESSAGES } from '../review/limits.js';
import { formatRelative } from './human.js';

const MAX_FILES_PER_SCOPE = 20;
const MAX_FINDINGS = 20;

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function statsText(insertions, deletions) {
  if (typeof insertions !== 'number' || typeof deletions !== 'number') {
    return 'lines unavailable';
  }
  return `+${insertions} -${deletions}`;
}

function branchText(repo) {
  if (repo.detached) {
    return `detached at ${repo.head ? repo.head.slice(0, 7) : 'unknown'}`;
  }
  if (!repo.branch) {
    return 'unknown';
  }
  if (repo.unborn) {
    return `${repo.branch}  (no commits yet)`;
  }
  if (repo.head) {
    return `${repo.branch}  at ${repo.head.slice(0, 7)}`;
  }
  return repo.branch;
}

function scopeSummary(scope) {
  if (!scope.available) {
    return 'unavailable';
  }
  if (scope.filesTotal === 0) {
    return 'none';
  }
  const count = plural(scope.filesTotal, 'file');
  if (scope.statsComplete) {
    return `${count}  ${statsText(scope.insertions, scope.deletions)}`;
  }
  return `${count}  lines unavailable`;
}

function changeLine(file) {
  const status = file.conflicted ? 'conflicted' : file.change;
  let suffix = '';
  if (file.binary === true) {
    suffix = '  (binary)';
  } else if (file.stats === 'unavailable') {
    suffix = '  (stats unavailable)';
  } else {
    suffix = `  ${statsText(file.insertions, file.deletions)}`;
  }

  let renamed = '';
  if (file.oldPath) {
    renamed = `  (from ${sanitizeText(file.oldPath)})`;
  }
  return `${sanitizeText(status).padEnd(12)}${sanitizeText(file.path)}${renamed}${suffix}`;
}

function untrackedLine(file) {
  let suffix;
  if (file.content === 'binary') {
    suffix = '  (binary, not scanned)';
  } else if (file.content === 'scanned') {
    suffix = `  ${statsText(file.insertions ?? 0, 0)}`;
  } else if (file.content === 'not-scanned') {
    suffix = '  (not scanned)';
  } else {
    suffix = '  (details unavailable)';
  }
  return `${sanitizeText(file.path)}${suffix}`;
}

function scopeBlock(lines, label, scope, paint) {
  if (!scope.available) {
    lines.push(`  ${paint.red(label.padEnd(10))}unavailable`);
    if (scope.error) {
      lines.push(`              ${sanitizeText(scope.error)}`);
    }
    return;
  }

  if (scope.files.length === 0) {
    lines.push(`  ${label.padEnd(10)}(none)`);
    return;
  }

  for (const [index, file] of scope.files.slice(0, MAX_FILES_PER_SCOPE).entries()) {
    const lead = index === 0 ? label.padEnd(10) : ''.padEnd(10);
    lines.push(`  ${lead}${changeLine(file)}`);
  }
  if (scope.files.length > MAX_FILES_PER_SCOPE) {
    lines.push(
      `  ${''.padEnd(10)}... ${scope.files.length - MAX_FILES_PER_SCOPE} more (see --json)`,
    );
  }
  if (scope.truncated) {
    lines.push(`  ${''.padEnd(10)}... detail list capped; totals are still counted`);
  }
}

function untrackedBlock(lines, untracked) {
  if (!untracked.available) {
    lines.push(`  ${'untracked'.padEnd(10)}unavailable`);
    if (untracked.error) {
      lines.push(`              ${sanitizeText(untracked.error)}`);
    }
    return;
  }

  if (untracked.files.length === 0) {
    lines.push(`  ${'untracked'.padEnd(10)}(none)`);
    return;
  }

  for (const [index, file] of untracked.files.slice(0, MAX_FILES_PER_SCOPE).entries()) {
    const lead = index === 0 ? 'untracked'.padEnd(10) : ''.padEnd(10);
    lines.push(`  ${lead}${untrackedLine(file)}`);
  }
  if (untracked.files.length > MAX_FILES_PER_SCOPE) {
    lines.push(
      `  ${''.padEnd(10)}... ${untracked.files.length - MAX_FILES_PER_SCOPE} more (see --json)`,
    );
  }
  if (untracked.omitted > 0) {
    lines.push(
      `  ${''.padEnd(10)}... ${untracked.omitted} untracked file${untracked.omitted === 1 ? '' : 's'} not inspected`,
    );
  }
}

function checkLine(check, now) {
  let state;
  if (check.state === 'observed' && check.observed) {
    const observed = check.observed;
    const exit =
      observed.exitCode === null ? '' : `, exit ${observed.exitCode}`;
    state = `observed ${observed.result}${exit}  (recorded in ziki.json ${formatRelative(
      observed.observedAt,
      now,
    )})`;
  } else if (check.state === 'unknown') {
    state = `unknown${check.detail ? `  (${sanitizeText(check.detail)})` : ''}`;
  } else {
    state = 'not run';
  }
  return `${sanitizeText(check.name).padEnd(10)}${sanitizeText(
    check.command,
  ).padEnd(24)}${state}`;
}

/** Render the review report. `color` must already account for TTY and NO_COLOR. */
export function renderReviewHuman(report, { color = false, now = Date.now() } = {}) {
  const paint = makeColor(color);
  const { repo, changes, areas, largest, checks, secrets, limits, warnings } = report;
  const lines = [paint.bold('ziki review')];
  const cwdSuffix =
    repo.cwd === '.' ? '' : ` (cwd: ${sanitizeText(repo.cwd)})`;

  lines.push(`  repo      ${sanitizeText(repo.root)}${cwdSuffix}`);
  lines.push(`  branch    ${sanitizeText(branchText(repo))}`);
  if (!repo.unborn && repo.head) {
    lines.push(`  head      ${sanitizeText(repo.head)}`);
  } else if (repo.unborn) {
    lines.push('  head      (no commits yet)');
  } else {
    lines.push('  head      unknown');
  }

  lines.push(`  staged    ${scopeSummary(changes.staged)}`);
  lines.push(`  unstaged  ${scopeSummary(changes.unstaged)}`);
  lines.push(
    `  untracked ${
      changes.untracked.available
        ? changes.untracked.filesTotal === 0
          ? 'none'
          : `${plural(changes.untracked.filesTotal, 'file')}${
              changes.untracked.insertions === null
                ? '  lines unavailable'
                : `  ${statsText(changes.untracked.insertions, 0)}`
            }`
        : 'unavailable'
    }`,
  );

  if (changes.summary.files === 0) {
    lines.push('  summary   (clean)');
  } else if (changes.summary.files === null) {
    lines.push('  summary   incomplete');
  } else {
    const summary = changes.summary;
    const lineStats =
      summary.insertions === null || summary.deletions === null
        ? 'lines unavailable'
        : statsText(summary.insertions, summary.deletions);
    lines.push(
      `  summary   ${plural(summary.files, 'file')}  ${lineStats}${
        summary.statsComplete ? '' : '  (partial)'
      }`,
    );
  }

  lines.push('');
  lines.push(paint.bold('changed files'));
  scopeBlock(lines, 'staged', changes.staged, paint);
  scopeBlock(lines, 'unstaged', changes.unstaged, paint);
  untrackedBlock(lines, changes.untracked);
  if (
    changes.staged.files.length === 0 &&
    changes.unstaged.files.length === 0 &&
    changes.untracked.files.length === 0 &&
    changes.complete
  ) {
    lines.push('  (no changed files)');
  }

  lines.push('');
  lines.push(paint.bold('areas'));
  if (areas.length === 0) {
    lines.push('  (none)');
  } else {
    for (const area of areas) {
      const stats = area.statsComplete
        ? statsText(area.insertions, area.deletions)
        : 'lines partial';
      lines.push(
        `  ${sanitizeText(area.path).padEnd(24)}${plural(area.files, 'file').padEnd(
          12,
        )}${stats}`,
      );
    }
    if (limits.hit.includes('areas')) {
      lines.push(`  ... more directories not shown (capped at ${limits.maxAreas})`);
    }
  }

  lines.push('');
  lines.push(paint.bold('largest changes'));
  if (largest.length === 0) {
    lines.push('  (none with known line counts)');
  } else {
    for (const file of largest) {
      lines.push(
        `  ${sanitizeText(file.path).padEnd(40)}${sanitizeText(file.scope).padEnd(
          10,
        )}${statsText(file.insertions, file.deletions)}`,
      );
    }
  }

  lines.push('');
  lines.push(paint.bold('checks'));
  if (checks.detail) {
    lines.push(`  ${paint.dim(sanitizeText(checks.detail))}`);
  }
  lines.push(`  source    ${sanitizeText(checks.source)}`);
  if (checks.items.length === 0) {
    lines.push('  (none configured or detected)');
  } else {
    for (const check of checks.items) {
      const origin = check.origin === 'ziki.json' ? '' : '  (detected)';
      lines.push(`  ${checkLine(check, now)}${origin}`);
    }
  }

  lines.push('');
  lines.push(paint.bold('secrets'));
  const scanned = secrets.scanned.totalLines;
  const findingCount = secrets.findings.length;
  const patternText =
    findingCount === 0 ? 'no patterns found' : `${plural(findingCount, 'pattern')} found`;
  if (secrets.state === 'scanned') {
    lines.push(`  ${plural(scanned, 'added line')} scanned; ${patternText}`);
  } else if (secrets.state === 'partial') {
    lines.push(
      `  ${plural(scanned, 'added line')} scanned; results are incomplete; ${patternText}`,
    );
  } else {
    lines.push('  not scanned');
  }
  if (secrets.findings.length > 0) {
    for (const finding of secrets.findings.slice(0, MAX_FINDINGS)) {
      lines.push(
        `  ! ${sanitizeText(finding.path)}:${finding.line}  [${sanitizeText(
          finding.scope,
        )}]  ${sanitizeText(finding.rule)}`,
      );
    }
    if (secrets.findings.length > MAX_FINDINGS) {
      lines.push(
        `  ... ${secrets.findings.length - MAX_FINDINGS} more finding${
          secrets.findings.length - MAX_FINDINGS === 1 ? '' : 's'
        } (see --json)`,
      );
    }
  }
  for (const reason of secrets.reasons) {
    lines.push(`  - ${sanitizeText(reason)}`);
  }

  if (limits.hit.length > 0) {
    lines.push('');
    lines.push(paint.bold('limits hit'));
    for (const code of limits.hit) {
      lines.push(
        `  - ${sanitizeText(LIMIT_MESSAGES[code] ?? code)}`,
      );
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push(paint.bold('warnings'));
    for (const warning of warnings) {
      lines.push(
        `  - ${paint.yellow(sanitizeText(warning.code))}: ${sanitizeText(
          warning.message,
        )}`,
      );
    }
  }

  lines.push('');
  lines.push(
    paint.dim('read-only: no files were written and no project commands were run'),
  );

  return lines.join('\n');
}
