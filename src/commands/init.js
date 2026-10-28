import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRepoRoot } from '../git/root.js';
import { detectChecks } from '../detect/checks.js';
import { RuntimeError } from '../errors.js';
import {
  CONFIG_FILENAME,
  MAX_CONFIG_BYTES,
  bodyEquals,
  buildConfig,
  readConfigFile,
  serializeConfig,
} from '../config/zikiConfig.js';
import { describeFileReason } from '../config/reasons.js';
import { AGENT_TEMPLATES } from '../templates/agentFiles.js';
import {
  assertWritableTarget,
  atomicWriteFile,
  resolveRepoPath,
} from '../fs/safeWrite.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decide what init would do with the current file. No filesystem access: the
 * caller supplies the parsed existing file and the desired document.
 */
export function classifyConfigFile(existing, desiredDoc) {
  switch (existing.kind) {
    case 'absent':
      return { status: 'create', reason: null, requiresConfirmation: false };

    case 'valid': {
      const sameBody = bodyEquals(existing.doc, desiredDoc);

      if (sameBody && existing.integrityValid) {
        return { status: 'unchanged', reason: null, requiresConfirmation: false };
      }
      if (sameBody && !existing.hasIntegrity) {
        return {
          status: 'update',
          reason: 'integrity-missing',
          requiresConfirmation: true,
        };
      }
      if (sameBody) {
        return {
          status: 'update',
          reason: 'integrity-mismatch',
          requiresConfirmation: true,
        };
      }
      if (!existing.hasIntegrity) {
        return {
          status: 'update',
          reason: 'unverified',
          requiresConfirmation: true,
        };
      }
      return {
        status: 'update',
        reason: existing.integrityValid ? 'generated' : 'modified-since-recorded',
        requiresConfirmation: true,
      };
    }

    case 'unsupported-version':
      return {
        status: 'blocked',
        reason: 'unsupported-version',
        requiresConfirmation: false,
        detail: `schemaVersion ${existing.version}`,
      };

    case 'invalid-json':
    case 'invalid-schema':
    case 'too-large':
    case 'read-error':
      return {
        status: 'replace',
        reason: existing.kind,
        requiresConfirmation: true,
      };

    default:
      return {
        status: 'replace',
        reason: 'unmanaged',
        requiresConfirmation: true,
      };
  }
}

/**
 * Read a plain-text agent template target with the same safety kinds the
 * config reader uses, without interpreting the contents. A byte-order mark is
 * stripped so planned text compares cleanly against the templates.
 */
function readTextTarget(absolutePath) {
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'read-error' };
  }

  if (stat.isSymbolicLink()) {
    return { kind: 'symlink' };
  }
  if (stat.isDirectory()) {
    return { kind: 'directory' };
  }
  if (!stat.isFile()) {
    return { kind: 'not-file' };
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    return { kind: 'too-large', size: stat.size };
  }

  let text;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return { kind: 'read-error' };
  }

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return { kind: 'file', text };
}

/**
 * Classify an agent template target against its desired text. `recordedHash`
 * is the managedFiles entry from the existing ziki.json (`sha256:<64 hex>`)
 * or null when there is none. A file that still matches its recorded hash but
 * no longer matches the template means this version's template moved ahead of
 * the last write; the label reads as "update · changed".
 */
export function classifyAgentFile(existing, desiredText, recordedHash = null) {
  switch (existing.kind) {
    case 'absent':
      return { status: 'create', reason: null, requiresConfirmation: false };

    case 'file': {
      if (existing.text === desiredText) {
        return { status: 'unchanged', reason: null, requiresConfirmation: false };
      }

      if (
        typeof recordedHash === 'string' &&
        recordedHash.startsWith('sha256:')
      ) {
        const digest = digestConfigText(existing.text);
        if (digest === recordedHash.slice('sha256:'.length)) {
          return { status: 'update', reason: 'generated', requiresConfirmation: true };
        }
        return {
          status: 'update',
          reason: 'modified-since-recorded',
          requiresConfirmation: true,
        };
      }

      return { status: 'update', reason: 'unverified', requiresConfirmation: true };
    }

    case 'too-large':
    case 'read-error':
      return { status: 'replace', reason: existing.kind, requiresConfirmation: true };

    default:
      // symlink/directory/not-file are refused before planning.
      return { status: 'replace', reason: 'unmanaged', requiresConfirmation: true };
  }
}

/**
 * Plan the agent skill/command files (PRD FR-21 to FR-23). Unsafe targets —
 * symlink, directory, other non-files — are refused before any planning,
 * exactly like ziki.json targets.
 */
