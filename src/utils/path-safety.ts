import { realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';

/** Resolves a path to its canonical form, typically `fs.realpath`. */
export type RealPathResolver = (filePath: string) => Promise<string>;

export class UnsafePathError extends Error {
  readonly requestedPath: string;
  readonly rootDir: string;

  constructor(requestedPath: string, rootDir: string) {
    super(`Path "${requestedPath}" resolves outside the filesystem root "${rootDir}".`);
    this.name = 'UnsafePathError';
    this.requestedPath = requestedPath;
    this.rootDir = rootDir;
  }
}

/**
 * Validates that a path is relative and cannot lexically escape its root.
 * Returns the path in portable (forward-slash) form.
 */
export function assertRelativePath(input: string, rootDir: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new TypeError('Filesystem paths must be non-empty relative strings.');
  }

  const portablePath = input.replace(/\\/g, '/');
  if (
    path.posix.isAbsolute(portablePath) ||
    path.win32.isAbsolute(input) ||
    portablePath.split('/').includes('..')
  ) {
    throw new UnsafePathError(input, rootDir);
  }

  return portablePath;
}

/**
 * Resolves a relative path against `rootDir` and verifies that the canonical
 * result (following symlinks) stays inside the root.
 */
export async function resolveWithinRoot(
  rootDir: string,
  relativePath: string,
  resolveRealPath: RealPathResolver = nodeRealpath,
): Promise<string> {
  const portablePath = assertRelativePath(relativePath, rootDir);
  const target = path.resolve(rootDir, portablePath);
  await ensureWithinRoot(rootDir, target, relativePath, resolveRealPath);
  return target;
}

/** Verifies that `targetPath` stays inside `rootDir` once symlinks are resolved. */
export async function ensureWithinRoot(
  rootDir: string,
  targetPath: string,
  requestedPath: string,
  resolveRealPath: RealPathResolver = nodeRealpath,
): Promise<void> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalizePath(rootDir, resolveRealPath),
    canonicalizePath(targetPath, resolveRealPath),
  ]);

  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UnsafePathError(requestedPath, rootDir);
  }
}

/**
 * Resolves existing ancestors so symlinks cannot redirect operations outside
 * the root, while still supporting paths that do not exist yet.
 */
export async function canonicalizePath(
  candidate: string,
  resolveRealPath: RealPathResolver = nodeRealpath,
): Promise<string> {
  let current = candidate;
  const missingParts: string[] = [];

  while (true) {
    try {
      const realCurrent = await resolveRealPath(current);
      return path.resolve(realCurrent, ...missingParts.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingParts.push(path.basename(current));
      current = parent;
    }
  }
}

export function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
