import { EntityConfigSchema, ProjectConfigSchema, type EntityConfig } from './config.js';
import { buildEntityModels, type EntityModel } from './entity-model.js';
import { FileSystemService } from '../utils/file-system.js';
import { CleanStackError, formatZodError } from '../utils/errors.js';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export { formatZodError } from '../utils/errors.js';

export interface EntityParserOptions {
  /** Root directory used to resolve descriptor paths. Defaults to the current directory. */
  rootDir?: string;
  /** Inject an existing filesystem service, for example one with a mock adapter. */
  fileSystem?: FileSystemService;
}

export class EntityParserError extends CleanStackError {
  readonly descriptorPath: string;

  constructor(descriptorPath: string, detail: string, cause?: unknown, suggestions: string[] = []) {
    super(`Unable to parse entity descriptor "${descriptorPath}":\n${detail}`, {
      cause,
      suggestions,
    });
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
      throw new EntityParserError(filePath, 'expected a .yaml, .yml, or .json file.', undefined, [
        'Rename the descriptor with a supported extension or pass --field options instead.',
      ]);
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
        [
          extension === '.json'
            ? 'Check the JSON syntax near the position reported above.'
            : 'Check the YAML indentation and use "key: value" syntax.',
        ],
      );
    }

    const result = EntityConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new EntityParserError(filePath, formatZodError(result.error), result.error, [
        'See docs/entity-descriptor.md for the supported fields, types, and relations.',
      ]);
    }
    return result.data;
  }

  /** Reads every supported descriptor under a directory and returns normalized entity models. */
  async parseDirectory(directory = 'entities'): Promise<EntityModel[]> {
    return buildEntityModels(await this.parseDirectoryConfigs(directory));
  }

  /** Reads every supported descriptor under a directory as validated configs. */
  async parseDirectoryConfigs(directory = 'entities'): Promise<EntityConfig[]> {
    const supportedFiles = (await this.fileSystem.listFiles(directory))
      .filter((filePath) =>
        ['.yaml', '.yml', '.json'].includes(path.extname(filePath).toLowerCase()),
      )
      .map((filePath) => path.posix.join(directory, filePath));
    return this.parseFileConfigs(supportedFiles);
  }

  /** Parses a descriptor set together so duplicate names and relation targets can be checked. */
  async parseFiles(filePaths: string[]): Promise<EntityModel[]> {
    return buildEntityModels(await this.parseFileConfigs(filePaths));
  }

  /** Parses and validates a descriptor set without building template models. */
  async parseFileConfigs(filePaths: string[]): Promise<EntityConfig[]> {
    const entities = await Promise.all(filePaths.map((filePath) => this.parseFile(filePath)));
    try {
      return ProjectConfigSchema.parse({ name: 'entity-descriptors', entities }).entities;
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      throw new EntityParserError('entity descriptors', formatZodError(error), error, [
        'Check for duplicate entity or field names and verify that every relation target exists.',
      ]);
    }
  }
}
