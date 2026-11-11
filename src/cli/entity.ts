import path from 'node:path';
import { JAVA_PACKAGE_PATTERN, type EntityConfig, type ProjectConfig } from '../core/config.js';
import { CliOptionError } from '../core/config-loader.js';
import { buildEntityModels, type EntityModel } from '../core/entity-model.js';
import {
  buildInlineEntityConfig,
  findEntityDescriptor,
  missingEntityDescriptorError,
} from '../core/entity-input.js';
import {
  addEntityNavLink,
  addEntityRoutes,
  hasEntityNavLink,
  hasEntityRoutes,
} from '../core/frontend-updates.js';
import { resolveProjectConfig, updateProjectMetadataEntity } from '../core/project-metadata.js';
import { locateGeneratedProject, type GeneratedProject } from '../core/project.js';
import {
  findCreateMigration,
  findPreviousEntityModel,
  generateEntityMigrations,
  isGeneratedEntityMigrationEntry,
  nextMigrationVersion,
  type MigrationTool,
} from '../core/migrations.js';
import type { GeneratedFileResult } from '../core/generated-file.js';
import { renderManifest, templateAliases, type ManifestEntry } from '../templates/manifest.js';
import { TemplateEngine } from '../templates/template-engine.js';
import { FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import type { Logger } from '../utils/logger.js';
import { loadCommandExtensions } from './extensions.js';
import { conflictingFiles, reportGeneratedFiles } from './file-report.js';

export interface EntityCommandOptions {
  cwd?: string;
  logger: Logger;
}

interface EntityCommandArguments {
  name?: string;
  descriptor?: string;
  fields: string[];
  tableName?: string;
  packageName?: string;
  backend?: boolean;
  frontend?: boolean;
  seed?: boolean;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

export const ENTITY_USAGE = `Usage: cleanstack entity <name> [options]
       cleanstack generate entity <name> [options]
       cleanstack g e <name> [options]

Reads entities/<name>.yaml (or .yml / .json), or builds an entity from --field options.

Options:
  -d, --descriptor <path>   Use a specific entity descriptor
  --field <spec>            Inline field: name:type[:required][:maxLength=100]
                            Repeatable. Use a JSON object for advanced options.
  --table <name>            Table name for an inline entity
  --package <name>          Override the detected Java package
  --backend                 Generate backend artifacts only
  --no-backend              Skip backend artifacts
  --frontend                Generate frontend artifacts only
  --no-frontend             Skip frontend artifacts
  --seed                    Generate a sample seed migration for this entity
  --no-seed                 Skip seed data even when the descriptor or project enables it
  --force                   Overwrite generated files completely, including protected regions
  --dry-run                 Show what would change without writing files
  -h, --help                Show this help`;

export interface EntityGenerationOptions {
  project: GeneratedProject;
  entity: EntityModel;
  /** Raw configuration recorded in the project metadata for future regenerations. */
  entityConfig: EntityConfig;
  cwd: string;
  logger: Logger;
  backend?: boolean | undefined;
  frontend?: boolean | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** Overrides the entity and project seed settings for this run. */
  seed?: boolean | undefined;
  /** Previous stored version of the entity, used to build update migrations. */
  previousEntity?: EntityModel | undefined;
  /** Overrides the detected Java package. */
  packageName?: string | undefined;
  /** Already resolved project config; inferred when omitted. */
  metadataConfig?: ProjectConfig | undefined;
  /** Verb for success logs, e.g. "Generated" or "Regenerated". */
  action?: string | undefined;
}

export interface EntityGenerationResult {
  targets: string[];
}

/**
 * Renders the artifacts for one entity into an existing generated project.
 * Shared by `cleanstack entity` and `cleanstack regenerate`.
 */
export async function generateEntityInProject(
  options: EntityGenerationOptions,
): Promise<EntityGenerationResult> {
  const { project, entity, cwd, logger } = options;
  const force = options.force ?? false;
  const dryRun = options.dryRun ?? false;

  const backendAvailable = project.backend !== undefined;
  const frontendAvailable = project.frontend !== undefined;
  const { generateBackend, generateFrontend } = resolveSides(
    { backend: options.backend, frontend: options.frontend },
    backendAvailable,
    frontendAvailable,
  );

  if (!generateBackend && !generateFrontend) {
    throw new CliOptionError('Nothing to generate. Enable the backend or frontend with a flag.');
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

  if (options.packageName !== undefined && !JAVA_PACKAGE_PATTERN.test(options.packageName)) {
    throw new CliOptionError(
      `Option "--package" must be a valid Java package, received "${options.packageName}".`,
    );
  }
  const packageName = options.packageName ?? project.backend?.packageName;
  if (generateBackend && packageName === undefined) {
    throw new CliOptionError(
      'Could not detect the Java package. Pass --package <name> to set it explicitly.',
    );
  }

  const filesystemLogger: FileSystemLogger = {
    log: (action) =>
      logger.debug(`[filesystem] ${action.operation} ${action.path}: ${action.status}`),
  };
  const metadataConfig =
    options.metadataConfig ??
    (await resolveProjectConfig(project, { cwd, logger: filesystemLogger }));
  const previousEntity =
    options.previousEntity ?? findPreviousEntityModel(metadataConfig.entities, entity);

  const projectName = path.basename(project.rootDir);
  const projectConfig: ProjectConfig = {
    name: projectName,
    packageName: packageName ?? metadataConfig.packageName ?? 'com.example',
    entities: [],
    options: {
      ...metadataConfig.options,
      backend: generateBackend,
      frontend: generateFrontend,
      buildTool: project.backend?.buildTool ?? metadataConfig.options.buildTool ?? 'maven',
      dryRun,
      outputDir: '.',
    },
  };
  const engine = new TemplateEngine({ projectRoot: project.workspaceRoot });

  const backendFileSystem = project.backend
    ? new FileSystemService({
        rootDir: project.backend.directory,
        logger: filesystemLogger,
        dryRun,
      })
    : undefined;
  const migrationVersion =
    backendFileSystem === undefined
      ? 2
      : ((
          await findCreateMigration(
            backendFileSystem,
            projectConfig.options.migrationTool,
            entity.tableName,
          )
        )?.version ??
        (await nextMigrationVersion(backendFileSystem, projectConfig.options.migrationTool)));
  const entityContext = { ...entity, migrationVersion };
  const context = {
    project: { ...projectConfig, entities: [entityContext] },
    ...projectConfig,
    entities: [entityContext],
    ...templateAliases(projectConfig),
  } as unknown as Record<string, unknown>;
  const entityEntries = (entry: ManifestEntry): boolean =>
    entry.forEach === 'entities' && !isGeneratedEntityMigrationEntry(entry);

  const backendProject: ProjectConfig | undefined = project.backend
    ? { ...projectConfig, name: path.basename(project.backend.directory) }
    : undefined;
  const frontendProject: ProjectConfig | undefined = project.frontend
    ? { ...projectConfig, name: path.basename(project.frontend.directory) }
    : undefined;
  const frontendFileSystem = project.frontend
    ? new FileSystemService({
        rootDir: project.frontend.directory,
        logger: filesystemLogger,
        dryRun,
      })
    : undefined;

  const generatedFiles: GeneratedFileResult[] = [];
  const onFile = (result: GeneratedFileResult): void => {
    generatedFiles.push(result);
  };

  if (generateBackend && backendFileSystem) {
    await assertRelationTargetsReady({
      entity,
      fileSystem: backendFileSystem,
      migrationTool: projectConfig.options.migrationTool,
    });
  }

  if (generateBackend && backendProject && backendFileSystem) {
    await renderManifest(
      'spring-boot',
      backendProject,
      context,
      engine,
      backendFileSystem,
      filesystemLogger,
      { filter: entityEntries, force, onFile },
    );
    const migrations = await generateEntityMigrations({
      fileSystem: backendFileSystem,
      engine,
      project: backendProject,
      entity,
      ...(previousEntity === undefined ? {} : { previousEntity }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      logger,
    });
    generatedFiles.push(...migrations);
  }

  if (generateFrontend && frontendProject && frontendFileSystem) {
    await renderManifest(
      'angular',
      frontendProject,
      context,
      engine,
      frontendFileSystem,
      filesystemLogger,
      { filter: entityEntries, force, onFile },
    );
    if (!dryRun) {
      await updateFrontendNavigation(frontendFileSystem, entity, logger);
    }
  }

  reportGeneratedFiles(logger, generatedFiles, { dryRun, force });
  if (conflictingFiles(generatedFiles).length > 0) {
    throw new CliOptionError(
      `Regeneration stopped because ${conflictingFiles(generatedFiles).length} file(s) contain protected region conflicts. Resolve them and run the command again, or use --force to replace the files completely.`,
    );
  }

  const metadataOutput = new FileSystemService({
    rootDir: project.rootDir,
    logger: filesystemLogger,
    dryRun,
  });
  await updateProjectMetadataEntity(metadataOutput, metadataConfig, options.entityConfig);

  const targets = [
    generateBackend ? project.backend?.relativeDirectory : undefined,
    generateFrontend ? project.frontend?.relativeDirectory : undefined,
  ].filter((target): target is string => target !== undefined);
  const action = options.action ?? 'Generated';
  if (dryRun) {
    if (action === 'Regenerated') {
      logger.info(`Dry run: ${entity.className} in ${targets.join(' and ')} would be regenerated.`);
    } else {
      logger.info(`Dry run: ${entity.className} was not written to ${targets.join(' and ')}.`);
    }
  } else {
    logger.success(`${action} ${entity.className} in ${targets.join(' and ')}.`);
  }

  return { targets };
}

/**
 * Fails before rendering when an owning relation target has no table. Missing
 * inverse classes are allowed because forward references are resolved as the
 * remaining entities are generated; a foreign key to a missing table is not.
 */
async function assertRelationTargetsReady(options: {
  entity: EntityModel;
  fileSystem: FileSystemService;
  migrationTool: MigrationTool;
}): Promise<void> {
  const { entity, fileSystem, migrationTool } = options;
  const missing = new Set<string>();

  for (const relation of entity.relations) {
    const target = relation.targetEntity;
    if (!relation.owningSide) continue;
    if (target.tableName === entity.tableName) continue;
    if ((await findCreateMigration(fileSystem, migrationTool, target.tableName)) === undefined) {
      missing.add(target.className);
    }
  }

  if (missing.size === 0) return;

  throw new CliOptionError(
    `Cannot generate ${entity.className} because its relation targets have no generated create migration yet: ${[...missing].join(', ')}.`,
    [
      ...[...missing].map((className) => `cleanstack entity ${className}`),
      'Then run this command again.',
    ],
  );
}

export async function runEntityCommand(
  args: string[],
  options: EntityCommandOptions,
): Promise<void> {
  const parsed = parseEntityCommandArguments(args);
  if (parsed.help) {
    options.logger.info(ENTITY_USAGE);
    return;
  }

  const name = parsed.name!;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const project = await locateGeneratedProject({ cwd });
  await loadCommandExtensions({ cwd, projectRoot: project.rootDir, logger: options.logger });

  let entity: EntityModel;
  let entityConfig: EntityConfig;
  let source: string;
  if (parsed.fields.length > 0) {
    entityConfig = buildInlineEntityConfig(name, parsed.fields, parsed.tableName);
    const [model] = buildEntityModels([entityConfig]);
    entity = model!;
    source = 'inline options';
  } else {
    const descriptor = await findEntityDescriptor({
      name,
      cwd,
      projectRoot: project.rootDir,
      ...(parsed.descriptor === undefined ? {} : { descriptor: parsed.descriptor }),
    });
    if (!descriptor) {
      throw await missingEntityDescriptorError({
        name,
        cwd,
        projectRoot: project.rootDir,
        ...(parsed.descriptor === undefined ? {} : { descriptor: parsed.descriptor }),
      });
    }
    entity = descriptor.entity;
    entityConfig = descriptor.config;
    source = descriptor.descriptorPath;
  }

  if (parsed.seed !== undefined) {
    entityConfig = { ...entityConfig, seed: parsed.seed };
    entity = { ...entity, seed: parsed.seed };
  }

  await generateEntityInProject({
    project,
    entity,
    entityConfig,
    cwd,
    logger: options.logger,
    ...(parsed.backend === undefined ? {} : { backend: parsed.backend }),
    ...(parsed.frontend === undefined ? {} : { frontend: parsed.frontend }),
    ...(parsed.packageName === undefined ? {} : { packageName: parsed.packageName }),
    ...(parsed.seed === undefined ? {} : { seed: parsed.seed }),
    force: parsed.force,
    dryRun: parsed.dryRun,
  });

  options.logger.info(`Entity source: ${source}`);
}

/** Parses entity-command arguments into a small, testable shape. */
export function parseEntityCommandArguments(args: string[]): EntityCommandArguments {
  const result: EntityCommandArguments = {
    fields: [],
    force: false,
    dryRun: false,
    help: false,
  };
  const positionals: string[] = [];

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
      case '--seed':
        result.seed = parseBooleanFlag(flag, inlineValue, true);
        break;
      case '--no-seed':
        rejectValue(flag, inlineValue);
        if (result.seed === true) {
          throw new CliOptionError('Options "--seed" and "--no-seed" cannot be combined.');
        }
        result.seed = false;
        break;
      case '--descriptor':
      case '-d': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.descriptor = value;
        index = nextIndex;
        break;
      }
      case '--field': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.fields.push(value);
        index = nextIndex;
        break;
      }
      case '--table':
      case '--table-name': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.tableName = value;
        index = nextIndex;
        break;
      }
      case '--package': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.packageName = value;
        index = nextIndex;
        break;
      }
      default:
        throw new CliOptionError(`Unknown option "${flag}" for the entity command.`);
    }
  }

  if (positionals.length > 1) {
    throw new CliOptionError(`Unexpected argument "${positionals[1]}".`);
  }
  if (positionals[0] !== undefined) result.name = positionals[0];

  if (result.help) return result;
  if (result.name === undefined || result.name.trim() === '') {
    throw new CliOptionError(
      'An entity name is required. Usage: cleanstack entity <name> [options]',
    );
  }
  if (result.descriptor !== undefined && result.fields.length > 0) {
    throw new CliOptionError('Use either --descriptor or --field options, not both.');
  }
  if (result.tableName !== undefined && result.fields.length === 0) {
    throw new CliOptionError('Option "--table" requires at least one --field.');
  }

  return result;
}

