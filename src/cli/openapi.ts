import path from 'node:path';
import { CliOptionError } from '../core/config-loader.js';
import {
  DEFAULT_OPENAPI_CLIENT_DIRECTORY,
  DEFAULT_OPENAPI_GENERATOR,
  generateAngularClient,
  type OpenApiGeneratorRunner,
} from '../core/openapi-client.js';
import { locateGeneratedProject } from '../core/project.js';
import type { Logger } from '../utils/logger.js';

export interface OpenApiCommandOptions {
  cwd?: string;
  logger: Logger;
  /** Injectable generator, primarily for tests. */
  runGenerator?: OpenApiGeneratorRunner;
}

export interface OpenApiCommandArguments {
  input?: string;
  output?: string;
  generator?: string;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

export const OPENAPI_USAGE = `Usage: cleanstack openapi [spec] [options]
       cleanstack api [spec] [options]

Generates the Angular API client from a running Spring Boot OpenAPI document.

The backend publishes its contract with springdoc at /v3/api-docs (JSON) and
/v3/api-docs.yaml. The client is written to ${DEFAULT_OPENAPI_CLIENT_DIRECTORY} by default.
Regeneration is safe: generation happens in a temporary directory first, only
files recorded in the CleanStack manifest are replaced or removed, and custom
files inside the client directory are preserved.

Options:
  -i, --input <path|url>   OpenAPI document or URL (default: discover openapi/openapi.yaml)
  -o, --output <path>      Output directory inside the Angular project
                           (default: ${DEFAULT_OPENAPI_CLIENT_DIRECTORY})
  -g, --generator <name>   openapi-generator generator (default: ${DEFAULT_OPENAPI_GENERATOR})
  --force                  Replace files that collide with unmanaged files
  --dry-run                Generate in a temporary directory and report without writing
  -h, --help               Show this help

Examples:
  cleanstack openapi --input http://localhost:8080/v3/api-docs
  cleanstack openapi --input openapi/openapi.json
  cleanstack api --dry-run`;

export async function runOpenApiCommand(
  args: string[],
  options: OpenApiCommandOptions,
): Promise<void> {
  const parsed = parseOpenApiCommandArguments(args);
  if (parsed.help) {
    options.logger.info(OPENAPI_USAGE);
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const project = await locateGeneratedProject({ cwd });
  if (project.frontend === undefined) {
    throw new CliOptionError(
      'No Angular project was found. The OpenAPI client can only be generated for a generated frontend.',
      ['Regenerate the project with a frontend, or run the command inside the Angular project.'],
    );
  }

  const result = await generateAngularClient({
    project,
    logger: options.logger,
    cwd,
    ...(parsed.input === undefined ? {} : { input: parsed.input }),
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
    ...(parsed.generator === undefined ? {} : { generator: parsed.generator }),
    ...(options.runGenerator === undefined ? {} : { runGenerator: options.runGenerator }),
    force: parsed.force,
    dryRun: parsed.dryRun,
  });

  for (const warning of result.warnings) options.logger.warn(warning);

  const target = path.posix.join(project.frontend.relativeDirectory, result.target);
  const changes = [
    `${result.created.length} created`,
    `${result.updated.length} updated`,
    `${result.removed.length} removed`,
    `${result.unchanged.length} unchanged`,
  ].join(', ');

  options.logger.info(
    `API contract: ${result.spec.title}${result.spec.version === '' ? '' : ` ${result.spec.version}`} (OpenAPI ${result.spec.specVersion}, ${result.spec.source})`,
  );

  if (result.dryRun) {
    options.logger.info(`Dry run: API client in ${target} would be regenerated (${changes}).`);
    return;
  }

  if (result.created.length === 0 && result.updated.length === 0 && result.removed.length === 0) {
    options.logger.success(`API client in ${target} is up to date (${changes}).`);
    return;
  }

  options.logger.success(`Generated API client in ${target} (${changes}).`);
}

/** Parses openapi-command arguments into a small, testable shape. */
export function parseOpenApiCommandArguments(args: string[]): OpenApiCommandArguments {
  const result: OpenApiCommandArguments = {
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
      case '--input':
      case '--spec':
      case '-i': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.input = value;
        index = nextIndex;
        break;
      }
      case '--output':
      case '-o': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.output = value;
        index = nextIndex;
        break;
      }
      case '--generator':
      case '-g': {
        const [value, nextIndex] = readValue(flag, inlineValue, args, index);
        result.generator = value;
        index = nextIndex;
        break;
      }
      default:
        throw new CliOptionError(`Unknown option "${flag}" for the openapi command.`);
    }
  }

  if (result.help) return result;

  if (positionals.length > 1) {
    throw new CliOptionError(`Unexpected argument "${positionals[1]}".`);
  }
  if (positionals[0] !== undefined) {
    if (result.input !== undefined) {
      throw new CliOptionError(
        'Pass the OpenAPI document either as an argument or with --input, not both.',
      );
    }
    result.input = positionals[0];
  }

  return result;
}

function readValue(
  flag: string,
  inlineValue: string | undefined,
  args: string[],
  index: number,
): [string, number] {
  if (inlineValue !== undefined) {
    if (inlineValue === '') throw new CliOptionError(`Option "${flag}" requires a value.`);
    return [inlineValue, index];
  }

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
