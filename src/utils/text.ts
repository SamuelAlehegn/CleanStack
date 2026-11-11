import path from 'node:path';

/** The two line-ending styles CleanStack writes to generated files. */
export type LineEnding = '\n' | '\r\n';

const UTF8_BOM = '\uFEFF';

/**
 * File types that Windows tools expect to use CRLF. Git for Windows also
 * converts these from LF on checkout, so emitting CRLF avoids noisy diffs and
 * lets scripts run before the first commit.
 */
const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1', '.reg', '.vbs']);

/** Removes the UTF-8 byte-order mark from text read from disk. */
export function stripBom(contents: string): string {
  return contents.startsWith(UTF8_BOM) ? contents.slice(1) : contents;
}

/**
 * Detects the dominant line ending, treating lone carriage returns as line
 * breaks. Returns undefined for content without any line break.
 */
export function detectLineEnding(contents: string): LineEnding | undefined {
  let crlf = 0;
  let lf = 0;

  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === '\r' && contents[index + 1] === '\n') {
      crlf += 1;
      index += 1;
    } else if (contents[index] === '\n' || contents[index] === '\r') {
      lf += 1;
    }
  }

  if (crlf === 0 && lf === 0) return undefined;
  return crlf >= lf ? '\r\n' : '\n';
}

/** Converts every CRLF, lone CR, and LF sequence to one line-ending style. */
export function normalizeLineEndings(contents: string, lineEnding: LineEnding): string {
  const normalized = contents.replace(/\r\n?/g, '\n');
  return lineEnding === '\n' ? normalized : normalized.replace(/\n/g, lineEnding);
}

/** Returns true for file types that should always use CRLF on every platform. */
export function isWindowsScript(filePath: string): boolean {
  return WINDOWS_SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Returns the line ending CleanStack writes for a new file at this path. */
export function lineEndingForFile(filePath: string): LineEnding {
  return isWindowsScript(filePath) ? '\r\n' : '\n';
}

/**
 * Normalizes generated content for its destination: removes a UTF-8 BOM and
 * applies the destination line-ending policy.
 */
export function normalizeFileContents(filePath: string, contents: string): string {
  return normalizeLineEndings(stripBom(contents), lineEndingForFile(filePath));
}
