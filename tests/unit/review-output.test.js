import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReviewHuman } from '../../src/report/reviewHuman.js';
import { renderJson } from '../../src/report/json.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');

function emptyScope(scope) {
  return {
    available: true,
    complete: true,
    error: null,
    reasons: [],
    files: [],
    filesTotal: 0,
    filesListed: 0,
    truncated: false,
    counts: {
      added: 0,
      modified: 0,
      deleted: 0,
      renamed: 0,
      copied: 0,
      typechange: 0,
      conflicted: 0,
      unknown: 0,
    },
    statsComplete: true,
    insertions: 0,
    deletions: 0,
    binary: 0,
    contentAvailable: true,
    contentComplete: true,
    scope,
  };
}

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    tool: { name: 'ziki-cli', version: '0.1.0' },
    generatedAt: '2026-10-28T12:00:00.000Z',
    repo: {
      root: '/repo',
      cwd: '.',
      branch: 'main',
      detached: false,
      head: 'a'.repeat(40),
      unborn: false,
    },
    changes: {
      complete: true,
      statsComplete: true,
      filesTruncated: false,
      staged: {
        ...emptyScope('staged'),
        files: [
          {
            path: 'src/a.js',
            oldPath: null,
            change: 'modified',
            status: 'M',
            renamed: false,
            copied: false,
            conflicted: false,
            binary: false,
            insertions: 2,
            deletions: 1,
            stats: 'exact',
            modeChange: false,
            scope: 'staged',
          },
        ],
        filesTotal: 1,
        filesListed: 1,
        insertions: 2,
        deletions: 1,
        counts: { ...emptyScope('staged').counts, modified: 1 },
      },
      unstaged: emptyScope('unstaged'),
      untracked: {
        available: true,
        error: null,
        files: [],
        filesTotal: 0,
        filesListed: 0,
        truncated: false,
        omitted: 0,
        insertions: 0,
        bytes: 0,
        binary: 0,
        scannedFiles: 0,
        scannedLines: 0,
        reasons: [],
      },
      summary: {
        files: 1,
        insertions: 2,
        deletions: 1,
        binary: 0,
        added: 0,
        modified: 1,
        deleted: 0,
        renamed: 0,
        copied: 0,
        typechange: 0,
        conflicted: 0,
        unknown: 0,
        untracked: 0,
        statsComplete: true,
      },
    },
    areas: [
      { path: 'src', files: 1, insertions: 2, deletions: 1, statsComplete: true, scopes: ['staged'] },
    ],
    largest: [
      { path: 'src/a.js', scope: 'staged', change: 'modified', insertions: 2, deletions: 1 },
    ],
    checks: {
      source: 'ziki.json',
      detail: null,
      items: [
        {
          name: 'test',
          command: 'npm test',
          source: 'package.json#scripts.test',
          origin: 'ziki.json',
          state: 'observed',
          observed: {
            result: 'passed',
            exitCode: 0,
            observedAt: '2026-10-28T11:00:00.000Z',
            recordedIn: 'ziki.json#lastObserved',
          },
          detail: null,
        },
      ],
    },
    secrets: {
      state: 'scanned',
      findings: [],
      scanned: { stagedLines: 3, unstagedLines: 0, untrackedLines: 0, totalLines: 3 },
      truncated: false,
      reasons: [],
    },
    limits: {
      maxDiffBytes: 8388608,
      maxAddedLines: 20000,
      maxLineLength: 8192,
      maxFindings: 200,
      maxUntrackedFiles: 200,
      maxUntrackedFileBytes: 524288,
      maxUntrackedScanBytes: 4194304,
      maxFilesListed: 500,
      maxAreas: 20,
      maxLargest: 10,
      hit: [],
    },
    warnings: [],
    ...overrides,
  };
}

