export type CommandName = 'new' | 'entity' | 'hello' | 'help' | 'version' | 'unknown';

export interface ResolvedCommand {
  name: CommandName;
  args: string[];
  unknownCommand?: string;
  error?: string;
}

const GLOBAL_FLAGS = new Set(['--verbose', '-v', '--quiet', '-q']);

/**
 * Resolves command aliases before individual commands parse their own options.
 * Global verbosity flags are removed from the command arguments.
 */
export function resolveCommand(args: string[]): ResolvedCommand {
  const tokens = args.filter((argument) => !GLOBAL_FLAGS.has(argument));
  const firstIndex = tokens.findIndex((argument) => !argument.startsWith('-'));
  if (firstIndex === -1) return { name: 'help', args: [] };

  const command = tokens[firstIndex]!;
  const rest = tokens.slice(firstIndex + 1);

  if (command === 'new') return { name: 'new', args: rest };
  if (command === 'entity') return { name: 'entity', args: rest };
  if (command === 'hello') return { name: 'hello', args: rest };

  if (command === 'generate' || command === 'g') {
    const subIndex = rest.findIndex((argument) => !argument.startsWith('-'));
    const subcommand = rest[subIndex];
    if (subcommand === 'entity' || subcommand === 'e') {
      return { name: 'entity', args: rest.slice(subIndex + 1) };
    }
    return {
      name: 'unknown',
      args: rest,
      unknownCommand: subcommand ?? command,
      error: `Unknown generate target "${subcommand ?? ''}". Use "cleanstack generate entity <name>".`,
    };
  }

  return {
    name: 'unknown',
    args: rest,
    unknownCommand: command,
    error: `Unknown command "${command}".`,
  };
}
