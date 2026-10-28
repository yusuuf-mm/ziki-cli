import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStatus } from './commands/status.js';
import { collectReview } from './commands/review.js';
import {
  applyInitPlan,
  buildInitPlan,
  isConfirmPathSafe,
  normalizeConfirmPath,
} from './commands/init.js';
import { renderHuman } from './report/human.js';
import { renderReviewHuman } from './report/reviewHuman.js';
import { renderJson } from './report/json.js';
import { renderInitPlan, renderInitResult } from './report/initHuman.js';
import { colorEnabled } from './report/color.js';
import { sanitizeText } from './sanitize.js';
import { RuntimeError } from './errors.js';
import { VERSION } from './version.js';

const USAGE = `Usage: ziki <command> [options]

Commands:
  init          Propose ziki.json and the agent skill/command files;
                write only with --apply and approval
  status        Show repository state, detected agents, and verification commands
  review        Inspect staged, unstaged, and untracked changes (read-only)

Global options:
  -h, --help       Show this help
  -v, --version    Print the version
      --debug      Show stack traces for errors

Status options:
      --json       Print the status as JSON

Review options:
      --json       Print the review as JSON

Init options:
      --plan       Print the plan (default; writes nothing)
      --apply      Write the plan after approval
      --yes        Approve without an interactive prompt (requires --apply)
      --confirm <path>  Confirm replacing an existing or changed file (repeatable)
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  debug: { type: 'boolean' },
  plan: { type: 'boolean' },
  apply: { type: 'boolean' },
  yes: { type: 'boolean' },
  confirm: { type: 'string', multiple: true },
};

const COMMAND_OPTIONS = {
  status: new Set(['json']),
  review: new Set(['json']),
  init: new Set(['plan', 'apply', 'yes', 'confirm']),
};

const OPTION_FLAGS = [
  ['json', '--json'],
  ['plan', '--plan'],
  ['apply', '--apply'],
  ['yes', '--yes'],
  ['confirm', '--confirm'],
];

const PACKAGE_ROOT_URL = new URL('../', import.meta.url).href;
const PACKAGE_ROOT_NATIVE = fileURLToPath(new URL('../', import.meta.url)).replace(
  /[\\/]+$/,
  '',
);
const PACKAGE_ROOT_POSIX = PACKAGE_ROOT_NATIVE.split(path.sep).join('/');

/** Keep diagnostics useful without printing absolute paths outside the repo. */
function redactStack(stack) {
  let text = stack;
  for (const [needle, replacement] of [
    [PACKAGE_ROOT_URL, '<ziki>/'],
    [PACKAGE_ROOT_NATIVE, '<ziki>'],
    [PACKAGE_ROOT_POSIX, '<ziki>'],
  ]) {
    text = text.split(needle).join(replacement);
  }
  return text.split('\n').map(sanitizeText).join('\n');
}

function writeUsageError(stderr, message) {
  stderr.write(`ziki: ${sanitizeText(message)}\n\n${USAGE}`);
  return 2;
}

function unsupportedOption(values, command) {
  const allowed = COMMAND_OPTIONS[command];
  for (const [key, flag] of OPTION_FLAGS) {
    if (!allowed.has(key) && values[key] !== undefined) {
      return `${flag} is not supported by "${command}"`;
    }
  }
  return null;
}

function validateConfirmValues(values, plan) {
  const known = new Set(plan.files.map((file) => normalizeConfirmPath(file.path)));

  for (const value of values.confirm ?? []) {
    if (!isConfirmPathSafe(value)) {
      return `--confirm must be a repository-relative path: "${value}"`;
    }
    if (!known.has(normalizeConfirmPath(value))) {
      return `--confirm path "${value}" is not part of this plan`;
    }
  }
  return null;
}

/**
 * Ask one yes/no question on stderr and read stdin. Anything other than an
 * explicit yes is a no; a closed or failed stdin is also a no.
 */
export function askApproval({ stdin, stderr, prompt = 'Apply these changes? [y/N] ' }) {
  return new Promise((resolve) => {
    stderr.write(prompt);

    let buffer = '';
    let settled = false;

    const finish = (approved) => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      if (typeof stdin.pause === 'function') {
        stdin.pause();
      }
      resolve(approved);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.search(/\r?\n/);
      if (newline !== -1) {
        finish(/^y(es)?$/i.test(buffer.slice(0, newline).trim()));
      }
    };

    const onEnd = () => finish(false);
    const onError = () => finish(false);

    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stdin.once('error', onError);
    if (typeof stdin.resume === 'function') {
      stdin.resume();
    }
  });
}

/**
 * CLI entry point. Returns an exit code: 0 success, 1 runtime error,
 * 2 usage error. Never calls process.exit, so callers can test it.
 */
export async function main(
  argv,
  {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    env = process.env,
    isTTY = Boolean(stdout.isTTY),
    stdinIsTTY = Boolean(stdin.isTTY),
  } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return writeUsageError(stderr, error.message);
  }

  const { values, positionals } = parsed;

  if (values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = positionals;
  if (!command) {
    return writeUsageError(stderr, 'missing command');
  }

  if (!Object.prototype.hasOwnProperty.call(COMMAND_OPTIONS, command)) {
    return writeUsageError(stderr, `unknown command "${command}"`);
  }

  if (rest.length > 0) {
    return writeUsageError(stderr, `unexpected argument "${rest[0]}"`);
  }

  const unsupported = unsupportedOption(values, command);
  if (unsupported) {
    return writeUsageError(stderr, unsupported);
  }

  if (command === 'init') {
    if (values.plan && values.apply) {
      return writeUsageError(stderr, '--plan and --apply cannot be used together');
    }
    if (values.yes && !values.apply) {
      return writeUsageError(stderr, '--yes requires --apply');
    }
    if (values.confirm && !values.apply) {
      return writeUsageError(stderr, '--confirm requires --apply');
    }
  }

  const color = colorEnabled({ isTTY, noColor: env.NO_COLOR });

  try {
    if (command === 'status') {
      const report = collectStatus({ cwd });

      if (values.json) {
        stdout.write(renderJson(report));
      } else {
        stdout.write(`${renderHuman(report, { color })}\n`);
      }
      return 0;
    }

    if (command === 'review') {
      const report = collectReview({ cwd });

      if (values.json) {
        stdout.write(renderJson(report));
      } else {
        stdout.write(`${renderReviewHuman(report, { color })}\n`);
      }
      return 0;
    }

    const plan = buildInitPlan({ cwd });

    if (values.confirm) {
      const confirmError = validateConfirmValues(values, plan);
      if (confirmError) {
        return writeUsageError(stderr, confirmError);
      }
    }

    stdout.write(`${renderInitPlan(plan, { color, mode: values.apply ? 'apply' : 'plan' })}\n`);

    if (plan.summary.blocked > 0) {
      throw new RuntimeError(
        'the existing ziki.json uses a newer schemaVersion; upgrade ziki-cli instead of overwriting it',
      );
    }

    if (!values.apply || plan.summary.changed === 0) {
      return 0;
    }

    if (!values.yes) {
      if (!isTTY || !stdinIsTTY) {
        throw new RuntimeError(
          'refusing to apply without approval: pass --yes in a non-interactive shell',
        );
      }
      const approved = await askApproval({ stdin, stderr });
      if (!approved) {
        stdout.write('Aborted. No files written.\n');
        return 1;
      }
    }

    const written = applyInitPlan(plan, { confirm: values.confirm ?? [] });
    stdout.write(`${renderInitResult(written, { color })}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`ziki: ${sanitizeText(message)}\n`);
    if (values.debug && error instanceof Error && error.stack) {
      stderr.write(`${redactStack(error.stack)}\n`);
    }
    return error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
  }
}