function planAgentFiles(root, recorded) {
  const files = [];

  for (const template of AGENT_TEMPLATES) {
    const absolutePath = resolveRepoPath(root, template.path);
    const target = readTextTarget(absolutePath);

    if (
      target.kind === 'symlink' ||
      target.kind === 'directory' ||
      target.kind === 'not-file'
    ) {
      throw new RuntimeError(
        `refusing to write "${template.path}": ${describeFileReason(target.kind)}; remove or replace it first`,
      );
    }

    assertWritableTarget(root, absolutePath, template.path);

    const classified = classifyAgentFile(
      target,
      template.content,
      recorded && isPlainObject(recorded) ? recorded[template.path] ?? null : null,
    );

    files.push({
      path: template.path,
      absolutePath,
      status: classified.status,
      reason: classified.reason,
      detail: null,
      requiresConfirmation: classified.requiresConfirmation,
      existingText: typeof target.text === 'string' ? target.text : null,
      existingExists: target.kind !== 'absent',
      existingDigest:
        typeof target.text === 'string' ? digestConfigText(target.text) : null,
      desiredText: template.content,
    });
  }

  return files;
}

function summarize(files) {
  const summary = { create: 0, update: 0, replace: 0, blocked: 0, unchanged: 0, changed: 0 };
  for (const file of files) {
    summary[file.status] += 1;
    if (file.status !== 'unchanged') {
      summary.changed += 1;
    }
  }
  return summary;
}

function digestConfigText(text) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Snapshot the target immediately before writing. This is a second read after
 * the plan so a concurrent edit cannot be overwritten under stale approval.
 */
function snapshotTarget(absolutePath) {
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false };
    }
    return { exists: true, digest: null };
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { exists: true, digest: null };
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    return { exists: true, digest: 'oversized' };
  }

  try {
    return {
      exists: true,
      digest: digestConfigText(fs.readFileSync(absolutePath, 'utf8')),
    };
  } catch {
    return { exists: true, digest: null };
  }
}

function assertPlanStillCurrent(file) {
  const current = snapshotTarget(file.absolutePath);

  if (!file.existingExists) {
    if (current.exists) {
      throw new RuntimeError(
        `"${file.path}" appeared after the plan was generated; re-run ziki init`,
      );
    }
    return;
  }

  if (!current.exists) {
    throw new RuntimeError(
      `"${file.path}" disappeared after the plan was generated; re-run ziki init`,
    );
  }

  // A file that was unreadable at plan time has no baseline. Replacing it
  // already required explicit per-file confirmation.
  if (file.existingDigest === null) {
    return;
  }

  if (current.digest !== file.existingDigest) {
    throw new RuntimeError(
      `"${file.path}" changed after the plan was generated; re-run ziki init`,
    );
  }
}

/**
 * Build a plan without writing anything. The plan proposes `ziki.json` plus
 * the agent skill/command files (PRD FR-21 to FR-23). Every agent file keeps
 * its hash in `managedFiles`, so the next run can tell "this is what ziki
 * init wrote" from "something else changed this file".
 */
