import { realpath as nodeRealpath } from 'node:fs/promises';
import path from 'node:path';

/** Resolves a path to its canonical form, typically `fs.realpath`. */
export type RealPathResolver = (filePath: string) => Promise<string>;

/** Characters Windows rejects in file and directory names, plus control chars. */
const WINDOWS_INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;
/** Device names Windows reserves even when they have an extension. */
const WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

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
    // Windows treats "C:foo" as relative to the current directory on drive C,
    // which quietly escapes roots on machines that have that drive.
    /^[A-Za-z]:/.test(input) ||
    portablePath.split('/').includes('..')
  ) {
    throw new UnsafePathError(input, rootDir);
  }

  return path.posix.normalize(portablePath);
}

/**
 * Returns why a single path segment cannot be used as a portable file or
 * directory name, or undefined when it is safe on Windows, macOS, and Linux.
 */
export function pathSegmentProblem(value: string): string | undefined {
  if (value.trim() === '') return 'must not be empty';
  if (value === '.' || value === '..') return 'must not be "." or ".."';
  if (/[\\/]/.test(value)) return 'must not contain path separators';
  if (WINDOWS_INVALID_SEGMENT_CHARS.test(value)) {
    return 'must not contain < > : " | ? * or control characters';
  }
  if (/[. ]$/.test(value)) return 'must not end with a space or period';
  if (WINDOWS_RESERVED_SEGMENT.test(value)) return 'is reserved on Windows';
  return undefined;
}

/** Compares paths with Windows' case-insensitive semantics applied. */
export function isSamePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return comparablePath(left, platform) === comparablePath(right, platform);
}

/** Returns true when `targetPath` is strictly below `rootDir`. */
export function isPathInside(
  rootDir: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32';
  const relative = windows
    ? path.win32.relative(comparablePath(rootDir, platform), comparablePath(targetPath, platform))
    : path.relative(comparablePath(rootDir, platform), comparablePath(targetPath, platform));
  const separator = windows ? '\\' : path.sep;
  const isAbsoluteRelative = windows ? path.win32.isAbsolute(relative) : path.isAbsolute(relative);

  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${separator}`) &&
    !isAbsoluteRelative
  );
}

/** Returns true when `targetPath` is `rootDir` or one of its descendants. */
export function isPathInsideOrEqual(
  rootDir: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return isSamePath(rootDir, targetPath, platform) || isPathInside(rootDir, targetPath, platform);
}

function comparablePath(filePath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return path.win32.resolve(filePath).toLowerCase();
  return path.resolve(filePath);
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

  if (!isPathInsideOrEqual(canonicalRoot, canonicalTarget)) {
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
