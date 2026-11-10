import path from 'node:path';
import { Command } from 'commander';
import type { Logger } from '../utils/logger.js';

export interface CliCommandContext {
  logger: Logger;
  cwd: string;
}

export interface CliHandlers {
  newCommand(args: string[], context: CliCommandContext): Promise<void>;
  entityCommand(args: string[], context: CliCommandContext): Promise<void>;
  regenerateCommand(args: string[], context: CliCommandContext): Promise<void>;
  openapiCommand(args: string[], context: CliCommandContext): Promise<void>;
  templatesCommand(args: string[], context: CliCommandContext): Promise<void>;
  configCommand(args: string[], context: CliCommandContext): Promise<void>;
  doctorCommand(args: string[], context: CliCommandContext): Promise<void>;
  uiCommand(args: string[], context: CliCommandContext): Promise<void>;
  extensionsCommand(args: string[], context: CliCommandContext): Promise<void>;
}

export interface CreateProgramOptions {
  version: string;
  logger: Logger;
  /** Directory commands run in. Defaults to process.cwd(). */
  cwd?: string;
  /** Replaces individual command implementations, primarily for tests. */
  handlers?: Partial<CliHandlers>;
  /** Throw instead of calling process.exit(). Useful for embedding and tests. */
  exitOverride?: boolean;
}

export interface ExtractedGlobalFlags {
  args: string[];
  verbose: boolean;
  quiet: boolean;
}

/**
 * Command modules are imported on demand. Startup therefore loads Commander
 * and the logger only; heavy dependencies such as inquirer, Handlebars, and
 * zod are paid for by the command that actually needs them.
 */
const defaultHandlers: CliHandlers = {
  async newCommand(args, context) {
    const { runNewCommand } = await import('./new.js');
    return runNewCommand(args, context);
  },
  async entityCommand(args, context) {
    const { runEntityCommand } = await import('./entity.js');
    return runEntityCommand(args, context);
  },
  async regenerateCommand(args, context) {
    const { runRegenerateCommand } = await import('./regenerate.js');
    return runRegenerateCommand(args, context);
  },
  async openapiCommand(args, context) {
    const { runOpenApiCommand } = await import('./openapi.js');
    return runOpenApiCommand(args, context);
  },
  async templatesCommand(args, context) {
    const { runTemplatesCommand } = await import('./templates.js');
    return runTemplatesCommand(args, context);
  },
  async configCommand(args, context) {
    const { runConfigCommand } = await import('./config.js');
    return runConfigCommand(args, context);
  },
  async doctorCommand(args, context) {
    const { runDoctorCommand } = await import('./doctor.js');
    return runDoctorCommand(args, context);
  },
  async uiCommand(args, context) {
    const { runUiCommand } = await import('./ui.js');
    await runUiCommand(args, context);
  },
  async extensionsCommand(args, context) {
    const { runExtensionsCommand } = await import('./extensions.js');
    return runExtensionsCommand(args, context);
  },
};

/**
 * Removes global verbosity flags from anywhere in argv so every command accepts
 * them, before and after its own arguments. Callers use the returned booleans to
 * configure the logger.
 */
export function extractGlobalFlags(argv: string[]): ExtractedGlobalFlags {
  const args: string[] = [];
  let verbose = false;
  let quiet = false;

  for (const token of argv) {
    if (token === '--verbose' || token === '-v') {
      verbose = true;
    } else if (token === '--quiet' || token === '-q') {
      quiet = true;
    } else {
      args.push(token);
    }
  }

  return { args, verbose, quiet };
}

/**
 * Builds the CleanStack command tree. Subcommands keep their rich option
 * parsers: leaf commands accept unknown options so the original `run*`
 * implementations remain the source of truth for command-specific flags.
 */
export function createProgram(options: CreateProgramOptions): Command {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const handlers: CliHandlers = { ...defaultHandlers, ...options.handlers };
  const context: CliCommandContext = { logger: options.logger, cwd };

  const program = new Command('cleanstack')
    .description('Generate and maintain clean, layered full-stack projects.')
    .version(options.version, '-V, --version', 'Show the version')
    .option('-v, --verbose', 'Show debug output')
    .option('-q, --quiet', 'Suppress non-error output')
    .addHelpText(
      'after',
      '\nGlobal flags may appear before or after a command, for example "cleanstack new demo --verbose".',
    );

  if (options.exitOverride) program.exitOverride();

  const leaf = (parent: Command, name: string): Command =>
    parent
      .command(`${name} [args...]`)
      .helpOption(false)
      .allowUnknownOption(true)
      .allowExcessArguments(true);

  leaf(program, 'new')
    .description('Create a new project skeleton')
    .action((args: string[]) => handlers.newCommand(args, context));

  leaf(program, 'entity')
    .description('Generate an entity in an existing project')
    .action((args: string[]) => handlers.entityCommand(args, context));

  const generate = program.command('generate').alias('g').description('Generate project artifacts');
  leaf(generate, 'entity')
    .alias('e')
    .description('Generate an entity in an existing project')
    .action((args: string[]) => handlers.entityCommand(args, context));
  generate.action(() => {
    generate.outputHelp();
  });

  leaf(program, 'regenerate')
    .alias('r')
    .description('Re-generate project files while preserving protected regions')
    .action((args: string[]) => handlers.regenerateCommand(args, context));

  leaf(program, 'openapi')
    .alias('api')
    .description('Generate the Angular API client from an OpenAPI document')
    .action((args: string[]) => handlers.openapiCommand(args, context));

  const templates = program
    .command('templates')
    .description('List, copy, diff, and reset template overrides');
  const templateSubcommands: Array<[string, string]> = [
    ['list', 'List templates and where each one resolves from'],
    ['init', 'Copy built-in templates into the project override directory'],
    ['diff', 'Show differences between overrides and the built-in templates'],
    ['reset', 'Remove an override and fall back to the built-in template'],
  ];
  for (const [name, description] of templateSubcommands) {
    leaf(templates, name)
      .description(description)
      .action((args: string[]) => handlers.templatesCommand([name, ...args], context));
  }
  templates.action(() => handlers.templatesCommand(['list'], context));

  leaf(program, 'config')
    .description('Inspect the configuration resolved for this directory')
    .action((args: string[]) => handlers.configCommand(args, context));

  leaf(program, 'doctor')
    .description('Check the environment for common problems')
    .action((args: string[]) => handlers.doctorCommand(args, context));

  leaf(program, 'ui')
    .description('Start the local CleanStack web UI')
    .action((args: string[]) => handlers.uiCommand(args, context));

  const extensions = program
    .command('extensions')
    .description('List the extensions loaded for this directory');
  leaf(extensions, 'list')
    .description('List extensions, field types, and frontend frameworks')
    .action((args: string[]) => handlers.extensionsCommand(['list', ...args], context));
  extensions.action(() => handlers.extensionsCommand(['list'], context));

  return program;
}
