import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Marker tag written into generated files. The `cleanstack:protected` alias is
 * accepted so files generated before the tag was standardized keep working.
 */
export const PROTECTED_REGION_TAG = 'cleanstack:user-code';
export const PROTECTED_REGION_TAG_ALIAS = 'cleanstack:protected';
export const PROTECTED_REGION_CHECKSUM_ALGORITHM = 'sha256';
export const PROTECTED_REGION_CHECKSUM_PREFIX = `${PROTECTED_REGION_CHECKSUM_ALGORITHM}:`;
export const PROTECTED_REGION_ID_MAX_LENGTH = 120;

/** ASCII letter, then letters, digits, and single `.`, `_`, or `-` separators. */
export const PROTECTED_REGION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)*$/;
export const PROTECTED_REGION_CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ProtectedRegionLanguage =
  | 'java'
  | 'kotlin'
  | 'typescript'
  | 'javascript'
  | 'sql'
  | 'html'
  | 'xml'
  | 'css'
  | 'scss'
  | 'yaml'
  | 'properties'
  | 'markdown'
  | 'dockerfile';

export type ProtectedRegionCommentStyle =
  { kind: 'line'; prefix: string } | { kind: 'block'; open: string; close: string };

export interface ProtectedRegionLanguageDefinition {
  name: string;
  extensions: readonly string[];
  comment: ProtectedRegionCommentStyle;
}

export interface ProtectedRegionStartMarker {
  kind: 'start';
  /** Marker tag without angle brackets, for example `cleanstack:user-code`. */
  tag: string;
  id: string;
  /** Base checksum of the template body, or undefined when it was not recorded. */
  checksum: string | undefined;
}

export interface ProtectedRegionEndMarker {
  kind: 'end';
  tag: string;
}

export type ProtectedRegionMarker = ProtectedRegionStartMarker | ProtectedRegionEndMarker;

export interface RenderProtectedRegionOptions {
  language: ProtectedRegionLanguage;
  id: string;
  /** Region body without the marker lines. A missing body renders an empty region. */
  body?: string;
  /** Indentation applied to both marker lines. Defaults to none. */
  indent?: string;
  /** Overrides the computed checksum. Pass null to omit the attribute. */
  checksum?: string | null;
}

export type ProtectedRegionErrorCode =
  | 'PROTECTED_REGION_MALFORMED'
  | 'PROTECTED_REGION_UNCLOSED'
  | 'PROTECTED_REGION_STRAY_END'
  | 'PROTECTED_REGION_NESTED'
  | 'PROTECTED_REGION_TAG_MISMATCH'
  | 'PROTECTED_REGION_DUPLICATE_ID'
  | 'PROTECTED_REGION_UNKNOWN_TYPE'
  | 'PROTECTED_REGION_CONFLICT'
  | 'PROTECTED_REGION_ORPHANED'
  | 'PROTECTED_REGION_UNVERIFIED';

export class ProtectedRegionFormatError extends Error {
  readonly code: ProtectedRegionErrorCode;

  constructor(message: string, code: ProtectedRegionErrorCode = 'PROTECTED_REGION_MALFORMED') {
    super(message);
    this.name = 'ProtectedRegionFormatError';
    this.code = code;
  }
}

export const PROTECTED_REGION_LANGUAGES: Readonly<
  Record<ProtectedRegionLanguage, ProtectedRegionLanguageDefinition>
> = {
  java: {
    name: 'Java',
    extensions: ['.java'],
    comment: { kind: 'line', prefix: '//' },
  },
  kotlin: {
    name: 'Kotlin',
    extensions: ['.kt', '.kts'],
    comment: { kind: 'line', prefix: '//' },
  },
  typescript: {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    comment: { kind: 'line', prefix: '//' },
  },
  javascript: {
    name: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    comment: { kind: 'line', prefix: '//' },
  },
  sql: {
    name: 'SQL',
    extensions: ['.sql'],
    comment: { kind: 'line', prefix: '--' },
  },
  html: {
    name: 'HTML',
    extensions: ['.html', '.htm'],
    comment: { kind: 'block', open: '<!--', close: '-->' },
  },
  xml: {
    name: 'XML',
    extensions: ['.xml', '.xsd'],
    comment: { kind: 'block', open: '<!--', close: '-->' },
  },
  css: {
    name: 'CSS',
    extensions: ['.css'],
    comment: { kind: 'block', open: '/*', close: '*/' },
  },
  scss: {
    name: 'SCSS',
    extensions: ['.scss', '.sass', '.less'],
    comment: { kind: 'block', open: '/*', close: '*/' },
  },
  yaml: {
    name: 'YAML',
    extensions: ['.yml', '.yaml'],
    comment: { kind: 'line', prefix: '#' },
  },
  properties: {
    name: 'Properties',
    extensions: ['.properties', '.env'],
    comment: { kind: 'line', prefix: '#' },
  },
  markdown: {
    name: 'Markdown',
    extensions: ['.md', '.markdown'],
    comment: { kind: 'block', open: '<!--', close: '-->' },
  },
  dockerfile: {
    name: 'Dockerfile',
    extensions: [],
    comment: { kind: 'line', prefix: '#' },
  },
};

