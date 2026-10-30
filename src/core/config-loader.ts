import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
import { ProjectConfigSchema, type ProjectConfig } from './config.js';

export type ConfigInput = Record<string, unknown>;

export interface ConfigLoaderOptions {
  cwd?: string;
  args?: string[];
  cliOptions?: ConfigInput;
  configPath?: string;
  /** Reserved for a future interactive prompt adapter. */
  prompt?: (current: ConfigInput) => Promise<ConfigInput>;
}

/** Raised when command-line arguments cannot be mapped onto configuration. */
export class CliOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliOptionError';
  }
}

const CONFIG_CANDIDATES = [
  'cleanstack.config.ts',
  'cleanstack.config.mts',
  'cleanstack.config.js',
  'cleanstack.config.mjs',
  'cleanstack.config.json',
  '.cleanstackrc',
  '.cleanstackrc.json',
] as const;

/** Tokens that select a CLI command rather than a positional value. */
const CLI_COMMANDS = new Set([
  'new',
  'entity',
  'generate',
  'g',
  'e',
  'regenerate',
  'r',
  'templates',
  'config',
  'doctor',
  'ui',
  'hello',
]);

type OptionKind = 'string' | 'boolean';
type OptionScope = 'project' | 'options';

interface OptionSpec {
  key: string;
  kind: OptionKind;
  scope: OptionScope;
}

const OPTION_SPECS: Record<string, OptionSpec> = {
  name: { key: 'name', kind: 'string', scope: 'project' },
  package: { key: 'packageName', kind: 'string', scope: 'project' },
  packageName: { key: 'packageName', kind: 'string', scope: 'project' },
  backend: { key: 'backend', kind: 'boolean', scope: 'options' },
  frontend: { key: 'frontend', kind: 'boolean', scope: 'options' },
  db: { key: 'database', kind: 'string', scope: 'options' },
  database: { key: 'database', kind: 'string', scope: 'options' },
  auth: { key: 'auth', kind: 'string', scope: 'options' },
  build: { key: 'buildTool', kind: 'string', scope: 'options' },
  buildTool: { key: 'buildTool', kind: 'string', scope: 'options' },
  docker: { key: 'docker', kind: 'boolean', scope: 'options' },
  dryRun: { key: 'dryRun', kind: 'boolean', scope: 'options' },
  outputDir: { key: 'outputDir', kind: 'string', scope: 'options' },
};

/** Loads and validates project configuration from a file and CLI arguments. */
export class ConfigLoader {
  async load(options: ConfigLoaderOptions = {}): Promise<ProjectConfig> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = await this.loadConfigFile(cwd, options.configPath);
    const cli = options.cliOptions ?? parseCommandLineOptions(options.args ?? []);
    const merged = mergeConfig(config, cli);
    const withPrompt = options.prompt ? await options.prompt(merged) : merged;

    return ProjectConfigSchema.parse(withPrompt);
  }

  private async loadConfigFile(cwd: string, configPath?: string): Promise<ConfigInput> {
    const filePath = configPath ? path.resolve(cwd, configPath) : await findConfigFile(cwd);
    if (!filePath) return {};

    if (path.basename(filePath) === '.cleanstackrc' || path.extname(filePath) === '.json') {
      return readJsonConfig(filePath);
    }

    // Register TS imports only while loading user configuration, then release the hook.
    const unregister = register();
    try {
      const module = (await import(pathToFileURL(filePath).href)) as {
        default?: unknown;
      } & ConfigInput;
      let value: unknown = module.default ?? module;
      // tsx exposes CommonJS-transformed `export default` through a second default.
      while (isRecord(value) && Object.keys(value).length === 1 && 'default' in value) {
        value = value.default;
      }
      if (!isRecord(value)) {
        throw new TypeError(`Configuration in ${filePath} must export an object.`);
      }
      return value;
    } finally {
      await unregister();
    }
  }
}

/**
 * Parses CLI arguments into the shape accepted by {@link ProjectConfigSchema}.
 * The first positional argument (or the one following `new`) is the project name.
 */
