import crypto from 'node:crypto';
import fs from 'node:fs';

export const CONFIG_FILENAME = 'ziki.json';
export const CONFIG_SCHEMA_VERSION = 1;
export const INTEGRITY_ALGORITHM = 'sha256';
export const MAX_CONFIG_BYTES = 1024 * 1024;

const KNOWN_KEYS = new Set([
  'schemaVersion',
  'checks',
  'lastObserved',
  'managedFiles',
  'integrity',
]);

// Written order. Unknown keys are emitted after these, sorted, and integrity
// always comes last so a diff shows the recorded hash as the final line.
const DISPLAY_ORDER = ['schemaVersion', 'checks', 'lastObserved', 'managedFiles'];

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MANAGED_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic JSON with object keys sorted at every depth. */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutIntegrity(doc) {
  const body = { ...doc };
  delete body.integrity;
  return body;
}

/**
 * The integrity hash covers the document with the `integrity` field removed.
 * It is stored inside the same file and is not a signature: it detects edits
 * made outside Ziki, it does not prove who made them.
 */
export function computeIntegrity(doc) {
  return {
    algorithm: INTEGRITY_ALGORITHM,
    hash: crypto
      .createHash(INTEGRITY_ALGORITHM)
      .update(canonicalJson(withoutIntegrity(doc)), 'utf8')
      .digest('hex'),
  };
}

export function verifyIntegrity(doc) {
  if (!isPlainObject(doc) || !isPlainObject(doc.integrity)) {
    return false;
  }
  if (doc.integrity.algorithm !== INTEGRITY_ALGORITHM) {
    return false;
  }
  if (typeof doc.integrity.hash !== 'string' || !HASH_PATTERN.test(doc.integrity.hash)) {
    return false;
  }

  const expected = computeIntegrity(doc);
  const actual = Buffer.from(doc.integrity.hash, 'hex');
  const wanted = Buffer.from(expected.hash, 'hex');
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}

export function bodyEquals(left, right) {
  return canonicalJson(withoutIntegrity(left)) === canonicalJson(withoutIntegrity(right));
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) {
    return null;
  }

  const normalized = [];
  for (const check of checks) {
    if (!isPlainObject(check)) {
      return null;
    }
    if (typeof check.name !== 'string' || check.name.trim() === '') {
      return null;
    }
    if (typeof check.command !== 'string' || check.command.trim() === '') {
      return null;
    }
    if (typeof check.source !== 'string' || check.source.trim() === '') {
      return null;
    }
    normalized.push({
      name: check.name,
      command: check.command,
      source: check.source,
    });
  }
  return normalized;
}

/**
 * Build the next config document. `existing` is only used for fields this
 * version does not own: unknown top-level keys and `managedFiles` survive a
 * rerun untouched. Checks are always regenerated from the project manifests.
 *
 * `managedFiles`, when given, replaces the managed-files map outright: init
 * passes the map it computed for the agent files it is about to write, with
 * any foreign entries the existing document already carried. Callers that
 * omit it keep the rerun-preserving behavior above.
 */
export function buildConfig({ checks, existing = null, managedFiles = null }) {
  // A null prototype keeps a literal "__proto__" key as data instead of
  // mutating the object's prototype and losing the field on the next write.
  const doc = Object.create(null);
  doc.schemaVersion = CONFIG_SCHEMA_VERSION;
  doc.checks = normalizeChecks(checks) ?? [];

  if (existing) {
    for (const key of Object.keys(existing).sort()) {
      if (!KNOWN_KEYS.has(key)) {
        doc[key] = existing[key];
      }
    }
  }

  // `lastObserved` is written by an explicit record step, not by init. Init
  // preserves it verbatim and includes it in the integrity hash; it never
  // interprets an observation as a check that Ziki ran.
  if (existing && Object.prototype.hasOwnProperty.call(existing, 'lastObserved')) {
    doc.lastObserved = existing.lastObserved;
  }

  doc.managedFiles =
    managedFiles && isPlainObject(managedFiles)
      ? managedFiles
      : existing && isPlainObject(existing.managedFiles)
        ? existing.managedFiles
        : {};

  return doc;
}

export function serializeConfig(doc) {
  const ordered = Object.create(null);
  for (const key of DISPLAY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(doc, key)) {
      ordered[key] = doc[key];
    }
  }
  for (const key of Object.keys(doc).sort()) {
    if (!KNOWN_KEYS.has(key)) {
      ordered[key] = doc[key];
    }
  }
  ordered.integrity = computeIntegrity(doc);
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Parse ziki.json text. Returns a `kind` instead of throwing so the planner can
 * explain why a file needs confirmation or cannot be replaced safely.
 */
export function parseConfigText(text) {
  let value;
  try {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    value = JSON.parse(withoutBom);
  } catch {
    return { kind: 'invalid-json' };
  }

  if (!isPlainObject(value) || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) {
    return { kind: 'not-config' };
  }

  if (value.schemaVersion > CONFIG_SCHEMA_VERSION) {
    return { kind: 'unsupported-version', version: value.schemaVersion };
  }

  if (value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    return { kind: 'not-config' };
  }

  if (normalizeChecks(value.checks) === null) {
    return { kind: 'invalid-schema', field: 'checks' };
  }

  if (value.managedFiles !== undefined) {
    if (!isPlainObject(value.managedFiles)) {
      return { kind: 'invalid-schema', field: 'managedFiles' };
    }
    for (const hash of Object.values(value.managedFiles)) {
      if (typeof hash !== 'string' || !MANAGED_HASH_PATTERN.test(hash)) {
        return { kind: 'invalid-schema', field: 'managedFiles' };
      }
    }
  }

  if (value.integrity !== undefined) {
    if (
      !isPlainObject(value.integrity) ||
      value.integrity.algorithm !== INTEGRITY_ALGORITHM ||
      typeof value.integrity.hash !== 'string' ||
      !HASH_PATTERN.test(value.integrity.hash)
    ) {
      return { kind: 'invalid-schema', field: 'integrity' };
    }
  }

  return {
    kind: 'valid',
    doc: value,
    hasIntegrity: value.integrity !== undefined,
    integrityValid: value.integrity !== undefined && verifyIntegrity(value),
  };
}

/** Read a config path without following symlinks or reading unbounded data. */
export function readConfigFile(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
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
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return { kind: 'read-error' };
  }

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return { ...parseConfigText(text), text };
}
