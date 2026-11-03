import path from 'node:path';
import { ZodError } from 'zod';
import {
  CliOptionError,
  ConfigLoader,
  parseEnvironmentOptions,
  resolveConfigFile,
} from '../core/config-loader.js';
import { formatZodError } from '../core/entity-parser.js';
import type { Logger } from '../utils/logger.js';

export interface ConfigCommandOptions {
  cwd?: string;
  logger: Logger;
  /** Environment variables to read. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export const CONFIG_USAGE = `Usage: cleanstack config [subcommand] [options]

Inspect the CleanStack configuration resolved for the current directory.
The configuration file is searched in the current directory and up to four
parent directories. Set CLEANSTACK_CONFIG to use a specific file.

Subcommands:
  show       Print the effective configuration (default)
  path       Print the configuration file path
  validate   Validate the configuration and report problems

Options:
  --json     show: print the full configuration as JSON
  -h, --help Show this help`;

interface ConfigCommandArguments {
  subcommand: 'show' | 'path' | 'validate';
  json: boolean;
  help: boolean;
}

export async function runConfigCommand(
  args: string[],
  options: ConfigCommandOptions,
): Promise<void> {
  const parsed = parseConfigCommandArguments(args);
  if (parsed.help) {
    options.logger.info(CONFIG_USAGE);
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const environment = parseEnvironmentOptions(env);
  const configPath = await resolveConfigFile(cwd, environment.configPath);
  if (configPath === undefined) {
    throw new CliOptionError(
      `No CleanStack configuration file was found in "${cwd}" or its parent directories. ` +
        'Looked for cleanstack.config.{ts,mts,js,mjs,json,yml,yaml} and ' +
        '.cleanstackrc[.json][.yml][.yaml]. Set CLEANSTACK_CONFIG to use a specific file.',
    );
  }

  if (parsed.subcommand === 'path') {
    options.logger.info(configPath);
    return;
  }

  const config = await loadConfig(cwd, configPath, env);
  if (parsed.subcommand === 'validate') {
    const entityCount = config.entities.length;
    const entityLabel = `${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}`;
    options.logger.success(`Configuration is valid: ${configPath}`);
    options.logger.info(
      config.name === undefined
        ? `Team defaults without a project name, with ${entityLabel}.`
        : `Project "${config.name}" with ${entityLabel}.`,
    );
    return;
  }

  if (parsed.json) {
    options.logger.info(JSON.stringify(config, null, 2));
    return;
  }

  options.logger.info(`Configuration: ${configPath}`);
  options.logger.table(
    [
      { key: 'setting', header: 'Setting' },
      { key: 'value', header: 'Value' },
    ],
    [
      { setting: 'Name', value: config.name ?? '(not set)' },
      { setting: 'Package', value: config.packageName },
      { setting: 'Backend', value: config.options.backend ? 'yes' : 'no' },
      { setting: 'Frontend', value: config.options.frontend ? 'yes' : 'no' },
      { setting: 'Database', value: config.options.database },
      { setting: 'Auth', value: config.options.auth },
      { setting: 'Build tool', value: config.options.buildTool },
      { setting: 'Docker', value: config.options.docker ? 'yes' : 'no' },
      { setting: 'Output dir', value: config.options.outputDir },
      {
        setting: 'Entities',
        value: config.entities.map((entity) => entity.name).join(', ') || '-',
      },
    ],
  );
}

async function loadConfig(
  cwd: string,
  configPath: string,
  env: Record<string, string | undefined>,
) {
  try {
    return await new ConfigLoader().loadDefaults({ cwd, configPath, env });
  } catch (error) {
    if (error instanceof ZodError) {
      throw new CliOptionError(`Invalid configuration in ${configPath}: ${formatZodError(error)}`);
    }
    throw error;
  }
}

export function parseConfigCommandArguments(args: string[]): ConfigCommandArguments {
  const result: ConfigCommandArguments = {
    subcommand: 'show',
    json: false,
    help: false,
  };
  const positionals: string[] = [];

  for (const token of args) {
    if (token === '--') continue;
    if (token === '--json') {
      result.json = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--verbose' || token === '-v' || token === '--quiet' || token === '-q') {
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliOptionError(`Unknown option "${token}" for "cleanstack config".`);
    }
    positionals.push(token);
  }

  const first = positionals[0];
  if (first !== undefined) {
    if (first !== 'show' && first !== 'path' && first !== 'validate') {
      throw new CliOptionError(
        `Unknown config subcommand "${first}". Use show, path, or validate.`,
      );
    }
    result.subcommand = first;
    if (positionals.length > 1) {
      throw new CliOptionError('"cleanstack config" accepts a single subcommand.');
    }
  }

  return result;
}
