import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText } from '../../src/sanitize.js';
import { renderJson } from '../../src/report/json.js';

test('sanitizeText escapes terminal control characters', () => {
  assert.equal(
    sanitizeText('ok\u001b[31mred\u0007'),
    'ok\\x1b[31mred\\x07',
  );
  assert.equal(sanitizeText('c1\u009bdel\u007f'), 'c1\\x9bdel\\x7f');
  assert.equal(sanitizeText('line\u2028sep\u2029end'), 'line\\u2028sep\\u2029end');
  assert.equal(sanitizeText('café 日本'), 'café 日本');
});

test('renderJson escapes DEL and C1 without changing parsed values', () => {
  const value = { subject: 'a\u009bb\u007f', normal: 'café' };
  const json = renderJson(value);

  assert.equal(json.includes('\u009b'), false);
  assert.equal(json.includes('\u007f'), false);
  assert.match(json, /\\u009b/);
  assert.match(json, /\\u007f/);
  assert.deepEqual(JSON.parse(json), value);
});
