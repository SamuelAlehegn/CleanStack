import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ConfigLoader, findConfigFileInAncestors } from './config-loader.js';
import {
  EntityConfigSchema,
  GenerationOptionsSchema,
  type EntityConfig,
  type GenerationOptions,
  type ProjectConfig,
} from './config.js';
import { formatZodError } from './entity-parser.js';
import type { GeneratedProject } from './project.js';
import { FileSystemService, type FileSystemLogger } from '../utils/file-system.js';

/** Project-relative path of the generation metadata written by `cleanstack new`. */
export const PROJECT_METADATA_PATH = '.cleanstack/project.json';

/**
 * Lenient project config schema for reading stored metadata.
 *
 * The strict `ProjectConfigSchema` validates that every relation target exists
 * in the same entity list. That check is inappropriate for persisted metadata
 * because entities are added one at a time: a Category with a relation to
 * Product is written before Product is itself stored, so the file temporarily
 * contains forward references.
 */
const StoredProjectConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    packageName: z.string().trim().default('com.example'),
    entities: z.array(EntityConfigSchema).default([]),
    options: GenerationOptionsSchema,
  })
  .strict();

const ProjectMetadataSchema = z
  .object({
    version: z.literal(1),
    config: StoredProjectConfigSchema,
  })
  .strict();

/**
 * Reads the generation metadata stored in a generated project. Metadata keeps
 * the options used to create the project so `regenerate` does not have to
 * guess at them from the generated files.
 */
export async function readProjectMetadata(projectRoot: string): Promise<ProjectConfig | undefined> {
  const filePath = path.join(projectRoot, PROJECT_METADATA_PATH);
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read project metadata from ${filePath}: ${detail}`);
  }

  const result = ProjectMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid project metadata in ${filePath}: ${formatZodError(result.error)}`);
  }
  // Cast: StoredProjectConfigSchema is intentionally permissive (it allows
  // relation targets that haven't been stored yet). The caller treats the
  // returned value as a ProjectConfig for rendering only — Zod cross-entity
  // relation checks run again at generation time when the full entity set is
  // available.
  return result.data.config as unknown as ProjectConfig;
}

/** Writes generation metadata, skipping the write when the content is unchanged. */
export async function writeProjectMetadata(
  output: FileSystemService,
  config: ProjectConfig,
): Promise<void> {
  const contents = `${JSON.stringify({ version: 1, config: normalizeConfig(config) }, null, 2)}\n`;
  if (await output.exists(PROJECT_METADATA_PATH)) {
    const existing = await output.readFile(PROJECT_METADATA_PATH);
    if (existing === contents) return;
  } else if (!output.dryRun) {
    await output.createDirectory(path.posix.dirname(PROJECT_METADATA_PATH));
  }
  await output.writeFile(PROJECT_METADATA_PATH, contents, { overwrite: true });
}

/** Adds or replaces one entity in the stored generation metadata. */
export async function updateProjectMetadataEntity(
  output: FileSystemService,
  baseConfig: ProjectConfig,
  entity: EntityConfig,
): Promise<void> {
  const entities = baseConfig.entities.filter(
    (candidate) => candidate.name.toLowerCase() !== entity.name.toLowerCase(),
  );
  entities.push(entity);
  await writeProjectMetadata(output, { ...baseConfig, entities });
}

/**
 * Resolves the options used to generate a project. Stored metadata wins, then a
 * nearby configuration file, and finally the generated files themselves.
 */
export async function resolveProjectConfig(
  project: GeneratedProject,
  options: { cwd?: string; logger?: FileSystemLogger } = {},
): Promise<ProjectConfig> {
  const metadata = await readProjectMetadata(project.rootDir);
  if (metadata !== undefined) {
    return normalizeConfig({ ...metadata, name: path.basename(project.rootDir) });
  }

  const configPath = await findConfigFileInAncestors(options.cwd ?? project.rootDir);
  if (configPath !== undefined) {
    const loaded = await new ConfigLoader().loadDefaults({
      cwd: path.dirname(configPath),
      configPath,
    });
    return normalizeConfig({
      ...loaded,
      name: path.basename(project.rootDir),
      options: { ...loaded.options, outputDir: '.', dryRun: false },
    });
  }

  return inferProjectConfig(project, options.logger);
}

/** Detects generation options from the files in an existing generated project. */
export async function inferProjectConfig(
  project: GeneratedProject,
  filesystemLogger?: FileSystemLogger,
): Promise<ProjectConfig> {
  const backend = project.backend;
  let database: GenerationOptions['database'] = 'postgresql';
  let auth: GenerationOptions['auth'] = 'none';
  let docker = false;

  if (backend !== undefined) {
    const resources = path.join(backend.directory, 'src', 'main', 'resources');
    const application = await readOptional(path.join(resources, 'application.yml'));
    const development = await readOptional(path.join(resources, 'application-dev.yml'));
    const configuration = `${application}\n${development}`;
    if (/jdbc:h2/i.test(configuration)) database = 'h2';
    else if (/jdbc:mysql/i.test(configuration)) database = 'mysql';

    const fileSystem = new FileSystemService({
      rootDir: backend.directory,
      logger: filesystemLogger ?? { log: () => {} },
    });
    const javaFiles = await fileSystem.listFiles('src/main/java');
    const securityFile = javaFiles.find((file) => file.endsWith('SecurityConfig.java'));
    if (securityFile !== undefined) {
      const security = await fileSystem.readFile(securityFile);
      auth = /keycloak|issuer-uri/i.test(`${configuration}\n${security}`) ? 'keycloak' : 'jwt';
    }

    docker =
      (await isFile(path.join(backend.directory, 'Dockerfile'))) ||
      (await isFile(path.join(backend.directory, 'docker-compose.yml')));
  }

  return normalizeConfig({
    name: path.basename(project.rootDir),
    packageName: backend?.packageName ?? 'com.example',
    entities: [],
    options: {
      backend: backend !== undefined,
      frontend: project.frontend !== undefined,
      database,
      auth,
      buildTool: backend?.buildTool ?? 'maven',
      docker,
      dryRun: false,
      outputDir: '.',
    },
  });
}

/** Validates and normalizes persisted options before they are written or reused. */
function normalizeConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    options: GenerationOptionsSchema.parse({ ...config.options, dryRun: false }),
  };
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingPath(error)) return '';
    throw error;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
