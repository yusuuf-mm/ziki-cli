import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AGENT_TEMPLATES } from '../../src/templates/agentFiles.js';

test('template paths are repo-relative and safe', (t) => {
  for (const { path: p } of AGENT_TEMPLATES) {
    assert.ok(!path.isAbsolute(p), `path ${p} must not be absolute`);
    assert.ok(!p.startsWith('..'), `path ${p} must not start with ..`);
    assert.ok(p.endsWith('.md'), `path ${p} must end with .md, got ${p}`);
  }
});

test('SKILL.md has documented frontmatter name and description', (t) => {
  const skill = AGENT_TEMPLATES.find((t) => t.kind === 'claude-skill');
  assert.ok(skill, 'claude-skill template exists');
  // Frontmatter must contain name and description keys.
  const hasName = /^name: .+$/m.test(skill.content);
  const hasDesc = /^description: .+$/m.test(skill.content);
  assert.ok(hasName, 'SKILL.md frontmatter must contain name');
  assert.ok(hasDesc, 'SKILL.md frontmatter must contain description');
  assert.match(skill.content, /name: ziki/, 'SKILL.md name should be ziki');
});

test('claude-command and opencode-command files have description-only frontmatter', (t) => {
  const cmd1 = AGENT_TEMPLATES.find((t) => t.kind === 'claude-command');
  const cmd2 = AGENT_TEMPLATES.find((t) => t.kind === 'opencode-command');
  assert.ok(cmd1, 'claude-command template exists');
  assert.ok(cmd2, 'opencode-command template exists');
  // Frontmatter should contain description key.
  const hasDesc1 = /^description: .+$/m.test(cmd1.content);
  const hasDesc2 = /^description: .+$/m.test(cmd2.content);
  assert.ok(hasDesc1, 'claude-command frontmatter must contain description');
  assert.ok(hasDesc2, 'opencode-command frontmatter must contain description');
});

test('templates contain CLI invocation placeholder', (t) => {
  for (const { content } of AGENT_TEMPLATES) {
    assert.match(content, /<ziki-cli>/,
      `template must contain <ziki-cli> placeholder`);
    assert.match(content, /node <ziki-cli>\//,
      `template must instruct node <ziki-cli>/bin/ziki.js`);
  }
});

test('template bodies mention all 7 workflow steps (case-insensitive)', (t) => {
  const steps = [
    'Inspect',
    'Plan',
    'Human approval',
    'Work',
    'Verify',
    'Review',
    'Present decisions',
  ];
  for (const { content } of AGENT_TEMPLATES) {
    for (const step of steps) {
      // Case-insensitive match so "inspect"/"INSPECT" both work.
      assert.match(content, new RegExp(step, 'i'),
        `template body must mention (“${step}”) step`);
    }
  }
});

test('no absolute machine paths in templates', (t) => {
  const absolutePathPatterns = [/C:\\/, /^\/home\//, /^\/Users\//];
  for (const { content } of AGENT_TEMPLATES) {
    for (const pattern of absolutePathPatterns) {
      assert.strictEqual(pattern.test(content), false,
        `template must not contain absolute machine path`);
    }
  }
});