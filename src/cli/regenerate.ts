import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ProjectConfigSchema, type EntityConfig, type ProjectConfig } from '../core/config.js';
import { CliOptionError } from '../core/config-loader.js';
import type { GeneratedFileResult } from '../core/generated-file.js';
import { buildEntityModels } from '../core/entity-model.js';
import { EntityParser, formatZodError } from '../core/entity-parser.js';
import { resolveProjectConfig, writeProjectMetadata } from '../core/project-metadata.js';
import { locateGeneratedProject, type GeneratedProject } from '../core/project.js';
import { renderManifest, templateContext, type ManifestEntry } from '../templates/manifest.js';
import { TemplateEngine } from '../templates/template-engine.js';
import { FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import type { Logger } from '../utils/logger.js';
import { generateEntityInProject } from './entity.js';
import { conflictingFiles, reportGeneratedFiles } from './file-report.js';

export interface RegenerateCommandOptions {
  cwd?: string;
  logger: Logger;
}

interface RegenerateCommandArguments {
  target: 'project' | 'all' | 'entity';
  entityName?: string;
  backend?: boolean;
  frontend?: boolean;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

export const REGENERATE_USAGE = `Usage: cleanstack regenerate [options]
       cleanstack regenerate entity <name> [options]
       cleanstack regenerate --all [options]

Regenerates generated files while preserving code inside protected regions.
Without a target, only project skeleton files are regenerated. --all also
regenerates every entity found in project metadata, configuration, and entities/.

Options:
  --all                     Regenerate the project and every known entity
  --backend                 Regenerate backend artifacts only
  --no-backend              Skip backend artifacts
  --frontend                Regenerate frontend artifacts only
  --no-frontend             Skip frontend artifacts
  --force                   Overwrite generated files completely, including protected regions
  --dry-run                 Show what would change without writing files
  -h, --help                Show this help`;

export async function runRegenerateCommand(
  args: string[],
  options: RegenerateCommandOptions,
): Promise<void> {
  const parsed = parseRegenerateCommandArguments(args);
  if (parsed.help) {
    options.logger.info(REGENERATE_USAGE);
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const project = await locateGeneratedProject({ cwd });
  const baseConfig = await resolveProjectConfig(project, { cwd });
  const config = await withDiscoveredEntities(project, baseConfig, cwd);
  const models = buildEntityModels(config.entities);

  if (parsed.target === 'entity') {
    const name = parsed.entityName!;
    const entityConfig = config.entities.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    const entity = models.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (entityConfig === undefined || entity === undefined) {
      const known = config.entities.map((candidate) => candidate.name).sort();
      throw new CliOptionError(
        `No entity named "${name}" was found in this project.${
          known.length > 0 ? ` Known entities: ${known.join(', ')}.` : ''
        }`,
      );
    }

    await generateEntityInProject({
      project,
      entity,
      entityConfig,
      metadataConfig: config,
      cwd,
      logger: options.logger,
      ...(parsed.backend === undefined ? {} : { backend: parsed.backend }),
      ...(parsed.frontend === undefined ? {} : { frontend: parsed.frontend }),
      force: parsed.force,
      dryRun: parsed.dryRun,
      action: 'Regenerated',
    });
    return;
  }

  const { generateBackend, generateFrontend } = resolveSides(parsed, project);
  if (!generateBackend && !generateFrontend) {
    throw new CliOptionError('Nothing to regenerate. Enable the backend or frontend with a flag.');
  }
  if (generateBackend && !project.backend) {
    throw new CliOptionError(
      'No Spring Boot project was found. Remove --backend or run inside a generated backend project.',
    );
  }
  if (generateFrontend && !project.frontend) {
    throw new CliOptionError(
      'No Angular project was found. Remove --frontend or run inside a generated frontend project.',
    );
  }

  const engine = new TemplateEngine({ projectRoot: project.workspaceRoot });
  const filesystemLogger: FileSystemLogger = {
    log: (action) =>
      options.logger.debug(`[filesystem] ${action.operation} ${action.path}: ${action.status}`),
  };
  const generatedFiles: GeneratedFileResult[] = [];
  const onFile = (result: GeneratedFileResult): void => {
    generatedFiles.push(result);
  };
  const filter = (entry: ManifestEntry): boolean =>
    parsed.target === 'all' ? true : entry.forEach !== 'entities';

  // Pin migration numbers to the versions already on disk so --all cannot
  // renumber migrations when entities were generated in a different order.
  const migrationVersions = await detectExistingMigrationVersions(project, filesystemLogger);

  if (generateBackend && project.backend) {
    await renderManifest(
      'spring-boot',
      { ...config, name: path.basename(project.backend.directory) },
      templateContext(
        {
          ...config,
          name: path.basename(project.backend.directory),
        },
        migrationVersions,
      ),
      engine,
      new FileSystemService({
        rootDir: project.backend.directory,
        logger: filesystemLogger,
        dryRun: parsed.dryRun,
      }),
      filesystemLogger,
      { filter, force: parsed.force, onFile },
    );
  }

  if (generateFrontend && project.frontend) {
    await renderManifest(
      'angular',
      { ...config, name: path.basename(project.frontend.directory) },
      templateContext(
        {
          ...config,
          name: path.basename(project.frontend.directory),
        },
        migrationVersions,
      ),
      engine,
      new FileSystemService({
        rootDir: project.frontend.directory,
        logger: filesystemLogger,
        dryRun: parsed.dryRun,
      }),
      filesystemLogger,
      { filter, force: parsed.force, onFile },
    );
  }

  reportGeneratedFiles(options.logger, generatedFiles, {
    dryRun: parsed.dryRun,
    force: parsed.force,
  });
  if (conflictingFiles(generatedFiles).length > 0) {
    throw new CliOptionError(
      `Regeneration stopped because ${conflictingFiles(generatedFiles).length} file(s) contain protected region conflicts. Resolve them and run the command again, or use --force to replace the files completely.`,
    );
  }

  const metadataOutput = new FileSystemService({
    rootDir: project.rootDir,
    logger: filesystemLogger,
    dryRun: parsed.dryRun,
  });
  await writeProjectMetadata(metadataOutput, config);

  const targets = [
    generateBackend ? project.backend?.relativeDirectory : undefined,
    generateFrontend ? project.frontend?.relativeDirectory : undefined,
  ].filter((target): target is string => target !== undefined);
  const scope =
    parsed.target === 'all'
      ? `the project and ${config.entities.length} entit${config.entities.length === 1 ? 'y' : 'ies'}`
      : 'the project skeleton';
  if (parsed.dryRun) {
    options.logger.info(`Dry run: ${scope} in ${targets.join(' and ')} would be regenerated.`);
  } else {
    options.logger.success(`Regenerated ${scope} in ${targets.join(' and ')}.`);
  }
}

/** Parses regenerate-command arguments into a small, testable shape. */
export function parseRegenerateCommandArguments(args: string[]): RegenerateCommandArguments {
  const result: RegenerateCommandArguments = {
    target: 'project',
    force: false,
    dryRun: false,
    help: false,
  };
  const positionals: string[] = [];
  let all = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }

    const [flag, inlineValue] = splitOption(token);
    switch (flag) {
      case '--help':
      case '-h':
        rejectValue(flag, inlineValue);
        result.help = true;
        break;
      case '--verbose':
      case '-v':
      case '--quiet':
      case '-q':
        break;
      case '--all':
        all = parseBooleanFlag(flag, inlineValue, true);
        break;
      case '--force':
        result.force = parseBooleanFlag(flag, inlineValue, true);
        break;
      case '--dry-run':
        result.dryRun = parseBooleanFlag(flag, inlineValue, true);
        break;
      case '--backend':
        setSide(result, 'backend', parseBooleanFlag(flag, inlineValue, true));
        break;
      case '--no-backend':
        rejectValue(flag, inlineValue);
        setSide(result, 'backend', false);
        break;
      case '--frontend':
        setSide(result, 'frontend', parseBooleanFlag(flag, inlineValue, true));
        break;
      case '--no-frontend':
        rejectValue(flag, inlineValue);
        setSide(result, 'frontend', false);
        break;
      default:
        throw new CliOptionError(`Unknown option "${flag}" for the regenerate command.`);
    }
  }

  if (result.help) return result;

  if (all && positionals.length > 0) {
    throw new CliOptionError('Use either "--all" or an entity target, not both.');
  }
  if (all) {
    result.target = 'all';
    return result;
  }

  if (positionals.length === 0) return result;
  if (positionals[0] !== 'entity') {
    throw new CliOptionError(
      `Unknown regenerate target "${positionals[0]}". Use "cleanstack regenerate", "cleanstack regenerate entity <name>", or "cleanstack regenerate --all".`,
    );
  }
  if (positionals.length === 1) {
    throw new CliOptionError(
      'An entity name is required. Usage: cleanstack regenerate entity <name>',
    );
  }
  if (positionals.length > 2) {
    throw new CliOptionError(`Unexpected argument "${positionals[2]}".`);
  }

  result.target = 'entity';
  result.entityName = positionals[1]!;
  return result;
}

async function withDiscoveredEntities(
  project: GeneratedProject,
  baseConfig: ProjectConfig,
  cwd: string,
): Promise<ProjectConfig> {
  const byName = new Map(baseConfig.entities.map((entity) => [entity.name.toLowerCase(), entity]));
  for (const directory of descriptorDirectories(project, cwd)) {
    for (const entity of await parseDescriptorDirectory(directory)) {
      byName.set(entity.name.toLowerCase(), entity);
    }
  }

  const result = ProjectConfigSchema.safeParse({
    ...baseConfig,
    entities: [...byName.values()],
  });
  if (!result.success) {
    throw new CliOptionError(`Invalid entity definitions:\n${formatZodError(result.error)}`, [
      'Check the entity descriptors in entities/ and the project configuration.',
      'Run "cleanstack regenerate --dry-run" after fixing the listed fields.',
    ]);
  }
  return result.data;
}

function descriptorDirectories(project: GeneratedProject, cwd: string): string[] {
  const candidates = [
    path.join(project.rootDir, 'entities'),
    path.join(path.dirname(project.rootDir), 'entities'),
    path.join(cwd, 'entities'),
    path.join(project.workspaceRoot, 'entities'),
  ];
  return [...new Set(candidates.map((directory) => path.resolve(directory)))];
}

async function parseDescriptorDirectory(directory: string): Promise<EntityConfig[]> {
  if (!(await isDirectory(directory))) return [];
  const parser = new EntityParser({
    rootDir: directory,
    fileSystem: new FileSystemService({
      rootDir: directory,
      logger: { log: () => {} },
    }),
  });
  return parser.parseDirectoryConfigs('.');
}

function resolveSides(
  parsed: RegenerateCommandArguments,
  project: GeneratedProject,
): { generateBackend: boolean; generateFrontend: boolean } {
  const wantsBackend = parsed.backend === true;
  const wantsFrontend = parsed.frontend === true;

  if (wantsBackend || wantsFrontend) {
    return { generateBackend: wantsBackend, generateFrontend: wantsFrontend };
  }

  return {
    generateBackend: parsed.backend === false ? false : project.backend !== undefined,
    generateFrontend: parsed.frontend === false ? false : project.frontend !== undefined,
  };
}

function setSide(
  result: RegenerateCommandArguments,
  side: 'backend' | 'frontend',
  value: boolean,
): void {
  const current = result[side];
  if (current !== undefined && current !== value) {
    throw new CliOptionError(`Options "--${side}" and "--no-${side}" cannot be combined.`);
  }
  result[side] = value;
}

function splitOption(token: string): [string, string | undefined] {
  const separator = token.indexOf('=');
  if (separator === -1) return [token, undefined];
  return [token.slice(0, separator), token.slice(separator + 1)];
}

function parseBooleanFlag(flag: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliOptionError(`Option "${flag}" expects "true" or "false", received "${value}".`);
}

function rejectValue(flag: string, value: string | undefined): void {
  if (value !== undefined) {
    throw new CliOptionError(`Option "${flag}" does not accept a value.`);
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function detectExistingMigrationVersions(
  project: GeneratedProject,
  filesystemLogger: FileSystemLogger,
): Promise<Map<string, number>> {
  const versions = new Map<string, number>();
  if (!project.backend) return versions;

  const fs = new FileSystemService({
    rootDir: project.backend.directory,
    logger: filesystemLogger,
  });
  const directory = 'src/main/resources/db/migration';
  if (!(await fs.exists(directory))) return versions;

  const files = await fs.listFiles(directory, { recursive: false });
  for (const file of files) {
    const match = /^V(\d+)__create_(.+)_table\.sql$/.exec(path.posix.basename(file));
    if (match) {
      const version = Number(match[1]);
      const tableName = match[2]!;
      versions.set(tableName.toLowerCase(), version);
    }
  }
  return versions;
}
