import path from 'node:path';
import { Command } from 'commander';
import type { Logger } from '../utils/logger.js';
import { runConfigCommand } from './config.js';
import { runEntityCommand } from './entity.js';
import { runNewCommand } from './new.js';
import { runRegenerateCommand } from './regenerate.js';
import { runTemplatesCommand } from './templates.js';

export interface CliCommandContext {
  logger: Logger;
  cwd: string;
}

export interface CliHandlers {
  newCommand(args: string[], context: CliCommandContext): Promise<void>;
  entityCommand(args: string[], context: CliCommandContext): Promise<void>;
  regenerateCommand(args: string[], context: CliCommandContext): Promise<void>;
  templatesCommand(args: string[], context: CliCommandContext): Promise<void>;
  configCommand(args: string[], context: CliCommandContext): Promise<void>;
  uiCommand(args: string[], context: CliCommandContext): Promise<void>;
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

const defaultHandlers: CliHandlers = {
  newCommand: (args, context) => runNewCommand(args, context),
  entityCommand: (args, context) => runEntityCommand(args, context),
  regenerateCommand: (args, context) => runRegenerateCommand(args, context),
  templatesCommand: (args, context) => runTemplatesCommand(args, context),
  configCommand: (args, context) => runConfigCommand(args, context),
  uiCommand: (_args, context) => {
    context.logger.warn(
      'The "ui" command is not available yet. It is planned for a future release.',
    );
    return Promise.resolve();
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

  leaf(program, 'ui')
    .description('Open the CleanStack web UI (not available yet)')
    .action((args: string[]) => handlers.uiCommand(args, context));

  return program;
}
