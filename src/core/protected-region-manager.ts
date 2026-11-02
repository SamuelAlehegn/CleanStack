import {
  ProtectedRegionFormatError,
  computeProtectedRegionChecksum,
  parseProtectedRegionMarker,
  renderProtectedRegionBlock,
  resolveProtectedRegionLanguage,
  verifyProtectedRegionChecksum,
  type ProtectedRegionErrorCode,
  type ProtectedRegionLanguage,
  type ProtectedRegionLanguageOptions,
  type ProtectedRegionStartMarker,
} from './protected-regions.js';

export type ProtectedRegionMergeStrategy = 'manual' | 'keep-user' | 'keep-template';

export interface ProtectedRegionManagerOptions {
  /** Default strategy for conflicts and orphaned regions. Defaults to `manual`. */
  strategy?: ProtectedRegionMergeStrategy;
  /** Per-region strategy overrides keyed by region id. */
  strategies?: Readonly<Record<string, ProtectedRegionMergeStrategy>>;
}

export type ProtectedRegionParseOptions = ProtectedRegionLanguageOptions;

export interface ProtectedRegionMergeOptions extends ProtectedRegionLanguageOptions {
  /** Overrides the manager default for this merge. */
  strategy?: ProtectedRegionMergeStrategy;
  /** Per-region overrides for this merge, taking precedence over manager defaults. */
  strategies?: Readonly<Record<string, ProtectedRegionMergeStrategy>>;
}

export interface ProtectedRegion {
  id: string;
  tag: string;
  /** Body between the marker lines, with one trailing line ending removed. */
  body: string;
  /** Checksum stored on the start marker, or undefined when it was not recorded. */
  checksum: string | undefined;
  /** 1-based line number of the start marker. */
  startLine: number;
  /** 1-based line number of the end marker. */
  endLine: number;
  /** Character offset of the start marker line. */
  startOffset: number;
  /** Character offset just after the end marker line and its line ending. */
  endOffset: number;
  /** Leading whitespace of the start marker line. */
  indent: string;
  /** Whether the body matches the stored checksum; undefined when there is no checksum. */
  modified: boolean | undefined;
}

export interface ParsedProtectedRegionFile {
  source: string;
  language: ProtectedRegionLanguage;
  regions: ProtectedRegion[];
}

export type ProtectedRegionDecisionStatus =
  | 'unchanged'
  | 'template-updated'
  | 'user-preserved'
  | 'converged'
  | 'added'
  | 'unverified'
  | 'conflict-kept-user'
  | 'conflict-kept-template'
  | 'conflict-manual'
  | 'orphaned-kept'
  | 'orphaned-dropped'
  | 'orphaned-manual';

export interface ProtectedRegionDecision {
  id: string;
  status: ProtectedRegionDecisionStatus;
  /** 1-based line in the generated file, or in the existing file for orphaned regions. */
  line: number;
  /** Strategy used when the decision involved a conflict or orphan. */
  strategy?: ProtectedRegionMergeStrategy;
}

export interface ProtectedRegionConflict {
  id: string;
  kind: 'both-modified' | 'orphaned';
  strategy: ProtectedRegionMergeStrategy;
  /** False when the strategy is `manual` and the file must not be written. */
  resolved: boolean;
  message: string;
}

export interface ProtectedRegionWarning {
  id: string;
  code: 'PROTECTED_REGION_UNVERIFIED';
  message: string;
}

export interface ProtectedRegionMergeResult {
  /**
   * Content to write. When `writable` is false this is the existing source,
   * unchanged, so callers can write it without destroying anything.
   */
  content: string;
  /** False when a manual conflict must be resolved before the file is written. */
  writable: boolean;
  language: ProtectedRegionLanguage;
  decisions: ProtectedRegionDecision[];
  conflicts: ProtectedRegionConflict[];
  warnings: ProtectedRegionWarning[];
}

export class ProtectedRegionMergeError extends Error {
  readonly code: ProtectedRegionErrorCode;

  constructor(message: string, code: ProtectedRegionErrorCode = 'PROTECTED_REGION_CONFLICT') {
    super(message);
    this.name = 'ProtectedRegionMergeError';
    this.code = code;
  }
}

