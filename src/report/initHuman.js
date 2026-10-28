import { describeFileReason } from '../config/reasons.js';
import { sanitizeText } from '../sanitize.js';
import { makeColor } from './color.js';
import { renderUnifiedDiff } from './diff.js';

function fileLabel(file) {
  if (file.status === 'create') {
    return 'new';
  }
  if (file.status === 'unchanged') {
    return 'unchanged';
  }
  if (file.status === 'blocked') {
    return file.detail
      ? `blocked · ${file.detail} is not supported`
      : `blocked · ${describeFileReason(file.reason)}`;
  }
  return `${file.status} · ${describeFileReason(file.reason)}`;
}

/**
 * One-word type per planned file: `config` for ziki.json, `agent` for the
 * generated skill/command files.
 */
function fileType(file) {
  return file.path === 'ziki.json' ? 'config' : 'agent';
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function summaryLine(summary) {
  const parts = [];
  if (summary.create > 0) parts.push(`${plural(summary.create, 'file')} to create`);
  if (summary.update > 0) parts.push(`${plural(summary.update, 'file')} to update`);
  if (summary.replace > 0) parts.push(`${plural(summary.replace, 'file')} to replace`);
  if (summary.blocked > 0) parts.push(`${plural(summary.blocked, 'file')} blocked`);
  if (parts.length === 0) {
    return 'Summary: no changes.';
  }
  if (summary.unchanged > 0) {
    parts.push(`${summary.unchanged} unchanged`);
  }
  return `Summary: ${parts.join(', ')}.`;
}

function indentContent(text) {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body
    .split('\n')
    .map((line) => `  ${sanitizeText(line)}`)
    .join('\n');
}

function renderFileSection(file) {
  const lines = [];

  if (file.status === 'create' || file.status === 'unchanged' || file.status === 'blocked') {
    if (file.status !== 'create') {
      return lines;
    }
    lines.push(`--- ${sanitizeText(file.path)} (new) ---`);
    lines.push(indentContent(file.desiredText));
    return lines;
  }

  lines.push(`--- ${sanitizeText(file.path)} (${file.status}) ---`);

  const diff =
    file.existingText === null
      ? null
      : renderUnifiedDiff(file.existingText, file.desiredText);

  if (diff === null) {
    lines.push('  (existing contents were not read; the full proposed file follows)');
    lines.push(indentContent(file.desiredText));
    return lines;
  }

  if (diff === '') {
    lines.push('  (contents are semantically identical; only formatting differs)');
    return lines;
  }

  lines.push(diff);
  return lines;
}

export function renderInitPlan(plan, { color = false, mode = 'plan' } = {}) {
  const paint = makeColor(color);
  const lines = [
    paint.bold(mode === 'apply' ? 'ziki init (apply)' : 'ziki init (plan)'),
    `  repo      ${sanitizeText(plan.root)}`,
  ];

  for (const file of plan.files) {
    lines.push(
      `  ${fileType(file).padEnd(10)}${sanitizeText(file.path)}  (${fileLabel(file)})`,
    );
  }

  if (plan.checks.length === 0) {
    lines.push('  checks    (none detected)');
  } else {
    for (const [index, check] of plan.checks.entries()) {
      const lead = index === 0 ? '  checks    ' : '            ';
      lines.push(
        `${lead}${sanitizeText(check.name).padEnd(9)} ${sanitizeText(check.command)}  (${sanitizeText(check.source)})`,
      );
    }
  }

  for (const file of plan.files) {
    const section = renderFileSection(file);
    if (section.length > 0) {
      lines.push('');
      lines.push(...section);
    }
  }

  lines.push('');
  lines.push(summaryLine(plan.summary));

  if (plan.summary.changed === 0) {
    lines.push('No files written.');
  } else if (mode === 'plan') {
    lines.push('No files written. Re-run with --apply to write.');
  }

  return lines.join('\n');
}

export function renderInitResult(written, { color = false } = {}) {
  const paint = makeColor(color);
  const lines = [paint.bold('ziki init (applied)')];

  if (written.length === 0) {
    lines.push('  no files written');
    return lines.join('\n');
  }

  for (const file of written) {
    const verb = file.status === 'create' ? 'created' : 'updated';
    lines.push(
      `  ${verb.padEnd(8)} ${sanitizeText(file.path)}  sha256:${file.sha256.slice(0, 12)}`,
    );
  }
  return lines.join('\n');
}