test('human review output has stable sections and distinguishes recorded state', () => {
  const output = renderReviewHuman(report(), { color: false, now: NOW });

  for (const text of [
    'ziki review',
    'repo      /repo',
    'branch    main  at aaaaaaa',
    'staged    1 file  +2 -1',
    'changed files',
    'areas',
    'largest changes',
    'checks',
    'secrets',
    'read-only: no files were written and no project commands were run',
  ]) {
    assert.match(output, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(output, /observed passed, exit 0  \(recorded in ziki\.json 1 hour ago\)/);
  assert.doesNotMatch(output, /verified/);
  assert.doesNotMatch(output, /\u001b/);
});

test('human review output counts secret patterns instead of denying them', () => {
  const dirty = report();
  dirty.secrets.findings = [
    { path: 'src/token.js', line: 3, scope: 'staged', rule: 'github-token' },
  ];

  const output = renderReviewHuman(dirty, { color: false, now: NOW });
  assert.match(output, /3 added lines scanned; 1 pattern found/);
  assert.doesNotMatch(output, /no patterns found/);

  const partial = report();
  partial.secrets.state = 'partial';
  partial.secrets.truncated = true;
  partial.secrets.findings = [
    { path: 'src/token.js', line: 3, scope: 'staged', rule: 'github-token' },
  ];
  const partialOutput = renderReviewHuman(partial, { color: false, now: NOW });
  assert.match(partialOutput, /results are incomplete; 1 pattern found/);
});

test('human review output reports clean and incomplete states honestly', () => {
  const clean = report();
  clean.changes.staged = emptyScope('staged');
  clean.changes.summary = {
    ...clean.changes.summary,
    files: 0,
    insertions: 0,
    deletions: 0,
    modified: 0,
  };
  clean.areas = [];
  clean.largest = [];
  clean.secrets.scanned = {
    stagedLines: 0,
    unstagedLines: 0,
    untrackedLines: 0,
    totalLines: 0,
  };

  const cleanOutput = renderReviewHuman(clean, { color: false, now: NOW });
  assert.match(cleanOutput, /summary   \(clean\)/);
  assert.match(cleanOutput, /scanned; no patterns found/);

  const incomplete = report();
  incomplete.changes.staged.available = false;
  incomplete.changes.staged.error = 'staged changes could not be inspected';
  incomplete.changes.summary.files = null;
  incomplete.changes.summary.insertions = null;
  incomplete.changes.summary.deletions = null;
  incomplete.secrets.state = 'not-scanned';
  incomplete.secrets.truncated = true;
  incomplete.secrets.reasons = ['staged changes were unavailable, so they were not scanned'];
  incomplete.warnings = [{ code: 'staged-unavailable', message: 'staged changes could not be inspected' }];

  const partialOutput = renderReviewHuman(incomplete, { color: false, now: NOW });
  assert.match(partialOutput, /staged    unavailable/);
  assert.match(partialOutput, /summary   incomplete/);
  assert.match(partialOutput, /not scanned/);
  assert.match(partialOutput, /warnings/);
  assert.match(partialOutput, /staged-unavailable/);
});

test('human review output escapes untrusted control characters', () => {
  const dangerous = report();
  dangerous.repo.root = '/repo/\u001b[31mred';
  dangerous.repo.branch = 'main\u0007';
  dangerous.changes.staged.files[0].path = 'src/\u0007bad.js';
  dangerous.checks.items[0].name = 'te\u009bst';
  dangerous.checks.items[0].command = 'npm\u001b[31m test';
  dangerous.secrets.findings = [
    { path: 'src/\u001b[31msecret.js', line: 3, scope: 'staged', rule: 'rule\u0007' },
  ];
  dangerous.warnings = [
    { code: 'warn\u001b[31m', message: 'message\u0007' },
  ];

  const output = renderReviewHuman(dangerous, { color: false, now: NOW });
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.includes('\u0007'), false);
  assert.equal(output.includes('\u009b'), false);
  assert.match(output, /src\/\\x07bad\.js/);
  assert.match(output, /rule\\x07/);
  assert.match(output, /warn\\x1b\[31m/);
});

test('color is applied only when the caller enables it', () => {
  const plain = renderReviewHuman(report(), { color: false, now: NOW });
  assert.equal(plain.includes('\u001b'), false);

  const colored = renderReviewHuman(report(), { color: true, now: NOW });
  assert.match(colored, /\u001b\[1mziki review\u001b\[22m/);
});

test('JSON output escapes DEL and C1 without changing parsed values', () => {
  const value = report();
  value.repo.root = '/repo/\u007f\u009b';
  const json = renderJson(value);

  assert.equal(json.includes('\u007f'), false);
  assert.equal(json.includes('\u009b'), false);
  assert.equal(JSON.parse(json).repo.root, '/repo/\u007f\u009b');
});
