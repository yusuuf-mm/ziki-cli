import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_RULES,
  createScanBudget,
  matchSecretRules,
  scanAddedLines,
  scanText,
} from '../../src/review/secrets.js';

function rulesFor(text) {
  return matchSecretRules(text);
}

test('provider patterns identify common key formats', () => {
  assert.deepEqual(rulesFor('aws AKIA1234567890ABCDEF here'), ['aws-access-key-id']);
  assert.deepEqual(rulesFor('ghp_' + 'a'.repeat(36)), ['github-token']);
  assert.deepEqual(rulesFor('github_pat_' + 'a'.repeat(60)), ['github-token']);
  assert.deepEqual(rulesFor('glpat-' + 'a'.repeat(20)), ['gitlab-token']);
  assert.deepEqual(rulesFor('xoxb-1234567890-abcdef'), ['slack-token']);
  assert.deepEqual(rulesFor('sk_live_' + 'a'.repeat(16)), ['stripe-key']);
  assert.deepEqual(rulesFor('AIza' + 'a'.repeat(35)), ['google-api-key']);
  assert.deepEqual(rulesFor('sk-ant-' + 'a'.repeat(20)), ['anthropic-api-key']);
  assert.deepEqual(rulesFor('sk-proj-' + 'a'.repeat(20)), ['openai-api-key']);
  assert.deepEqual(rulesFor('npm_' + 'a'.repeat(36)), ['npm-token']);
  assert.deepEqual(
    rulesFor('eyJabcdefgh.abcdefgh.abcdefgh'),
    ['jwt'],
  );
  assert.deepEqual(rulesFor('Authorization: Bearer abcdefghijklmnop'), ['bearer-token']);
  assert.deepEqual(
    rulesFor('https://user:password@example.test/path'),
    ['url-credentials'],
  );
  assert.deepEqual(
    rulesFor('-----BEGIN OPENSSH PRIVATE KEY-----'),
    ['private-key'],
  );
});

test('generic credential assignments are detected but placeholders are ignored', () => {
  assert.deepEqual(rulesFor('password = "correct-horse-battery"'), [
    'credential-assignment',
  ]);
  assert.deepEqual(rulesFor('client_secret: abcdefgh12345678'), [
    'credential-assignment',
  ]);

  for (const line of [
    'api_key = process.env.API_KEY',
    'api_key = os.environ["API_KEY"]',
    'api_key = "${API_KEY}"',
    'api_key = import.meta.env.API_KEY',
    'password = changeme',
    'password = change-me-please',
    'password = "your-password-here"',
    'password = "<redacted>"',
    'password = "xxxxxxxx"',
    'password = "********"',
    'password = "..."',
  ]) {
    assert.deepEqual(rulesFor(line), [], line);
  }
});

test('a specific provider match suppresses the generic assignment rule', () => {
  const result = scanText('api_key = AKIA1234567890ABCDEF');
  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ['aws-access-key-id'],
  );
});

test('multiline key/value pairs are detected without returning the value', () => {
  const text = [
    'api_key:',
    '  abcdefgh12345678',
    'password: |',
    '  another-secret-value',
  ].join('\n');
  const result = scanText(text, { path: 'config.yaml', scope: 'staged' });

  assert.deepEqual(
    result.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      scope: finding.scope,
      rule: finding.rule,
    })),
    [
      {
        path: 'config.yaml',
        line: 1,
        scope: 'staged',
        rule: 'credential-assignment-multiline',
      },
      {
        path: 'config.yaml',
        line: 3,
        scope: 'staged',
        rule: 'credential-assignment-multiline',
      },
    ],
  );
  assert.equal(JSON.stringify(result.findings).includes('abcdefgh12345678'), false);
  assert.equal(JSON.stringify(result.findings).includes('another-secret-value'), false);
});

test('multiline key detection skips blank and comment lines but not placeholders', () => {
  const text = [
    'password:',
    '',
    '# comment',
    '  ${PASSWORD}',
  ].join('\n');
  assert.deepEqual(scanText(text).findings, []);

  const separated = ['password:', '  ', '# comment', '  real-secret-value'].join('\n');
  assert.deepEqual(
    scanText(separated).findings.map((finding) => finding.rule),
    ['credential-assignment-multiline'],
  );
});

test('findings contain no matched text and use only known rule ids', () => {
  const secret = 'super-secret-value-123456';
  const result = scanText(`access_token = ${secret}`);

  assert.equal(result.findings.length, 1);
  assert.deepEqual(Object.keys(result.findings[0]).sort(), [
    'line',
    'path',
    'rule',
    'scope',
  ]);
  assert.equal(JSON.stringify(result.findings).includes(secret), false);
  assert.ok(SECRET_RULES.some((rule) => rule.id === result.findings[0].rule));
});

test('long lines are truncated, counted, and marked as a limitation', () => {
  const prefix = 'x'.repeat(8192);
  const result = scanText(`${prefix}AKIA1234567890ABCDEF`, {
    maxLineLength: 8192,
  });

  assert.equal(result.findings.length, 0);
  assert.equal(result.longLines, 1);
});

test('the added-line budget stops scanning and reports exhaustion', () => {
  const budget = createScanBudget({ maxAddedLines: 2, maxFindings: 10 });
  const result = scanAddedLines(
    [
      { number: 1, text: 'one' },
      { number: 2, text: 'two' },
      { number: 3, text: 'three' },
    ],
    { path: 'a.txt', scope: 'staged', budget },
  );

  assert.equal(result.scanned, 2);
  assert.equal(budget.scannedLines, 2);
  assert.equal(budget.exhausted, true);
  assert.equal(result.stopped, true);
});

test('the finding budget caps output and marks the result truncated', () => {
  const budget = createScanBudget({ maxAddedLines: 100, maxFindings: 1 });
  const result = scanAddedLines(
    [
      { number: 1, text: 'AKIA1234567890ABCDEF' },
      { number: 2, text: 'AKIA9999999999ABCDEF' },
    ],
    { path: 'a.txt', scope: 'staged', budget },
  );

  assert.equal(result.scanned, 2);
  assert.equal(budget.findings.length, 1);
  assert.equal(budget.findingsTruncated, true);
  assert.equal(result.stopped, true);
});

test('empty text scans zero lines', () => {
  const result = scanText('');
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.findings, []);
  assert.equal(result.longLines, 0);
  assert.equal(result.truncated, false);
});
