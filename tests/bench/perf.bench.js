import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { initRepo, write, git, runCli, cleanup } from '../helpers/repo.js';

test('status stays under 2 seconds on a 500-file repository', async (t) => {
  const dir = initRepo();
  t.after(() => cleanup(dir));

  for (let index = 0; index < 500; index += 1) {
    const name = `file-${String(index).padStart(3, '0')}.txt`;
    write(dir, `bulk/${name}`, `content ${index}\n`);
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add 500 files']);

  // Warm up first-touch filesystem and Git index costs, then let the machine
  // settle before measuring.
  assert.equal(runCli(['status', '--json'], { cwd: dir }).status, 0);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const durations = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const result = runCli(['status', '--json'], { cwd: dir });
    durations.push(performance.now() - started);
    assert.equal(result.status, 0, result.stderr);
  }

  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  t.diagnostic(
    `runs: ${durations.map((duration) => `${duration.toFixed(0)}ms`).join(', ')}; p95: ${p95.toFixed(0)}ms`,
  );
  assert.ok(p95 < 2000, `p95 was ${p95.toFixed(0)}ms`);

  // The fixture is real: Git agrees the tree is clean.
  const porcelain = git(dir, ['status', '--porcelain']).stdout;
  assert.equal(porcelain, '');
  assert.ok(fs.existsSync(path.join(dir, 'bulk', 'file-499.txt')));
});
