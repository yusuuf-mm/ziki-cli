import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askApproval } from '../../src/cli.js';

function answer(input) {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const result = askApproval({ stdin, stderr });
  stdin.end(input);
  return { result, stderr };
}

test('askApproval accepts only an explicit yes', async () => {
  for (const [input, expected] of [
    ['y\n', true],
    ['YES\n', true],
    ['yes\r\n', true],
    ['n\n', false],
    ['\n', false],
    ['yep\n', false],
    [' y \n', true],
  ]) {
    const { result } = answer(input);
    assert.equal(await result, expected, JSON.stringify(input));
  }
});

test('askApproval treats closed stdin as no', async () => {
  const { result } = answer('');
  assert.equal(await result, false);
});

test('askApproval writes the prompt to stderr, not stdout', async () => {
  const { result, stderr } = answer('n\n');
  await result;
  assert.match(stderr.read().toString('utf8'), /Apply these changes\? \[y\/N\]/);
});
