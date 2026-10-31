import { EntityConfigSchema, ProjectConfigSchema, type EntityConfig } from './config.js';
import { buildEntityModels, type EntityModel } from './entity-model.js';
import { FileSystemService } from '../utils/file-system.js';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface EntityParserOptions {
  /** Root directory used to resolve descriptor paths. Defaults to the current directory. */
  rootDir?: string;
  /** Inject an existing filesystem service, for example one with a mock adapter. */
  fileSystem?: FileSystemService;
}

export class EntityParserError extends Error {
  readonly descriptorPath: string;

  constructor(descriptorPath: string, detail: string, cause?: unknown) {
    super(`Unable to parse entity descriptor "${descriptorPath}": ${detail}`, { cause });
    this.name = 'EntityParserError';
    this.descriptorPath = descriptorPath;
  }
}

/** Reads entity descriptors, validates cross-entity relations, and builds normalized models. */
export class EntityParser {
  private readonly fileSystem: FileSystemService;

  constructor(options: EntityParserOptions = {}) {
    this.fileSystem =
      options.fileSystem ??
      new FileSystemService(options.rootDir === undefined ? {} : { rootDir: options.rootDir });
  }

  /** Reads and validates a single YAML or JSON descriptor. Relations are resolved by parseFiles. */
  async parseFile(filePath: string): Promise<EntityConfig> {
    const extension = path.extname(filePath).toLowerCase();
    if (!['.yaml', '.yml', '.json'].includes(extension)) {
      throw new EntityParserError(filePath, 'expected a .yaml, .yml, or .json file.');
    }

    const contents = await this.fileSystem.readFile(filePath);
    let raw: unknown;
    try {
      raw = extension === '.json' ? JSON.parse(contents) : parseYaml(contents);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EntityParserError(
        filePath,
        `invalid ${extension.slice(1).toUpperCase()}: ${detail}`,
        error,
      );
    }

    const result = EntityConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new EntityParserError(filePath, formatZodError(result.error), result.error);
    }
    return result.data;
  }

  /** Reads every supported descriptor under a directory and returns normalized entity models. */
  async parseDirectory(directory = 'entities'): Promise<EntityModel[]> {
    const supportedFiles = (await this.fileSystem.listFiles(directory))
      .filter((filePath) =>
        ['.yaml', '.yml', '.json'].includes(path.extname(filePath).toLowerCase()),
      )
      .map((filePath) => path.posix.join(directory, filePath));
    return this.parseFiles(supportedFiles);
  }

  /** Parses a descriptor set together so duplicate names and relation targets can be checked. */
  async parseFiles(filePaths: string[]): Promise<EntityModel[]> {
    const entities = await Promise.all(filePaths.map((filePath) => this.parseFile(filePath)));
    let validated: EntityConfig[];
    try {
      validated = ProjectConfigSchema.parse({ name: 'entity-descriptors', entities }).entities;
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      throw new EntityParserError('entity descriptors', formatZodError(error), error);
    }
    return buildEntityModels(validated);
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${location}${issue.message}`;
    })
    .join('; ');
}
