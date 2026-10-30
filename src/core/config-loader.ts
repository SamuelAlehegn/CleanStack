import { access, readFile } from 'node:fs/promises';
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

const CONFIG_CANDIDATES = ['cleanstack.config.ts', '.cleanstackrc'] as const;

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

    if (path.basename(filePath) === '.cleanstackrc' || filePath.endsWith('.json')) {
      return JSON.parse(await readFile(filePath, 'utf8')) as ConfigInput;
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`Configuration in ${filePath} must export an object.`);
      }
      return value as ConfigInput;
    } finally {
      await unregister();
    }
  }
}

export function parseCommandLineOptions(args: string[]): ConfigInput {
  const result: ConfigInput = {};
  const optionValues: Record<string, unknown> = {};
  const aliases: Record<string, string> = {
    package: 'packageName',
    db: 'database',
    build: 'buildTool',
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith('--')) continue;

    const [rawName, inlineValue] = token.slice(2).split('=', 2);
    if (!rawName) continue;
    const negated = rawName.startsWith('no-');
    const name = (negated ? rawName.slice(3) : rawName).replace(/-([a-z])/g, (_, c: string) =>
      c.toUpperCase(),
    );
    const next = args[index + 1];
    const value = inlineValue ?? (next && !next.startsWith('--') ? args[++index] : undefined);
    const parsed: unknown = value === undefined ? !negated : value;

    if (['name', 'packageName', 'entities'].includes(name)) {
      result[aliases[name] ?? name] = parsed;
    } else {
      optionValues[aliases[name] ?? name] = parsed;
    }
  }

  if (Object.keys(optionValues).length > 0) result.options = optionValues;
  return result;
}

async function findConfigFile(cwd: string): Promise<string | undefined> {
  for (const candidate of CONFIG_CANDIDATES) {
    const filePath = path.join(cwd, candidate);
    try {
      await access(filePath);
      return filePath;
    } catch {
      // Try the next supported filename.
    }
  }
  return undefined;
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
