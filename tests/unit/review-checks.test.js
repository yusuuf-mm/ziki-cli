import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectChecks } from '../../src/review/checks.js';
import { serializeConfig } from '../../src/config/zikiConfig.js';
import { cleanup, tempDir, write } from '../helpers/repo.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const CHECK = {
  name: 'test',
  command: 'npm test',
  source: 'package.json#scripts.test',
};

function makeRoot(t) {
  const root = tempDir('ziki-checks-');
  t.after(() => cleanup(root));
  return root;
}

function writeConfig(root, { checks = [CHECK], lastObserved, integrity = true } = {}) {
  const doc = { schemaVersion: 1, checks, managedFiles: {} };
  if (lastObserved !== undefined) {
    doc.lastObserved = lastObserved;
  }
  if (!integrity) {
    fs.writeFileSync(path.join(root, 'ziki.json'), `${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  fs.writeFileSync(path.join(root, 'ziki.json'), serializeConfig(doc));
}

function observation(overrides = {}) {
  return {
    name: 'test',
    command: 'npm test',
    source: 'package.json#scripts.test',
    result: 'passed',
    exitCode: 0,
    observedAt: '2026-10-28T11:00:00.000Z',
    ...overrides,
  };
}

test('a valid recorded observation is surfaced as observed, not verified', (t) => {
  const root = makeRoot(t);
  writeConfig(root, { lastObserved: [observation()] });

  const { checks, warnings } = collectChecks({ root, now: NOW });
  assert.equal(checks.source, 'ziki.json');
  assert.equal(checks.items.length, 1);
  assert.equal(checks.items[0].state, 'observed');
  assert.equal(checks.items[0].detail, null);
  assert.deepEqual(checks.items[0].observed, {
    result: 'passed',
    exitCode: 0,
    observedAt: '2026-10-28T11:00:00.000Z',
    recordedIn: 'ziki.json#lastObserved',
  });
  assert.deepEqual(warnings, []);
});

test('a failed result is preserved with its exit code', (t) => {
  const root = makeRoot(t);
  writeConfig(root, {
    lastObserved: [observation({ result: 'failed', exitCode: 1 })],
  });

  const { checks } = collectChecks({ root, now: NOW });
  assert.equal(checks.items[0].state, 'observed');
  assert.equal(checks.items[0].observed.result, 'failed');
  assert.equal(checks.items[0].observed.exitCode, 1);
});

test('a missing config falls back to detected checks and marks them not run', (t) => {
  const root = makeRoot(t);
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));

  const { checks, warnings } = collectChecks({ root, now: NOW });
  assert.equal(checks.source, 'detected');
  assert.match(checks.detail, /ziki\.json not found/);
  assert.equal(checks.items.length, 1);
  assert.equal(checks.items[0].name, 'test');
  assert.equal(checks.items[0].origin, 'detected');
  assert.equal(checks.items[0].state, 'not run');
  assert.deepEqual(warnings, []);
});

test('an unusable config falls back to detected checks marked unknown', (t) => {
  const root = makeRoot(t);
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'ziki.json'), '{ not json');

  const { checks, warnings } = collectChecks({ root, now: NOW });
  assert.equal(checks.source, 'detected');
  assert.match(checks.detail, /could not be used \(not valid JSON\)/);
  assert.equal(checks.items.length, 1);
  assert.equal(checks.items[0].state, 'unknown');
  assert.equal(checks.items[0].detail, 'the configured check list is unavailable');
  assert.equal(warnings.some((warning) => warning.code === 'config-unusable'), true);
});

test('the latest valid observation wins', (t) => {
  const root = makeRoot(t);
  writeConfig(root, {
    lastObserved: [
      observation({ result: 'passed', exitCode: 0, observedAt: '2026-10-28T10:00:00.000Z' }),
      observation({ result: 'failed', exitCode: 1, observedAt: '2026-10-28T11:30:00.000Z' }),
    ],
  });

  const { checks } = collectChecks({ root, now: NOW });
  assert.equal(checks.items[0].state, 'observed');
  assert.equal(checks.items[0].observed.result, 'failed');
});

test('malformed timestamps are unknown and do not replace a valid observation', (t) => {
  const root = makeRoot(t);
  writeConfig(root, {
    lastObserved: [
      observation({ result: 'passed', observedAt: '2026-10-28T10:00:00.000Z' }),
      observation({ result: 'failed', observedAt: 'yesterday' }),
    ],
  });

  const { checks } = collectChecks({ root, now: NOW });
  assert.equal(checks.items[0].state, 'observed');
  assert.equal(checks.items[0].observed.result, 'passed');

  const onlyInvalid = makeRoot(t);
  writeConfig(onlyInvalid, {
    lastObserved: [observation({ observedAt: '2026-10-28T10:00:00Z' })],
  });
  const invalid = collectChecks({ root: onlyInvalid, now: NOW });
  assert.equal(invalid.checks.items[0].state, 'unknown');
  assert.match(invalid.checks.items[0].detail, /invalid timestamp/);
});

test('future, contradictory, mismatched, and unknown observations are unknown', (t) => {
  const cases = [
    {
      record: observation({ observedAt: '2026-10-28T12:10:00.000Z' }),
      pattern: /future/,
    },
    {
      record: observation({ result: 'passed', exitCode: 1 }),
      pattern: /contradictory/,
    },
    {
      record: observation({ result: 'failed', exitCode: 0 }),
      pattern: /contradictory/,
    },
    {
      record: observation({ command: 'npm run test:other' }),
      pattern: /different command/,
    },
    {
      record: observation({ result: 'unknown' }),
      pattern: /no result/,
    },
  ];

  for (const item of cases) {
    const root = makeRoot(t);
    writeConfig(root, { lastObserved: [item.record] });
    const { checks } = collectChecks({ root, now: NOW });
    assert.equal(checks.items[0].state, 'unknown', item.pattern);
    assert.match(checks.items[0].detail, item.pattern);
  }
});

test('unmatched and malformed observations produce warnings', (t) => {
  const root = makeRoot(t);
  writeConfig(root, {
    lastObserved: [
      observation({ name: 'other', source: 'package.json#scripts.other' }),
      null,
    ],
  });

  const { checks, warnings } = collectChecks({ root, now: NOW });
  assert.equal(checks.items[0].state, 'not run');
  assert.equal(
    warnings.some((warning) => warning.code === 'observations-unmatched'),
    true,
  );
  assert.equal(
    warnings.some((warning) => warning.code === 'observations-invalid'),
    true,
  );
});

test('a non-array lastObserved makes every check unknown', (t) => {
  const root = makeRoot(t);
  writeConfig(root, { lastObserved: { test: 'passed' } });

  const { checks, warnings } = collectChecks({ root, now: NOW });
  assert.equal(checks.items[0].state, 'unknown');
  assert.equal(checks.items[0].detail, 'lastObserved is not an array');
  assert.equal(
    warnings.some((warning) => warning.code === 'last-observed-invalid'),
    true,
  );
});

test('an integrity mismatch is warned about but still shows the configured checks', (t) => {
  const root = makeRoot(t);
  writeConfig(root, { lastObserved: [observation()] });

  const target = path.join(root, 'ziki.json');
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  doc.checks[0].command = 'npm run different';
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);

  const { checks, warnings } = collectChecks({ root, now: NOW });
  assert.equal(checks.source, 'ziki.json');
  assert.equal(checks.items[0].command, 'npm run different');
  assert.equal(
    warnings.some((warning) => warning.code === 'config-integrity-mismatch'),
    true,
  );
});