async function updateFrontendNavigation(
  fileSystem: FileSystemService,
  entity: EntityModel,
  logger: Logger,
): Promise<void> {
  const routesPath = 'src/app/app.routes.ts';
  if (await fileSystem.exists(routesPath)) {
    const routes = await fileSystem.readFile(routesPath);
    if (hasEntityRoutes(routes, entity)) {
      logger.debug(`Route for ${entity.routeName} already exists.`);
    } else {
      await fileSystem.writeFile(routesPath, addEntityRoutes(routes, entity), { overwrite: true });
    }
  } else {
    logger.warn(`Could not find ${routesPath}; add the ${entity.routeName} route manually.`);
  }

  const layoutPath = 'src/app/layout/app-layout/app-layout.component.html';
  if (await fileSystem.exists(layoutPath)) {
    const layout = await fileSystem.readFile(layoutPath);
    if (hasEntityNavLink(layout, entity)) {
      logger.debug(`Navigation link for ${entity.routeName} already exists.`);
    } else {
      await fileSystem.writeFile(layoutPath, addEntityNavLink(layout, entity), {
        overwrite: true,
      });
    }
  } else {
    logger.warn(
      `Could not find ${layoutPath}; add the ${entity.routeName} navigation link manually.`,
    );
  }
}

function resolveSides(
  sides: { backend?: boolean | undefined; frontend?: boolean | undefined },
  backendAvailable: boolean,
  frontendAvailable: boolean,
): { generateBackend: boolean; generateFrontend: boolean } {
  const wantsBackend = sides.backend === true;
  const wantsFrontend = sides.frontend === true;

  if (wantsBackend || wantsFrontend) {
    return { generateBackend: wantsBackend, generateFrontend: wantsFrontend };
  }

  return {
    generateBackend: sides.backend === false ? false : backendAvailable,
    generateFrontend: sides.frontend === false ? false : frontendAvailable,
  };
}

function setSide(
  result: EntityCommandArguments,
  side: 'backend' | 'frontend',
  value: boolean,
): void {
  const current = result[side];
  if (current !== undefined && current !== value) {
    throw new CliOptionError(`Options "--${side}" and "--no-${side}" cannot be combined.`);
  }
  result[side] = value;
}

function readValue(
  flag: string,
  inlineValue: string | undefined,
  args: string[],
  index: number,
): [string, number] {
  if (inlineValue !== undefined) return [inlineValue, index];

  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new CliOptionError(`Option "${flag}" requires a value.`);
  }
  return [next, index + 1];
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