const LANGUAGE_BY_EXTENSION = new Map<string, ProtectedRegionLanguage>();
for (const [language, definition] of Object.entries(PROTECTED_REGION_LANGUAGES)) {
  for (const extension of definition.extensions) {
    LANGUAGE_BY_EXTENSION.set(extension, language as ProtectedRegionLanguage);
  }
}

const START_TAG_PATTERN =
  /^<cleanstack:(user-code|protected)((?:\s+[a-zA-Z][a-zA-Z0-9-]*="[^"]*")*)\s*>$/;
const END_TAG_PATTERN = /^<\/cleanstack:(user-code|protected)\s*>$/;
const ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;

/** Returns the protected-region language for a path, or undefined when unsupported. */
export function languageForFile(filePath: string): ProtectedRegionLanguage | undefined {
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName === '.env' || fileName === '.dockerignore' || fileName === '.gitignore') {
    return 'properties';
  }
  if (fileName === 'dockerfile') return 'dockerfile';
  return LANGUAGE_BY_EXTENSION.get(path.extname(fileName));
}

export interface ProtectedRegionLanguageOptions {
  /** Path used to detect the comment syntax. */
  filePath?: string;
  /** Explicit language, which takes precedence over filePath. */
  language?: ProtectedRegionLanguage;
}

/**
 * Resolves the language for a protected-region operation and throws a readable
 * error when neither a supported file path nor a valid language is available.
 */
export function resolveProtectedRegionLanguage(
  options: ProtectedRegionLanguageOptions,
): ProtectedRegionLanguage {
  if (options.language !== undefined) {
    if (!Object.hasOwn(PROTECTED_REGION_LANGUAGES, options.language)) {
      throw new ProtectedRegionFormatError(
        `Unsupported protected region language "${String(options.language)}".`,
        'PROTECTED_REGION_UNKNOWN_TYPE',
      );
    }
    return options.language;
  }

  if (options.filePath !== undefined) {
    const language = languageForFile(options.filePath);
    if (language !== undefined) return language;
    throw new ProtectedRegionFormatError(
      `Cannot parse protected regions in "${options.filePath}": the file type is not supported.`,
      'PROTECTED_REGION_UNKNOWN_TYPE',
    );
  }

  throw new ProtectedRegionFormatError(
    'Protected region parsing requires a file path or an explicit language.',
    'PROTECTED_REGION_UNKNOWN_TYPE',
  );
}

/** Returns the comment style used to wrap markers in a language. */
export function commentStyleFor(language: ProtectedRegionLanguage): ProtectedRegionCommentStyle {
  return PROTECTED_REGION_LANGUAGES[language].comment;
}

/** Validates a region id and throws a readable error when it is not usable. */
export function validateProtectedRegionId(id: string): void {
  if (id.length === 0) {
    throw new ProtectedRegionFormatError('Protected region ids must not be empty.');
  }
  if (id.length > PROTECTED_REGION_ID_MAX_LENGTH) {
    throw new ProtectedRegionFormatError(
      `Protected region id "${id}" is longer than ${PROTECTED_REGION_ID_MAX_LENGTH} characters.`,
    );
  }
  if (!PROTECTED_REGION_ID_PATTERN.test(id)) {
    throw new ProtectedRegionFormatError(
      `Invalid protected region id "${id}". Use letters and digits separated by single ".", "_", or "-" characters, starting with a letter.`,
    );
  }
}

/** Validates a checksum attribute value and throws a readable error when malformed. */
export function validateProtectedRegionChecksum(checksum: string): void {
  if (!PROTECTED_REGION_CHECKSUM_PATTERN.test(checksum)) {
    throw new ProtectedRegionFormatError(
      `Invalid protected region checksum "${checksum}". Expected "${PROTECTED_REGION_CHECKSUM_PREFIX}" followed by 64 lowercase hex characters.`,
    );
  }
}

/**
 * Normalizes a region body before hashing: line endings become LF and exactly
 * one trailing newline is removed. Indentation and other whitespace are kept.
 */
