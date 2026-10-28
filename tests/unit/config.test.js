import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_SCHEMA_VERSION,
  buildConfig,
  canonicalJson,
  computeIntegrity,
  parseConfigText,
  readConfigFile,
  serializeConfig,
  verifyIntegrity,
} from '../../src/config/zikiConfig.js';

const CHECKS = [
  {
    name: 'test',
    command: 'npm test',
    source: 'package.json#scripts.test',
  },
];

function roundTrip(doc) {
  return parseConfigText(serializeConfig(doc));
}

test('canonicalJson sorts keys at every depth', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }),
    '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
  );
});

test('buildConfig records checks and starts without managed files', () => {
  const doc = buildConfig({ checks: CHECKS });

  // buildConfig uses a null prototype so a literal "__proto__" key stays data;
  // compare the values, not the prototype.
  assert.deepEqual({ ...doc }, {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    checks: CHECKS,
    managedFiles: {},
  });
});

test('buildConfig preserves unknown fields and managed hashes', () => {
  const existing = {
    schemaVersion: 1,
    checks: [],
    managedFiles: {
      '.claude/skills/ziki/SKILL.md': `sha256:${'a'.repeat(64)}`,
    },
    team: 'neo',
    nested: { b: 1, a: 2 },
    integrity: { algorithm: 'sha256', hash: 'b'.repeat(64) },
  };

  const doc = buildConfig({ checks: CHECKS, existing });

  assert.deepEqual(doc.checks, CHECKS);
  assert.deepEqual(doc.managedFiles, existing.managedFiles);
  assert.equal(doc.team, 'neo');
  assert.deepEqual(doc.nested, { b: 1, a: 2 });
  assert.equal(doc.integrity, undefined);
});

test('buildConfig keeps a literal __proto__ key as data', () => {
  const existing = JSON.parse(
    '{"schemaVersion":1,"checks":[],"managedFiles":{},"__proto__":{"polluted":true}}',
  );

  const doc = buildConfig({ checks: CHECKS, existing });

  assert.equal(Object.getPrototypeOf(doc), null);
  assert.deepEqual(doc.__proto__, { polluted: true });
  assert.equal(Object.prototype.polluted, undefined);

  const parsed = parseConfigText(serializeConfig(doc));
  assert.equal(parsed.kind, 'valid');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.doc, '__proto__'), true);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(parsed.doc, '__proto__').value,
    { polluted: true },
  );
});

test('serializeConfig is deterministic and ends with one newline', () => {
  const first = serializeConfig(buildConfig({ checks: CHECKS }));
  const second = serializeConfig(buildConfig({ checks: CHECKS }));

  assert.equal(first, second);
  assert.match(first, /^\{\n/);
  assert.match(first, /\n$/);
  assert.equal(first.endsWith('\n\n'), false);
});

test('integrity verifies its own document and detects edits', () => {
  const doc = buildConfig({ checks: CHECKS, existing: { schemaVersion: 1, checks: [], managedFiles: {}, team: 'neo' } });
  const parsed = roundTrip(doc);

  assert.equal(parsed.kind, 'valid');
  assert.equal(parsed.hasIntegrity, true);
  assert.equal(parsed.integrityValid, true);

  const tampered = { ...parsed.doc, team: 'other' };
  assert.equal(verifyIntegrity(tampered), false);
});

test('integrity covers unknown fields', () => {
  const base = buildConfig({ checks: CHECKS });
  const withUnknown = buildConfig({
    checks: CHECKS,
    existing: { schemaVersion: 1, checks: [], managedFiles: {}, team: 'neo' },
  });

  assert.notEqual(computeIntegrity(base).hash, computeIntegrity(withUnknown).hash);
});

test('parseConfigText rejects malformed JSON', () => {
  assert.equal(parseConfigText('{ not json').kind, 'invalid-json');
  assert.equal(parseConfigText('').kind, 'invalid-json');
});

test('parseConfigText rejects values that are not Ziki configs', () => {
  assert.equal(parseConfigText('[]').kind, 'not-config');
  assert.equal(parseConfigText('null').kind, 'not-config');
  assert.equal(parseConfigText('{"schemaVersion":"1"}').kind, 'not-config');
  assert.equal(parseConfigText('{"schemaVersion":0}').kind, 'not-config');
  assert.equal(parseConfigText('{"hello":"world"}').kind, 'not-config');
});

test('parseConfigText reports newer schema versions', () => {
  const parsed = parseConfigText('{"schemaVersion":2}');
  assert.deepEqual(parsed, { kind: 'unsupported-version', version: 2 });
});

test('parseConfigText rejects malformed owned fields', () => {
  assert.equal(parseConfigText('{"schemaVersion":1}').kind, 'invalid-schema');
  assert.equal(
    parseConfigText('{"schemaVersion":1,"checks":{}}').kind,
    'invalid-schema',
  );
  assert.equal(
    parseConfigText(
      '{"schemaVersion":1,"checks":[],"managedFiles":{"x":"md5:abc"}}',
    ).kind,
    'invalid-schema',
  );
  assert.equal(
    parseConfigText(
      '{"schemaVersion":1,"checks":[],"integrity":{"algorithm":"sha256","hash":"nope"}}',
    ).kind,
    'invalid-schema',
  );
});

test('parseConfigText tolerates a BOM and missing managedFiles', () => {
  const text = `\uFEFF${JSON.stringify({ schemaVersion: 1, checks: [] })}`;
  const parsed = parseConfigText(text);
  assert.equal(parsed.kind, 'valid');
  assert.equal(parsed.hasIntegrity, false);
  assert.equal(parsed.integrityValid, false);
});

test('parseConfigText accepts an unhashed config but does not trust it', () => {
  const parsed = parseConfigText(
    JSON.stringify({ schemaVersion: 1, checks: [], managedFiles: {} }),
  );
  assert.equal(parsed.kind, 'valid');
  assert.equal(parsed.hasIntegrity, false);
});

test('readConfigFile distinguishes absent, file, directory, and symlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ziki-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const target = path.join(dir, 'ziki.json');
  assert.equal(readConfigFile(target).kind, 'absent');

  fs.writeFileSync(target, serializeConfig(buildConfig({ checks: CHECKS })));
  assert.equal(readConfigFile(target).kind, 'valid');

  fs.rmSync(target);
  fs.mkdirSync(target);
  assert.equal(readConfigFile(target).kind, 'directory');
  fs.rmdirSync(target);

  try {
    fs.symlinkSync(path.join(dir, 'elsewhere.json'), target);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('symlink creation is not permitted on this account');
      return;
    }
    throw error;
  }
  assert.equal(readConfigFile(target).kind, 'symlink');
});
