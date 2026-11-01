import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CliOptionError } from './config-loader.js';
import { EntityConfigSchema } from './config.js';
import { buildEntityModels, type EntityModel } from './entity-model.js';
import { EntityParser, formatZodError } from './entity-parser.js';
import { FileSystemService } from '../utils/file-system.js';

export interface DescriptorResult {
  entity: EntityModel;
  descriptorPath: string;
}

export interface DescriptorSearchOptions {
  name: string;
  cwd: string;
  projectRoot: string;
  /** Explicit descriptor path from --descriptor. */
  descriptor?: string;
}

const DESCRIPTOR_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

/**
 * Loads an entity from an explicit descriptor, or searches the usual
 * entities/ locations for one whose file name or declared name matches.
 */
export async function findEntityDescriptor(
  options: DescriptorSearchOptions,
): Promise<DescriptorResult | undefined> {
  if (options.descriptor !== undefined) {
    const descriptorPath = await resolveDescriptorPath(options);
    const result = await readEntityDescriptor(descriptorPath);
    if (result.entity.name.toLowerCase() !== options.name.toLowerCase()) {
      throw new CliOptionError(
        `Descriptor "${descriptorPath}" defines "${result.entity.name}", not "${options.name}".`,
      );
    }
    return { ...result, descriptorPath };
  }

  for (const directory of descriptorDirectories(options)) {
    const files = await listDescriptorFiles(directory);
    if (files.length === 0) continue;

    const named = files.filter((file) => fileMatchesName(file, options.name));
    for (const file of named) {
      const result = await readEntityDescriptor(file);
      if (result.entity.name.toLowerCase() === options.name.toLowerCase()) {
        return { ...result, descriptorPath: file };
      }
    }

    // Fall back to the declared entity name when the file name does not match.
    for (const file of files) {
      try {
        const result = await readEntityDescriptor(file);
        if (result.entity.name.toLowerCase() === options.name.toLowerCase()) {
          return { ...result, descriptorPath: file };
        }
      } catch {
        // Ignore unrelated descriptors that cannot be parsed.
      }
    }
  }

  return undefined;
}

/** Builds an entity model from --field options. */
export function buildInlineEntity(
  name: string,
  fieldSpecs: string[],
  tableName?: string,
): EntityModel {
  if (fieldSpecs.length === 0) {
    throw new CliOptionError(
      `No descriptor was found for "${name}" and no fields were provided. Add entities/${name}.yaml or pass --field <name:type>.`,
    );
  }

  const raw: Record<string, unknown> = {
    name,
    fields: fieldSpecs.map(parseFieldSpec),
    ...(tableName === undefined ? {} : { tableName }),
  };
  const result = EntityConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new CliOptionError(`Invalid entity definition: ${formatZodError(result.error)}`);
  }

  const [entity] = buildEntityModels([result.data]);
  return entity!;
}

/**
 * Parses one inline field. The shorthand is name:type[:modifier...], where a
 * modifier is required, unique, generated, minLength=, maxLength=, min=, max=,
 * pattern=, validations=NotBlank|Email, or default=.
 * A JSON object can be used instead for full descriptor options.
 */
export function parseFieldSpec(spec: string): FieldConfigInput {
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      return parsed as FieldConfigInput;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliOptionError(`Invalid JSON field definition "${spec}": ${detail}`);
    }
  }

  const [name, type, ...modifiers] = trimmed.split(':');
  if (!name || !type) {
    throw new CliOptionError(
      `Invalid field "${spec}". Use <name>:<type>[:<modifier>...], for example name:String:required.`,
    );
  }

  const field: FieldConfigInput = { name: name.trim(), type: type.trim() };
  for (const modifier of modifiers) {
    const value = modifier.trim();
    if (!value) continue;
    if (value === 'required' || value === 'unique' || value === 'generated') {
      field[value] = true;
      continue;
    }

    const separator = value.indexOf('=');
    if (separator === -1) {
      throw new CliOptionError(
        `Unknown field modifier "${value}". Use required, unique, generated, or key=value.`,
      );
    }
    const key = value.slice(0, separator);
    const rawValue = value.slice(separator + 1);
    switch (key) {
      case 'minLength':
      case 'maxLength':
      case 'min':
      case 'max':
        field[key] = Number(rawValue);
        break;
      case 'pattern':
        field.pattern = rawValue;
        break;
      case 'validations':
        field.validations = rawValue
          .split('|')
          .map((validation) => validation.trim())
          .filter(Boolean);
        break;
      case 'default':
        field.default = parseDefaultValue(rawValue);
        break;
      default:
        throw new CliOptionError(`Unknown field modifier "${key}".`);
    }
  }

  return field;
}

type FieldConfigInput = Record<string, unknown>;

async function readEntityDescriptor(
  descriptorPath: string,
): Promise<{ entity: EntityModel; descriptorPath: string }> {
  const directory = path.dirname(descriptorPath);
  const fileSystem = new FileSystemService({
    rootDir: directory,
    logger: { log: () => {} },
  });
  const parser = new EntityParser({ fileSystem });
  const fileName = path.basename(descriptorPath);
  const raw = await parser.parseFile(fileName);

  if (raw.relations.length === 0) {
    const [entity] = buildEntityModels([raw]);
    return { entity: entity!, descriptorPath };
  }

  const files = (await listDescriptorFiles(directory)).map((file) =>
    path.relative(directory, file).split(path.sep).join('/'),
  );
  const models = await parser.parseFiles(files);
  const entity = models.find((model) => model.name.toLowerCase() === raw.name.toLowerCase());
  if (!entity) {
    throw new CliOptionError(`Could not load entity "${raw.name}" from "${descriptorPath}".`);
  }
  return { entity, descriptorPath };
}

async function resolveDescriptorPath(options: DescriptorSearchOptions): Promise<string> {
  const descriptor = options.descriptor!;
  const candidates = path.isAbsolute(descriptor)
    ? [descriptor]
    : [
        path.resolve(options.cwd, descriptor),
        path.resolve(options.projectRoot, descriptor),
        path.resolve(path.dirname(options.projectRoot), descriptor),
      ];

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }

  throw new CliOptionError(`Descriptor "${descriptor}" was not found.`);
}

function descriptorDirectories(options: DescriptorSearchOptions): string[] {
  const directories = [
    path.join(options.cwd, 'entities'),
    path.join(options.projectRoot, 'entities'),
    path.join(path.dirname(options.projectRoot), 'entities'),
  ];
  return [...new Set(directories.map((directory) => path.resolve(directory)))];
}

async function listDescriptorFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(directory, files);
  return files
    .filter((file) => DESCRIPTOR_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));
}

async function collectFiles(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(entryPath, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
}

function fileMatchesName(file: string, name: string): boolean {
  const base = path.basename(file, path.extname(file)).toLowerCase();
  const candidates = new Set([
    name.toLowerCase(),
    toKebabCase(name),
    toCamelCase(name),
    toSnakeCase(name),
  ]);
  return candidates.has(base);
}

function toKebabCase(value: string): string {
  return words(value).join('-');
}

function toSnakeCase(value: string): string {
  return words(value).join('_');
}

function toCamelCase(value: string): string {
  return words(value)
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('');
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function parseDefaultValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
