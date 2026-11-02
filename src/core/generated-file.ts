import {
  languageForFile,
  resolveProtectedRegionLanguage,
  type ProtectedRegionLanguage,
} from './protected-regions.js';
import {
  ProtectedRegionManager,
  type ProtectedRegionConflict,
  type ProtectedRegionDecision,
  type ProtectedRegionMergeStrategy,
  type ProtectedRegionWarning,
} from './protected-region-manager.js';
import type { FileSystemService } from '../utils/file-system.js';

export type GeneratedFileStatus =
  'created' | 'updated' | 'unchanged' | 'overwritten' | 'preserved' | 'conflict';

export interface GeneratedFileResult {
  /** Path relative to the generator filesystem root. */
  path: string;
  status: GeneratedFileStatus;
  /** Detected protected-region language, when the file supports markers. */
  language?: ProtectedRegionLanguage;
  decisions: ProtectedRegionDecision[];
  conflicts: ProtectedRegionConflict[];
  warnings: ProtectedRegionWarning[];
  /** Human-readable explanation for `preserved` and `conflict` outcomes. */
  reason?: string;
}

export interface WriteGeneratedFileOptions {
  /** Replace the file completely, including every protected region. */
  force?: boolean;
  /** Compute the outcome without writing anything. */
  dryRun?: boolean;
  /** Overrides the manager default for conflicts in this file. */
  strategy?: ProtectedRegionMergeStrategy;
  /** Per-region strategy overrides. */
  strategies?: Readonly<Record<string, ProtectedRegionMergeStrategy>>;
  /** Injectable manager, mainly for tests. */
  manager?: ProtectedRegionManager;
}

const defaultManager = new ProtectedRegionManager();

/**
 * Writes a rendered template safely.
 *
 * New files are written with checksums on every protected region. Existing
 * files are merged region by region, so user code survives repeated runs.
 * Files without protected-region markers are only replaced with `force`, and
 * unresolved conflicts never overwrite the existing file.
 */
export async function writeGeneratedFile(
  output: FileSystemService,
  relativePath: string,
  generatedSource: string,
  options: WriteGeneratedFileOptions = {},
): Promise<GeneratedFileResult> {
  const manager = options.manager ?? defaultManager;
  const language = languageForFile(relativePath);
  const exists = await output.exists(relativePath);

  if (!exists) {
    const prepared =
      language === undefined
        ? plainSource(generatedSource)
        : prepareGeneratedSource(manager, generatedSource, language);
    if (!options.dryRun) {
      await output.writeFile(relativePath, prepared.content, { overwrite: false });
    }
    return {
      path: relativePath,
      status: 'created',
      ...(language === undefined ? {} : { language }),
      decisions: prepared.decisions,
      conflicts: prepared.conflicts,
      warnings: prepared.warnings,
    };
  }

  const existingSource = await output.readFile(relativePath);

  if (options.force === true) {
    const prepared =
      language === undefined
        ? plainSource(generatedSource)
        : prepareGeneratedSource(manager, generatedSource, language);
    if (!options.dryRun) {
      await output.writeFile(relativePath, prepared.content, { overwrite: true });
    }
    return {
      path: relativePath,
      status: 'overwritten',
      ...(language === undefined ? {} : { language }),
      decisions: prepared.decisions,
      conflicts: prepared.conflicts,
      warnings: prepared.warnings,
    };
  }

  if (language === undefined) {
    return existingSource === generatedSource
      ? unchanged(relativePath)
      : preserved(
          relativePath,
          'The file type does not support protected regions. Use --force to replace it.',
        );
  }

  const generatedRegions = manager.parse(generatedSource, { language }).regions;
  if (generatedRegions.length === 0) {
    return existingSource === generatedSource
      ? unchanged(relativePath)
      : preserved(
          relativePath,
          'The template has no protected regions. Use --force to replace the file.',
        );
  }

  const existingRegions = manager.parse(existingSource, { language }).regions;
  if (existingRegions.length === 0) {
    return preserved(
      relativePath,
      'The existing file has no protected regions. Use --force to adopt the new template.',
    );
  }

  const merged = manager.merge(existingSource, generatedSource, {
    language,
    ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
    ...(options.strategies === undefined ? {} : { strategies: options.strategies }),
  });

  if (!merged.writable) {
    return {
      path: relativePath,
      status: 'conflict',
      language,
      decisions: merged.decisions,
      conflicts: merged.conflicts,
      warnings: merged.warnings,
      reason: `Protected region conflict: ${merged.conflicts.map((conflict) => conflict.id).join(', ')}.`,
    };
  }

  if (merged.content === existingSource) {
    return {
      path: relativePath,
      status: 'unchanged',
      language,
      decisions: merged.decisions,
      conflicts: merged.conflicts,
      warnings: merged.warnings,
    };
  }

  if (!options.dryRun) {
    await output.writeFile(relativePath, merged.content, { overwrite: true });
  }

  return {
    path: relativePath,
    status: 'updated',
    language,
    decisions: merged.decisions,
    conflicts: merged.conflicts,
    warnings: merged.warnings,
  };
}

interface PreparedSource {
  content: string;
  decisions: ProtectedRegionDecision[];
  conflicts: ProtectedRegionConflict[];
  warnings: ProtectedRegionWarning[];
}

/**
 * Adds the checksums that freshly rendered template markers intentionally omit.
 * Merging an empty file uses the same code path as a real regeneration, which
 * keeps marker formatting identical between the first and later runs.
 */
function prepareGeneratedSource(
  manager: ProtectedRegionManager,
  generatedSource: string,
  language: ProtectedRegionLanguage,
): PreparedSource {
  resolveProtectedRegionLanguage({ language });
  const prepared = manager.merge('', generatedSource, { language });
  return {
    content: prepared.content,
    decisions: prepared.decisions,
    conflicts: prepared.conflicts,
    warnings: prepared.warnings,
  };
}

function plainSource(content: string): PreparedSource {
  return { content, decisions: [], conflicts: [], warnings: [] };
}

function unchanged(path: string): GeneratedFileResult {
  return { path, status: 'unchanged', decisions: [], conflicts: [], warnings: [] };
}

function preserved(path: string, reason: string): GeneratedFileResult {
  return {
    path,
    status: 'preserved',
    decisions: [],
    conflicts: [],
    warnings: [],
    reason,
  };
}
