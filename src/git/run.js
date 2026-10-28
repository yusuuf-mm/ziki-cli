import { spawnSync } from 'node:child_process';
import { RuntimeError } from '../errors.js';

/**
 * Read-only git subcommands. Nothing outside this set is ever invoked, so the
 * status path cannot create commits, change refs, or write the worktree.
 *
 * Deliberately excluded: `config` (can write config), `diff` (can invoke
 * external diff/textconv programs), and unused reads such as `for-each-ref`.
 * The review path uses the fixed `runGitDiff` wrapper below instead of
 * accepting arbitrary diff arguments here.
 */
export const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'rev-parse',
  'symbolic-ref',
  'status',
  'rev-list',
  'log',
]);

const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Only these diff shapes are accepted. A caller cannot supply extra flags,
 * pathspecs, or an output path.
 */
const DIFF_MODES = Object.freeze({
  patch: ['--patch', '--unified=0'],
  numstat: ['--numstat', '-z'],
  raw: ['--raw', '-z', '--no-abbrev'],
});

/**
 * Flags that keep diff output stable and prevent repository-controlled
 * programs from running. `--no-ext-diff` and `--no-textconv` are the
 * security-critical pair: without them a repo can execute a configured
 * external diff or textconv command while merely being inspected.
 */
const DIFF_COMMON = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--submodule=short',
  '--diff-algorithm=myers',
  '--ignore-submodules=none',
  '-M',
];

const DIFF_CONFIG = {
  'core.quotePath': 'true',
  'core.fsmonitor': 'false',
};

function configArgs(config) {
  return Object.entries(config).flatMap(([key, value]) => [
    '-c',
    `${key}=${value}`,
  ]);
}

function gitEnv({ scrubDiffEnv = false } = {}) {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
    // Git passes its environment to child Git processes (for example, when
    // status inspects a submodule). Propagate the execution-related
    // overrides there too. Command-line -c still wins for this process.
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'log.showSignature',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'status.submoduleSummary',
    GIT_CONFIG_VALUE_2: 'false',
  };

  if (scrubDiffEnv) {
    // A caller-provided external diff or context override must not leak into
    // the review read. --no-ext-diff is the primary guard; removing the
    // environment makes the intent explicit and protects future code paths.
    delete env.GIT_EXTERNAL_DIFF;
    delete env.GIT_DIFF_OPTS;
  }

  return env;
}

/**
 * Describe a spawn failure without echoing repository data. Exported for the
 * timeout/error-mapping unit tests.
 */
export function describeGitSpawnError(error, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (error && error.code === 'ENOENT') {
    return 'git executable not found on PATH';
  }
  if (error && error.code === 'ETIMEDOUT') {
    return `git timed out after ${timeoutMs / 1000} seconds`;
  }
  if (error && error.code === 'ENOBUFS') {
    return 'git output exceeded the configured size limit';
  }
  return `failed to run git: ${error && error.message ? error.message : 'unknown error'}`;
}

function spawnGit(
  args,
  {
    cwd,
    config = {},
    maxBuffer = DEFAULT_MAX_BUFFER,
    timeoutMs = GIT_TIMEOUT_MS,
    scrubDiffEnv = false,
  } = {},
) {
  const result = spawnSync('git', [...configArgs(config), ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer,
    timeout: timeoutMs,
    env: gitEnv({ scrubDiffEnv }),
  });

  if (result.error) {
    const error = new RuntimeError(
      describeGitSpawnError(result.error, { timeoutMs }),
    );
    error.code = result.error.code;
    throw error;
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Run git without a shell and return stdout, stderr, and the exit status.
 * Never throws for a non-zero git exit; callers decide what it means.
 *
 * `config` entries are internal constants passed as `git -c key=value`; they
 * disable repo-config-driven execution paths such as fsmonitor and signature
 * verification. GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing the
 * index, so the command stays strictly read-only.
 */
export function runGit(args, options = {}) {
  const subcommand = args[0];
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new RuntimeError(
      `internal error: git subcommand "${subcommand}" is not on the read-only allowlist`,
    );
  }

  return spawnGit(args, options);
}

/**
 * Run a fixed, read-only diff. This is the only path that invokes `git diff`
 * or `git diff-files`; callers choose a scope and one of three output modes,
 * never arbitrary flags.
 *
 * Staged changes use `git diff --cached`. Unstaged changes use the plumbing
 * `git diff-files`, which compares the index with the worktree without
 * refreshing it. A normal `git diff` would rewrite stat data in the index
 * even with GIT_OPTIONAL_LOCKS=0.
 */
export function runGitDiff({
  cwd,
  staged = false,
  mode = 'patch',
  maxBytes = DEFAULT_MAX_BUFFER,
  timeoutMs = GIT_TIMEOUT_MS,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(DIFF_MODES, mode)) {
    throw new RuntimeError(`internal error: unknown diff mode "${mode}"`);
  }

  const args = [staged ? 'diff' : 'diff-files'];
  if (staged) {
    args.push('--cached');
  }
  args.push(...DIFF_MODES[mode], ...DIFF_COMMON);

  return spawnGit(args, {
    cwd,
    config: DIFF_CONFIG,
    maxBuffer: maxBytes,
    timeoutMs,
    scrubDiffEnv: true,
  });
}

export const DIFF_OUTPUT_MODES = Object.freeze(Object.keys(DIFF_MODES));
