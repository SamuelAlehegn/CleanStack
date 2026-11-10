import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { register as registerTsx } from 'tsx/esm/api';
import { ConfigLoader, type ConfigInput } from '../config-loader.js';
import { CleanStackError } from '../../utils/errors.js';
import { ExtensionRegistrySet, setActiveRegistry } from './registry.js';
import type { CleanStackExtension, ExtensionRegistry } from './types.js';

const EXTENSION_DIRECTORY = '.cleanstack/extensions';
const EXTENSION_FILE_PATTERN = /\.(mjs|js|cjs|mts|ts|cts)$/i;
const SEARCH_DEPTH = 4;

/** Raised when an extension module cannot be loaded or does not follow the contract. */
export class ExtensionError extends CleanStackError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, { suggestions });
    this.name = 'ExtensionError';
  }
}

export interface LoadedExtension {
  /** Name declared by the extension module. */
  name: string;
  /** Where the extension was loaded from; passed to `import()`, or the file path. */
  source: string;
  /** Field types the extension registered. */
  fieldTypes: string[];
  /** Frontend frameworks the extension registered. */
  frontendFrameworks: string[];
}

export interface LoadExtensionsOptions {
  /** Directory that config-file specifiers resolve from. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra anchor searched for `.cleanstack/extensions/`, for example the generated project root. */
  projectRoot?: string;
  /** Pre-resolved configuration input; when omitted the nearby config file is read. */
  config?: ConfigInput;
  /** Module specifiers added on top of the config file and the discovery directory. */
  extensions?: readonly string[];
}

export interface LoadExtensionsResult {
  /** Registry describing every discovered capability; also made active. */
  registry: ExtensionRegistry;
  /** Extensions applied during this load, in load order. */
  extensions: LoadedExtension[];
}

interface ExtensionRequest {
  specifier: string;
  source: string;
  /** Directory relative specifiers resolve from. */
  baseDir: string;
}

/**
 * Discovers, imports, and registers extensions, then activates the resulting
 * registry so descriptor parsing and generation consult it.
 *
 * Sources:
 * - the `extensions` array of `cleanstack.config.*` / `.cleanstackrc*`
 * - extra specifiers given by the caller (for example a future CLI flag)
 * - `.cleanstack/extensions/*` files, searched upward from the working
 *   directory (and the project root when given)
 */
export async function loadExtensions(
  options: LoadExtensionsOptions = {},
): Promise<LoadExtensionsResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const registry = new ExtensionRegistrySet();

  const requests: ExtensionRequest[] = [
    ...(options.config === undefined
      ? await configExtensionSpecifiers(cwd)
      : extensionSpecifiersFromConfig(options.config, 'configuration file', cwd)),
    ...(options.extensions ?? []).map((specifier) => ({
      specifier,
      source: 'command line',
      baseDir: cwd,
    })),
    ...(await discoverExtensionFiles(cwd, options.projectRoot)),
  ];

  const extensions: LoadedExtension[] = [];
  for (const request of requests) {
    extensions.push(await applyExtension(request, registry));
  }

  setActiveRegistry(registry);
  return { registry, extensions };
}

/**
 * Reads the `extensions` array from the nearby configuration file. A missing or
 * malformed config file is ignored here; the command's own loader reports it.
 */
async function configExtensionSpecifiers(cwd: string): Promise<ExtensionRequest[]> {
  let config: ConfigInput;
  try {
    config = await new ConfigLoader().resolve({ cwd });
  } catch {
    return [];
  }
  return extensionSpecifiersFromConfig(config, 'configuration file', cwd);
}

/** Validates the `extensions` entry of a configuration input. */
export function extensionSpecifiersFromConfig(
  config: ConfigInput,
  source: string,
  baseDir: string,
): ExtensionRequest[] {
  const value = config.extensions;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ExtensionError(
      'The "extensions" configuration key must be a list of module names or file paths.',
      ['For example: extensions: ["cleanstack-ext-money"]'],
    );
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ExtensionError(
        `The "extensions" configuration key must contain non-empty strings, received ${JSON.stringify(entry)}.`,
      );
    }
    return { specifier: entry.trim(), source, baseDir };
  });
}