export function parseCommandLineOptions(args: string[]): ConfigInput {
  const result: ConfigInput = {};
  const optionValues: ConfigInput = {};
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;

    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--')) {
      throw new CliOptionError(`Unknown option "${token}". Use --option or --option=value.`);
    }

    const [rawName, inlineValue] = splitOption(token.slice(2));
    if (!rawName) throw new CliOptionError('Missing option name after "--".');

    const negated = rawName.startsWith('no-');
    const normalizedName = toCamelCase(negated ? rawName.slice(3) : rawName);
    const spec = OPTION_SPECS[normalizedName];
    if (!spec) {
      throw new CliOptionError(
        `Unknown option "--${rawName}". Run "cleanstack --help" to list supported options.`,
      );
    }

    if (negated) {
      if (spec.kind !== 'boolean') {
        throw new CliOptionError(
          `Option "--${rawName}" is not a boolean flag and cannot be negated.`,
        );
      }
      if (inlineValue !== undefined) {
        throw new CliOptionError(`Negated option "--${rawName}" does not accept a value.`);
      }
      assignOption(result, optionValues, spec, false);
      continue;
    }

    const next = args[index + 1];

    if (spec.kind === 'boolean') {
      // Only consume a following token when it is an explicit boolean value, so
      // `cleanstack new --docker my-app` still reads `my-app` as the project name.
      const booleanValue =
        inlineValue ??
        (next !== undefined && /^(true|false)$/i.test(next) ? args[++index] : undefined);
      assignOption(result, optionValues, spec, parseBooleanOption(rawName, booleanValue));
      continue;
    }

    const value =
      inlineValue ?? (next !== undefined && !next.startsWith('-') ? args[++index] : undefined);
    if (value === undefined) {
      throw new CliOptionError(`Option "--${rawName}" requires a value.`);
    }
    assignOption(result, optionValues, spec, value);
  }

  const command = positionals.find((token) => CLI_COMMANDS.has(token));
  const values = positionals.filter((token) => !CLI_COMMANDS.has(token));

  if (command === undefined || command === 'new') {
    const [projectName, ...extra] = values;
    if (extra.length > 0) {
      throw new CliOptionError(`Unexpected argument "${extra[0]}".`);
    }
    if (projectName !== undefined) {
      if (result.name !== undefined) {
        throw new CliOptionError(
          'Project name was provided more than once. Use either a positional name or --name.',
        );
      }
      result.name = projectName;
    }
  } else if (values.length > 0) {
    throw new CliOptionError(`Unexpected argument "${values[0]}" for the "${command}" command.`);
  }

  if (Object.keys(optionValues).length > 0) result.options = optionValues;
  return result;
}

function splitOption(option: string): [string, string | undefined] {
  const separatorIndex = option.indexOf('=');
  if (separatorIndex === -1) return [option, undefined];
  return [option.slice(0, separatorIndex), option.slice(separatorIndex + 1)];
}

function toCamelCase(name: string): string {
  return name.replace(/-([a-z0-9])/gi, (_, character: string) => character.toUpperCase());
}

function parseBooleanOption(name: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new CliOptionError(`Option "--${name}" expects "true" or "false", received "${value}".`);
}

function assignOption(
  result: ConfigInput,
  optionValues: ConfigInput,
  spec: OptionSpec,
  value: unknown,
): void {
  const target = spec.scope === 'project' ? result : optionValues;
  const existing = target[spec.key];
  if (existing !== undefined) {
    throw new CliOptionError(`Option "--${spec.key}" was provided more than once.`);
  }
  target[spec.key] = value;
}

async function findConfigFile(cwd: string): Promise<string | undefined> {
  for (const candidate of CONFIG_CANDIDATES) {
    const filePath = path.join(cwd, candidate);
    try {
      if ((await stat(filePath)).isFile()) return filePath;
    } catch {
      // Try the next supported filename.
    }
  }
  return undefined;
}

async function readJsonConfig(filePath: string): Promise<ConfigInput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read configuration from ${filePath}: ${detail}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new TypeError(`Configuration in ${filePath} must be an object.`);
  }
  return parsed;
}

function mergeConfig(base: ConfigInput, override: ConfigInput): ConfigInput {
  const baseOptions = isRecord(base.options) ? base.options : {};
  const overrideOptions = isRecord(override.options) ? override.options : {};
  return {
    ...base,
    ...override,
    options: { ...baseOptions, ...overrideOptions },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