export function buildInitPlan({ cwd }) {
  const root = getRepoRoot(cwd);
  if (!root) {
    throw new RuntimeError(`not a git repository (or any parent): ${cwd}`);
  }

  const absolutePath = resolveRepoPath(root, CONFIG_FILENAME);
  const existing = readConfigFile(absolutePath);

  if (existing.kind === 'symlink' || existing.kind === 'directory' || existing.kind === 'not-file') {
    const what =
      existing.kind === 'symlink'
        ? 'it is a symlink'
        : existing.kind === 'directory'
          ? 'it is a directory'
          : 'it is not a regular file';
    throw new RuntimeError(
      `refusing to write "${CONFIG_FILENAME}": ${what}; remove or replace it first`,
    );
  }

  assertWritableTarget(root, absolutePath, CONFIG_FILENAME);

  const checks = detectChecks(root).map(({ name, command, source }) => ({
    name,
    command,
    source,
  }));

  const existingDoc = existing.kind === 'valid' ? existing.doc : null;
  const recorded =
    existingDoc && isPlainObject(existingDoc.managedFiles)
      ? existingDoc.managedFiles
      : null;

  // Agent files are proposed only when the configuration itself is plannable.
  // A newer schemaVersion means a newer ziki-cli owns the setup; proposing
  // this version's file set against it could contradict that version's
  // choices, and its managedFiles hashes could never be recorded.
  let agentFiles = [];
  if (existing.kind !== 'unsupported-version') {
    agentFiles = planAgentFiles(root, recorded);
  }

  // The managed-files map keeps every foreign entry the existing document
  // carried, then pins each template path to the digest of the content this
  // run would write. Recording happens even for unchanged files, so the map
  // always describes what is on disk after a successful apply.
  const managedFiles = Object.create(null);
  if (recorded) {
    for (const [key, value] of Object.entries(recorded)) {
      managedFiles[key] = value;
    }
  }
  for (const file of agentFiles) {
    managedFiles[file.path] = `sha256:${digestConfigText(file.desiredText)}`;
  }

  const desiredDoc = buildConfig({
    checks,
    existing: existingDoc,
    managedFiles,
  });
  const desiredText = serializeConfig(desiredDoc);
  const classified = classifyConfigFile(existing, desiredDoc);

  const files = [
    {
      path: CONFIG_FILENAME,
      absolutePath,
      status: classified.status,
      reason: classified.reason,
      detail: classified.detail ?? null,
      requiresConfirmation: classified.requiresConfirmation,
      existingText: existing.text ?? null,
      existingExists: existing.kind !== 'absent',
      existingDigest:
        typeof existing.text === 'string' ? digestConfigText(existing.text) : null,
      desiredText,
    },
    ...agentFiles,
  ];

  return {
    root,
    files,
    checks,
    summary: summarize(files),
  };
}

/** Accept `./ziki.json` and `.\ziki.json` as the same plan path. */
export function normalizeConfirmPath(value) {
  const normalized = path.normalize(value).split(path.sep).join('/');
  const withoutDot = normalized.startsWith('./') ? normalized.slice(2) : normalized;
  return process.platform === 'win32' ? withoutDot.toLowerCase() : withoutDot;
}

export function isConfirmPathSafe(value) {
  if (typeof value !== 'string' || value === '' || path.isAbsolute(value)) {
    return false;
  }
  const normalized = normalizeConfirmPath(value);
  return normalized !== '..' && !normalized.startsWith('../');
}

/**
 * Create every missing ancestor directory of a planned target. Paths come
 * from the plan (repository-relative, already validated), so the directories
 * stay inside the repository. `atomicWriteFile` needs the parent to exist.
 */
function ensureWritableDirectories(root, relativePath) {
  const target = path.join(root, ...relativePath.split('/'));
  const directory = path.dirname(target);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    throw new RuntimeError(
      `cannot create the directory for "${relativePath}": ${
        error && error.message ? error.message : 'unknown error'
      }`,
    );
  }
}

/**
 * Validate the confirmations and write every changed file. Nothing is written
 * when any confirmation is missing or any target fails its safety preflight.
 */
export function applyInitPlan(plan, { confirm = [] } = {}) {
  if (plan.summary.blocked > 0) {
    throw new RuntimeError(
      'the existing ziki.json uses a newer schemaVersion; upgrade ziki-cli instead of overwriting it',
    );
  }

  const confirmed = new Set(confirm.map(normalizeConfirmPath));
  const changed = plan.files.filter((file) => file.status !== 'unchanged');
  const missing = changed.filter(
    (file) =>
      file.requiresConfirmation && !confirmed.has(normalizeConfirmPath(file.path)),
  );

  if (missing.length > 0) {
    const names = missing
      .map((file) => `"${file.path}" (${describeFileReason(file.reason)})`)
      .join(', ');
    const flags = missing.map((file) => `--confirm ${file.path}`).join(' ');
    throw new RuntimeError(
      `refusing to overwrite ${names} without confirmation; re-run with ${flags}`,
    );
  }

  for (const file of changed) {
    assertWritableTarget(plan.root, file.absolutePath, file.path);
    assertPlanStillCurrent(file);
  }

  // Agent files first, ziki.json last: the config records the agent files'
  // hashes, so a crash between the two leaves a repository where the next
  // init either sees matching hashes or repairs the difference with a normal
  // per-file confirmation.
  const writeOrder = [
    ...changed.filter((file) => file.path !== CONFIG_FILENAME),
    ...changed.filter((file) => file.path === CONFIG_FILENAME),
  ];

  const written = [];
  for (const file of writeOrder) {
    ensureWritableDirectories(plan.root, file.path);
    const result = atomicWriteFile(file.absolutePath, file.desiredText, {
      displayPath: file.path,
    });
    written.push({
      path: file.path,
      status: file.status,
      sha256: result.sha256,
    });
  }
  return written;
}
