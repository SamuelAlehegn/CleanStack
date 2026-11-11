import type { GeneratedFileResult } from '../core/generated-file.js';
import type { Logger } from '../utils/logger.js';

export interface FileReportOptions {
  dryRun: boolean;
  force: boolean;
}

/**
 * Prints what the generator did, or would do in dry-run mode. Per-file lines
 * stay at debug level during a real run so `new` and `entity` end with a short
 * summary; dry-run keeps them visible because inspecting each change is the
 * purpose of that mode.
 */
export function reportGeneratedFiles(
  logger: Logger,
  results: readonly GeneratedFileResult[],
  options: FileReportOptions,
): void {
  const counts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    overwritten: 0,
    preserved: 0,
    conflict: 0,
  };

  for (const result of results) {
    counts[result.status] += 1;
    const details = describeDecisions(result);
    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';

    if (result.status === 'unchanged') {
      logger.debug(`unchanged ${result.path}`);
      continue;
    }

    if (result.status === 'preserved') {
      logger.warn(
        `${options.dryRun ? 'would preserve' : 'preserved'} ${result.path}: ${result.reason ?? 'existing content was kept.'}`,
      );
      continue;
    }

    if (result.status === 'conflict') {
      logger.error(
        `${options.dryRun ? 'would conflict' : 'conflict'} ${result.path}: ${result.reason ?? 'protected region conflict.'}`,
      );
      continue;
    }

    const prefix = options.dryRun ? 'would ' : '';
    const verb =
      result.status === 'created' ? 'create' : result.status === 'updated' ? 'update' : 'overwrite';
    const line = `${prefix}${verb} ${result.path}${suffix}`;
    if (options.dryRun) {
      logger.info(line);
    } else {
      logger.debug(line);
    }
  }

  for (const warning of results.flatMap((result) =>
    result.warnings.map((item) => ({ path: result.path, ...item })),
  )) {
    logger.warn(`${warning.path}: ${warning.message}`);
  }

  if (options.dryRun) {
    logger.info(
      `Dry run: ${counts.created} to create, ${counts.updated} to update, ${counts.overwritten} to overwrite, ${counts.unchanged} unchanged, ${counts.preserved} preserved, ${counts.conflict} conflicted.`,
    );
    return;
  }

  const changed = counts.created + counts.updated + counts.overwritten;
  if (changed > 0) {
    logger.info(
      `Files: ${counts.created} created, ${counts.updated} updated, ${counts.overwritten} overwritten, ${counts.unchanged} unchanged.`,
    );
  } else if (counts.preserved === 0 && counts.conflict === 0) {
    logger.info('Files: no changes.');
  }
}

/** Returns conflicting paths, for callers that need a non-zero exit code. */
export function conflictingFiles(results: readonly GeneratedFileResult[]): GeneratedFileResult[] {
  return results.filter((result) => result.status === 'conflict');
}

function describeDecisions(result: GeneratedFileResult): string[] {
  return result.decisions
    .filter((decision) => decision.status !== 'unchanged' && decision.status !== 'added')
    .map((decision) => `${decision.id}: ${decision.status}`);
}