/** Finds extension modules in `.cleanstack/extensions/` upward from the anchors. */
async function discoverExtensionFiles(
  cwd: string,
  projectRoot: string | undefined,
): Promise<ExtensionRequest[]> {
  const anchors = [
    path.resolve(cwd),
    ...(projectRoot === undefined ? [] : [path.resolve(projectRoot)]),
  ];
  const roots: string[] = [];
  for (const anchor of anchors) {
    let current = anchor;
    for (let depth = 0; depth <= SEARCH_DEPTH; depth += 1) {
      if (!roots.includes(current)) roots.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const found = new Map<string, string>();
  for (const root of roots) {
    const directory = path.join(root, EXTENSION_DIRECTORY);
    for (const fileName of await listExtensionFiles(directory)) {
      const absolute = path.resolve(directory, fileName);
      if (!found.has(absolute)) {
        found.set(absolute, path.relative(cwd, absolute).split(path.sep).join('/'));
      }
    }
  }
  return [...found.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([absolute, source]) => ({ specifier: absolute, source, baseDir: cwd }));
}

async function listExtensionFiles(directory: string): Promise<string[]> {
  try {
    if (!(await stat(directory)).isDirectory()) return [];
  } catch {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && EXTENSION_FILE_PATTERN.test(entry.name) && !isDefinitionFile(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function isDefinitionFile(name: string): boolean {
  return name.endsWith('.d.ts') || name.startsWith('.');
}

/**
 * Imports one extension module. Bare specifiers resolve through normal Node
 * package resolution; file paths load with TypeScript support, mirroring the
 * way CleanStack loads configuration files.
 */
async function importExtension(request: ExtensionRequest): Promise<unknown> {
  const isFilePath =
    request.specifier.startsWith('./') ||
    request.specifier.startsWith('../') ||
    path.isAbsolute(request.specifier) ||
    EXTENSION_FILE_PATTERN.test(request.specifier);
  const target = isFilePath
    ? pathToFileURL(path.resolve(request.baseDir, request.specifier)).href
    : request.specifier;

  const unregister = registerTsx();
  try {
    return await import(target);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExtensionError(
      `Unable to load the extension "${request.specifier}" (${request.source}): ${detail}`,
      [
        'Check the module name or path. npm extensions must be installed first, for example "npm i cleanstack-ext-money".',
        'Relative file paths are resolved from the project directory and look for exported extensions.',
        'See docs/EXTENSIONS.md for the extension contract.',
      ],
    );
  } finally {
    await unregister();
  }
}

/** Validates an imported module against the extension contract. */
function pickExtensionExport(imported: unknown, source: string): CleanStackExtension {
  const suggestions = [
    'Default-export an object with a "name" and a "register(registry)" function.',
    'See docs/EXTENSIONS.md for the extension contract.',
  ];
  if (typeof imported !== 'object' || imported === null) {
    throw new ExtensionError(
      `The extension at "${source}" must export an object, received ${typeof imported}.`,
      suggestions,
    );
  }

  let value: unknown = imported;
  // Unwrap "default" chains produced by transpilers and namespace objects.
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(value)) break;
    const extension = asExtension(value);
    if (extension !== undefined) return extension;
    value = value.default;
  }
  throw new ExtensionError(
    `The extension at "${source}" did not export a compatible extension.`,
    suggestions,
  );
}

function asExtension(value: unknown): CleanStackExtension | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.register !== 'function') return undefined;
  if (typeof value.name !== 'string' || value.name.trim() === '') return undefined;
  return value as unknown as CleanStackExtension;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Imports, validates, and registers one extension; returns what it contributed. */
async function applyExtension(
  request: ExtensionRequest,
  registry: ExtensionRegistrySet,
): Promise<LoadedExtension> {
  const extension = pickExtensionExport(await importExtension(request), request.source);
  const label = extension.name.trim();
  registry.setOwner(label);
  const previousFieldTypes = registry.fieldTypeNames();
  const previousFrameworks = registry.frontendFrameworks().map((framework) => framework.name);
  try {
    extension.register(registry);
  } catch (error) {
    if (error instanceof CleanStackError) {
      throw new ExtensionError(
        `Extension "${label}" (${request.source}): ${error.message}`,
        error.suggestions,
      );
    }
    throw new ExtensionError(
      `Extension "${label}" (${request.source}) failed while registering: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    name: label,
    source: request.source,
    fieldTypes: registry.fieldTypeNames().filter((name) => !previousFieldTypes.includes(name)),
    frontendFrameworks: registry
      .frontendFrameworks()
      .map((framework) => framework.name)
      .filter((name) => !previousFrameworks.includes(name)),
  };
}