const MERGE_STRATEGIES: readonly ProtectedRegionMergeStrategy[] = [
  'manual',
  'keep-user',
  'keep-template',
];

interface SourceLine {
  text: string;
  start: number;
  end: number;
  eol: string;
}

interface OpenRegion {
  marker: ProtectedRegionStartMarker;
  lineIndex: number;
}

/**
 * Extracts protected regions from generated files and re-injects user content
 * when a file is regenerated. The manager is pure: it never reads or writes
 * files, so callers can pair it with FileSystemService and dry-run support.
 */
export class ProtectedRegionManager {
  private readonly defaultStrategy: ProtectedRegionMergeStrategy;
  private readonly regionStrategies: ReadonlyMap<string, ProtectedRegionMergeStrategy>;

  constructor(options: ProtectedRegionManagerOptions = {}) {
    this.defaultStrategy = options.strategy ?? 'manual';
    assertStrategy(this.defaultStrategy);
    this.regionStrategies = new Map(Object.entries(options.strategies ?? {}));
    for (const [id, strategy] of this.regionStrategies) {
      try {
        assertStrategy(strategy);
      } catch (error) {
        throw new ProtectedRegionMergeError(
          `Invalid merge strategy for protected region "${id}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Parses a file's content and extracts every protected region in order. */
  parse(source: string, options: ProtectedRegionParseOptions = {}): ParsedProtectedRegionFile {
    const language = resolveProtectedRegionLanguage(options);
    const lines = splitSourceLines(source);
    const regions: ProtectedRegion[] = [];
    const seenIds = new Set<string>();
    let open: OpenRegion | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const marker = parseProtectedRegionMarker(line.text, language);
      if (marker === undefined) continue;

      if (marker.kind === 'start') {
        if (open !== undefined) {
          throw new ProtectedRegionFormatError(
            `Nested protected region "${marker.id}" at line ${index + 1}; region "${open.marker.id}" is still open.`,
            'PROTECTED_REGION_NESTED',
          );
        }
        if (seenIds.has(marker.id)) {
          throw new ProtectedRegionFormatError(
            `Duplicate protected region id "${marker.id}" at line ${index + 1}.`,
            'PROTECTED_REGION_DUPLICATE_ID',
          );
        }
        open = { marker, lineIndex: index };
        continue;
      }

      if (open === undefined) {
        throw new ProtectedRegionFormatError(
          `Protected region end marker at line ${index + 1} has no matching start marker.`,
          'PROTECTED_REGION_STRAY_END',
        );
      }
      if (marker.tag !== open.marker.tag) {
        throw new ProtectedRegionFormatError(
          `Protected region "${open.marker.id}" opens with <${open.marker.tag}> and closes with </${marker.tag}> at line ${index + 1}.`,
          'PROTECTED_REGION_TAG_MISMATCH',
        );
      }

      const startLine = lines[open.lineIndex]!;
      const endLine = line;
      const body = joinBody(lines.slice(open.lineIndex + 1, index));
      const verified = verifyProtectedRegionChecksum(body, open.marker.checksum);
      const region: ProtectedRegion = {
        id: open.marker.id,
        tag: open.marker.tag,
        body,
        checksum: open.marker.checksum,
        startLine: open.lineIndex + 1,
        endLine: index + 1,
        startOffset: startLine.start,
        endOffset: endLine.end,
        indent: leadingWhitespace(startLine.text),
        modified: verified === undefined ? undefined : !verified,
      };

      regions.push(region);
      seenIds.add(region.id);
      open = undefined;
    }

    if (open !== undefined) {
      throw new ProtectedRegionFormatError(
        `Protected region "${open.marker.id}" opened at line ${open.lineIndex + 1} has no matching end marker.`,
        'PROTECTED_REGION_UNCLOSED',
      );
    }

    return { source, language, regions };
  }

  /**
   * Merges user content from an existing file into a newly generated file.
   *
   * The stored checksum is the base of the template body from the previous
   * generation. Comparing it with the current body and the new template body
   * distinguishes user edits, template edits, and conflicts.
   */
  merge(
    existingSource: string,
    generatedSource: string,
    options: ProtectedRegionMergeOptions = {},
  ): ProtectedRegionMergeResult {
    if (options.strategy !== undefined) assertStrategy(options.strategy);
    for (const strategy of Object.values(options.strategies ?? {})) {
      assertStrategy(strategy);
    }

    const language = resolveProtectedRegionLanguage(options);
    const existing = this.parse(existingSource, { language });
    const generated = this.parse(generatedSource, { language });
    const existingById = new Map(existing.regions.map((region) => [region.id, region]));
    const generatedIds = new Set(generated.regions.map((region) => region.id));

    const decisions: ProtectedRegionDecision[] = [];
    const conflicts: ProtectedRegionConflict[] = [];
    const warnings: ProtectedRegionWarning[] = [];
    let unresolvedConflict = false;

    let content = '';
    let cursor = 0;

    for (const templateRegion of generated.regions) {
      content += generatedSource.slice(cursor, templateRegion.startOffset);
      const existingRegion = existingById.get(templateRegion.id);
      const templateChecksum = computeProtectedRegionChecksum(templateRegion.body);
      let body = templateRegion.body;
      let checksum: string | null = templateChecksum;
      let status: ProtectedRegionDecisionStatus;
      let strategy: ProtectedRegionMergeStrategy | undefined;

      if (existingRegion === undefined) {
        status = 'added';
      } else {
        const baseChecksum = existingRegion.checksum;
        const existingChecksum = computeProtectedRegionChecksum(existingRegion.body);
        const userModified =
          baseChecksum === undefined ? undefined : existingChecksum !== baseChecksum;
        const templateModified =
          baseChecksum === undefined ? undefined : templateChecksum !== baseChecksum;

        if (baseChecksum === undefined) {
          if (existingChecksum === templateChecksum) {
            status = 'unchanged';
          } else {
            status = 'unverified';
            body = existingRegion.body;
            warnings.push({
              id: templateRegion.id,
              code: 'PROTECTED_REGION_UNVERIFIED',
              message: `Protected region "${templateRegion.id}" has no checksum; the existing body was preserved.`,
            });
          }
        } else if (userModified === false && templateModified === false) {
          status = 'unchanged';
        } else if (userModified === false && templateModified === true) {
          status = 'template-updated';
        } else if (userModified === true && templateModified === false) {
          status = 'user-preserved';
          body = existingRegion.body;
        } else if (existingChecksum === templateChecksum) {
          status = 'converged';
        } else {
          strategy = this.strategyFor(templateRegion.id, options);
          const resolved = strategy !== 'manual';
          conflicts.push({
            id: templateRegion.id,
            kind: 'both-modified',
            strategy,
            resolved,
            message: `Protected region "${templateRegion.id}" changed in both the existing file and the template.`,
          });

          if (strategy === 'keep-user') {
            status = 'conflict-kept-user';
            body = existingRegion.body;
          } else if (strategy === 'keep-template') {
            status = 'conflict-kept-template';
          } else {
            status = 'conflict-manual';
            body = existingRegion.body;
            checksum = baseChecksum;
            unresolvedConflict = true;
          }
        }
      }

      const decision: ProtectedRegionDecision = {
        id: templateRegion.id,
        status,
        line: templateRegion.startLine,
      };
      if (strategy !== undefined) decision.strategy = strategy;
      decisions.push(decision);

      content += renderProtectedRegionBlock({
        language,
        id: templateRegion.id,
        body,
        indent: templateRegion.indent,
        checksum,
      });
      cursor = templateRegion.endOffset;
    }

    content += generatedSource.slice(cursor);

    const keptOrphans: ProtectedRegion[] = [];
    for (const orphan of existing.regions) {
      if (generatedIds.has(orphan.id)) continue;

      const strategy = this.strategyFor(orphan.id, options);
      const resolved = strategy !== 'manual';
      conflicts.push({
        id: orphan.id,
        kind: 'orphaned',
        strategy,
        resolved,
        message: `Protected region "${orphan.id}" exists in the existing file but not in the template.`,
      });
      decisions.push({
        id: orphan.id,
        status:
          strategy === 'keep-user'
            ? 'orphaned-kept'
            : strategy === 'keep-template'
              ? 'orphaned-dropped'
              : 'orphaned-manual',
        line: orphan.startLine,
        strategy,
      });

      if (strategy === 'keep-user') keptOrphans.push(orphan);
      if (strategy === 'manual') unresolvedConflict = true;
    }

    if (keptOrphans.length > 0) {
      if (content.length > 0 && !endsWithLineEnding(content)) content += '\n';
      for (const orphan of keptOrphans) {
        content += renderProtectedRegionBlock({
          language,
          id: orphan.id,
          body: orphan.body,
          checksum: orphan.checksum ?? null,
        });
      }
    }

    if (unresolvedConflict) {
      return {
        content: existingSource,
        writable: false,
        language,
        decisions,
        conflicts,
        warnings,
      };
    }

    const targetLineEnding =
      detectLineEnding(existingSource) ?? detectLineEnding(generatedSource) ?? '\n';
    content = normalizeLineEndings(content);
    if (targetLineEnding === '\r\n') {
      content = content.replace(/\n/g, '\r\n');
    } else if (targetLineEnding === '\r') {
      content = content.replace(/\n/g, '\r');
    }

    const trailingNewlineReference = existingSource.length > 0 ? existingSource : generatedSource;
    if (trailingNewlineReference.length > 0 && !endsWithLineEnding(trailingNewlineReference)) {
      content = content.replace(/(?:\r\n|\r|\n)$/, '');
    }

    return {
      content,
      writable: true,
      language,
      decisions,
      conflicts,
      warnings,
    };
  }

  private strategyFor(
    id: string,
    options: ProtectedRegionMergeOptions,
  ): ProtectedRegionMergeStrategy {
    const strategy =
      strategyOverride(options.strategies, id) ??
      this.regionStrategies.get(id) ??
      options.strategy ??
      this.defaultStrategy;
    assertStrategy(strategy);
    return strategy;
  }
}

function strategyOverride(
  strategies: Readonly<Record<string, ProtectedRegionMergeStrategy>> | undefined,
  id: string,
): ProtectedRegionMergeStrategy | undefined {
  return strategies !== undefined && Object.hasOwn(strategies, id) ? strategies[id] : undefined;
}

function assertStrategy(strategy: string): asserts strategy is ProtectedRegionMergeStrategy {
  if (!MERGE_STRATEGIES.includes(strategy as ProtectedRegionMergeStrategy)) {
    throw new ProtectedRegionMergeError(
      `Unknown protected region merge strategy "${strategy}". Use "manual", "keep-user", or "keep-template".`,
    );
  }
}

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character !== '\n' && character !== '\r') continue;

    const eol = character === '\r' && source[index + 1] === '\n' ? '\r\n' : character;
    lines.push({ text: source.slice(start, index), start, end: index + eol.length, eol });
    index += eol.length - 1;
    start = index + 1;
  }

  if (start < source.length) {
    lines.push({ text: source.slice(start), start, end: source.length, eol: '' });
  }

  return lines;
}

function joinBody(lines: readonly SourceLine[]): string {
  const body = lines.map((line) => line.text + line.eol).join('');
  if (body.endsWith('\r\n')) return body.slice(0, -2);
  if (body.endsWith('\n') || body.endsWith('\r')) return body.slice(0, -1);
  return body;
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? '';
}

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

function detectLineEnding(source: string): '\n' | '\r\n' | '\r' | undefined {
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\r') {
      if (source[index + 1] === '\n') {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (character === '\n') {
      lf += 1;
    }
  }

  if (crlf === 0 && lf === 0 && cr === 0) return undefined;
  if (crlf >= lf && crlf >= cr) return '\r\n';
  if (lf >= cr) return '\n';
  return '\r';
}

function endsWithLineEnding(source: string): boolean {
  return /(?:\r\n|\r|\n)$/.test(source);
}
