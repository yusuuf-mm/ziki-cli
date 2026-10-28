import fs from 'node:fs';
import path from 'node:path';

const SKILL_DIRS = [
  ['.claude/skills', 'claude-skill'],
  ['.opencode/skills', 'opencode-skill'],
  ['.agents/skills', 'agents-skill'],
];

const COMMAND_DIRS = [
  ['.claude/commands', 'claude-command'],
  ['.opencode/commands', 'opencode-command'],
  // Some OpenCode installs use the singular directory name (OD-08). It is
  // detected where it exists but never written: init generates the plural
  // path that the documented layout uses.
  ['.opencode/command', 'opencode-command'],
];

const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md'];

function safeEntries(target, { directories }) {
  try {
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => (directories ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Detect agent configuration files by presence only. Contents are never read.
 * Output is sorted by path, then kind, for deterministic reports.
 */
export function detectAgents(root) {
  const found = [];

  for (const [relativeDir, kind] of SKILL_DIRS) {
    for (const name of safeEntries(path.join(root, relativeDir), { directories: true })) {
      const relativePath = `${relativeDir}/${name}/SKILL.md`;
      if (isFile(path.join(root, ...relativePath.split('/')))) {
        found.push({ kind, path: relativePath });
      }
    }
  }

  for (const [relativeDir, kind] of COMMAND_DIRS) {
    for (const name of safeEntries(path.join(root, relativeDir), { directories: false })) {
      if (!name.endsWith('.md')) {
        continue;
      }
      const relativePath = `${relativeDir}/${name}`;
      found.push({ kind, path: relativePath });
    }
  }

  for (const name of INSTRUCTIONS) {
    if (isFile(path.join(root, name))) {
      found.push({ kind: 'instructions', path: name });
    }
  }

  return found.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
}
