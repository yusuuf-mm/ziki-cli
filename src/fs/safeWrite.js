import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RuntimeError } from '../errors.js';

function comparable(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

/**
 * Resolve a repository-relative path and reject anything that escapes the
 * repository. Absolute paths and `..` segments are never accepted.
 */
export function resolveRepoPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new RuntimeError('internal error: empty repository-relative path');
  }
  if (path.isAbsolute(relativePath)) {
    throw new RuntimeError(`refusing to write an absolute path: "${relativePath}"`);
  }

  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new RuntimeError(`refusing to write outside the repository: "${relativePath}"`);
  }

  const target = path.resolve(root, relativePath);
  if (!isInsideRoot(path.resolve(root), target)) {
    throw new RuntimeError(`refusing to write outside the repository: "${relativePath}"`);
  }
  return target;
}

function assertTargetEntry(target, displayPath) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw new RuntimeError(
      `cannot inspect "${displayPath}": ${error && error.code ? error.code : 'unknown error'}`,
    );
  }

  if (stat.isSymbolicLink()) {
    throw new RuntimeError(
      `refusing to write "${displayPath}": it is a symlink; replace it with a regular file first`,
    );
  }
  if (stat.isDirectory()) {
    throw new RuntimeError(
      `refusing to write "${displayPath}": it is a directory; remove or rename it first`,
    );
  }
  if (!stat.isFile()) {
    throw new RuntimeError(
      `refusing to write "${displayPath}": it is not a regular file`,
    );
  }
}

/**
 * Fail before any write if the target or an ancestor is a symlink, a
 * non-directory, or outside the repository. This is a preflight check; the
 * atomic write below still uses a fresh temporary file in the target directory.
 */
export function assertWritableTarget(root, target, displayPath) {
  const absoluteRoot = path.resolve(root);

  if (!isInsideRoot(absoluteRoot, target)) {
    throw new RuntimeError(`refusing to write outside the repository: "${displayPath}"`);
  }

  const relative = path.relative(absoluteRoot, target);
  const parts = relative.split(path.sep);
  let current = absoluteRoot;

  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        break;
      }
      throw new RuntimeError(
        `cannot inspect "${displayPath}": ${error && error.code ? error.code : 'unknown error'}`,
      );
    }

    if (stat.isSymbolicLink()) {
      throw new RuntimeError(
        `refusing to write "${displayPath}": a parent directory is a symlink`,
      );
    }
    if (!stat.isDirectory()) {
      throw new RuntimeError(
        `refusing to write "${displayPath}": a parent path is not a directory`,
      );
    }
  }

  const realRoot = comparable(fs.realpathSync(absoluteRoot));
  const parent = path.dirname(target);
  if (fs.existsSync(parent)) {
    const realParent = comparable(fs.realpathSync(parent));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new RuntimeError(
        `refusing to write "${displayPath}": the target directory is outside the repository`,
      );
    }
  }

  assertTargetEntry(target, displayPath);
}

/**
 * Write one file atomically: a fresh temporary file in the same directory,
 * fsync, then rename over the target. The caller must run
 * `assertWritableTarget` first.
 */
export function atomicWriteFile(target, content, { displayPath = target } = {}) {
  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );

  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o666);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The original failure is the useful one.
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Nothing else to clean up.
    }
    throw new RuntimeError(
      `failed to write "${displayPath}": ${error && error.code ? error.code : 'unknown error'}`,
    );
  }

  // Persist the directory entry where the platform allows it. Windows cannot
  // open a directory as a file, so this is best effort off POSIX.
  if (process.platform !== 'win32') {
    try {
      const directoryDescriptor = fs.openSync(directory, 'r');
      fs.fsyncSync(directoryDescriptor);
      fs.closeSync(directoryDescriptor);
    } catch {
      // Durability is a bonus; the rename already succeeded.
    }
  }

  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
  };
}