export function normalizeProtectedRegionBody(body: string): string {
  const normalized = body.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

/**
 * Computes the base checksum stored on a start marker. The value covers the
 * template body only, so edits outside a region never change it.
 */
export function computeProtectedRegionChecksum(body: string): string {
  const digest = createHash(PROTECTED_REGION_CHECKSUM_ALGORITHM)
    .update(normalizeProtectedRegionBody(body), 'utf8')
    .digest('hex');
  return `${PROTECTED_REGION_CHECKSUM_PREFIX}${digest}`;
}

/**
 * Compares a region body with its recorded checksum. Returns undefined when the
 * marker has no checksum, meaning the base is unknown and the region is treated
 * as user-owned by the regeneration engine.
 */
export function verifyProtectedRegionChecksum(
  body: string,
  checksum: string | undefined,
): boolean | undefined {
  if (checksum === undefined) return undefined;
  validateProtectedRegionChecksum(checksum);
  return computeProtectedRegionChecksum(body) === checksum;
}

/**
 * Parses one line as a protected-region marker. Returns undefined for ordinary
 * lines and throws for lines that look like markers but are malformed.
 */
export function parseProtectedRegionMarker(
  line: string,
  language: ProtectedRegionLanguage,
): ProtectedRegionMarker | undefined {
  const inner = unwrapComment(line, commentStyleFor(language));
  if (inner === undefined) return undefined;

  if (inner.startsWith('</cleanstack:')) {
    // Other tools may use cleanstack-prefixed comments (for example the
    // generator's route markers). Only the protected-region tags are ours.
    if (
      !inner.startsWith(`</${PROTECTED_REGION_TAG}`) &&
      !inner.startsWith(`</${PROTECTED_REGION_TAG_ALIAS}`)
    ) {
      return undefined;
    }
    const end = END_TAG_PATTERN.exec(inner);
    if (!end) {
      throw new ProtectedRegionFormatError(`Malformed protected region end marker: ${line.trim()}`);
    }
    return { kind: 'end', tag: `cleanstack:${end[1]!}` };
  }

  if (!inner.startsWith('<cleanstack:')) return undefined;
  if (
    !inner.startsWith(`<${PROTECTED_REGION_TAG}`) &&
    !inner.startsWith(`<${PROTECTED_REGION_TAG_ALIAS}`)
  ) {
    return undefined;
  }

  const start = START_TAG_PATTERN.exec(inner);
  if (!start) {
    throw new ProtectedRegionFormatError(`Malformed protected region start marker: ${line.trim()}`);
  }

  const tag = `cleanstack:${start[1]!}`;
  const attributes = parseAttributes(start[2]!.trim(), line);
  const id = attributes.get('id');
  if (id === undefined) {
    throw new ProtectedRegionFormatError(
      `Protected region start marker is missing an id: ${line.trim()}`,
    );
  }
  validateProtectedRegionId(id);

  const checksum = attributes.get('checksum');
  if (checksum !== undefined) validateProtectedRegionChecksum(checksum);

  return { kind: 'start', tag, id, checksum };
}

/** Renders a complete protected-region block, including markers and body. */
export function renderProtectedRegionBlock(options: RenderProtectedRegionOptions): string {
  const { language, id } = options;
  validateProtectedRegionId(id);

  const indent = options.indent ?? '';
  const body = normalizeProtectedRegionBody(options.body ?? '');
  const checksum =
    options.checksum === undefined ? computeProtectedRegionChecksum(body) : options.checksum;
  if (checksum !== null) validateProtectedRegionChecksum(checksum);

  const start = formatMarker(language, renderStartTag(id, checksum), indent);
  const end = formatMarker(language, `</${PROTECTED_REGION_TAG}>`, indent);
  const renderedBody = body.length === 0 ? '' : `${body}\n`;
  return `${start}\n${renderedBody}${end}\n`;
}

function unwrapComment(line: string, comment: ProtectedRegionCommentStyle): string | undefined {
  const trimmed = line.trim();

  if (comment.kind === 'line') {
    if (!trimmed.startsWith(comment.prefix)) return undefined;
    return trimmed.slice(comment.prefix.length).trim();
  }

  if (!trimmed.startsWith(comment.open) || !trimmed.endsWith(comment.close)) {
    return undefined;
  }
  return trimmed.slice(comment.open.length, trimmed.length - comment.close.length).trim();
}

function parseAttributes(attributesText: string, line: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const match of attributesText.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!;
    if (attributes.has(name)) {
      throw new ProtectedRegionFormatError(
        `Protected region marker repeats the "${name}" attribute: ${line.trim()}`,
      );
    }
    attributes.set(name, match[2]!);
  }

  const leftover = attributesText.replace(ATTRIBUTE_PATTERN, '').trim();
  if (leftover.length > 0) {
    throw new ProtectedRegionFormatError(
      `Unexpected text in protected region marker ("${leftover}"): ${line.trim()}`,
    );
  }

  for (const name of attributes.keys()) {
    if (name !== 'id' && name !== 'checksum') {
      throw new ProtectedRegionFormatError(
        `Unknown protected region attribute "${name}": ${line.trim()}`,
      );
    }
  }

  return attributes;
}

function renderStartTag(id: string, checksum: string | null): string {
  const checksumAttribute = checksum === null ? '' : ` checksum="${checksum}"`;
  return `<${PROTECTED_REGION_TAG} id="${id}"${checksumAttribute}>`;
}

function formatMarker(language: ProtectedRegionLanguage, tag: string, indent: string): string {
  const comment = commentStyleFor(language);
  if (comment.kind === 'line') {
    return `${indent}${comment.prefix} ${tag}`;
  }
  return `${indent}${comment.open} ${tag} ${comment.close}`;
}
