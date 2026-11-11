import { execFile, execFileSync } from 'node:child_process';
import type { ExecFileOptions, ExecFileSyncOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** A command line ready for `child_process`, with Windows shell wrapping applied. */
export interface CommandInvocation {
  command: string;
  args: string[];
  /**
   * True when `args` are already escaped for cmd.exe. Node must pass the
   * command line through unchanged instead of applying its own quoting.
   */
  windowsVerbatimArguments?: boolean;
}

export interface BuildCommandInvocationOptions {
  platform?: NodeJS.Platform;
  /** Path to cmd.exe. Defaults to ComSpec, then "cmd.exe". */
  comSpec?: string;
  /** Route the command through cmd.exe even when it is not a .cmd/.bat file. */
  forceShell?: boolean;
}

export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
}

/**
 * Resolves a command the way cmd.exe would: PATH directories plus PATHEXT.
 * Node cannot execute .cmd/.bat files directly, so callers need the concrete
 * script path before building the invocation.
 */
export function resolveCommandPath(command: string, options: ResolveCommandOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return command;

  const env = options.env ?? process.env;
  const extensions = commandExtensions(command, env);
  const hasPathSeparator = command.includes('/') || command.includes('\\');
  if (hasPathSeparator || path.win32.isAbsolute(command)) {
    return firstExisting(command, extensions) ?? command;
  }

  const searchPath = env.PATH ?? env.Path ?? env.path ?? '';
  for (const directory of searchPath.split(path.win32.delimiter)) {
    if (directory === '') continue;
    const candidate = firstExisting(path.win32.join(directory, command), extensions);
    if (candidate !== undefined) return candidate;
  }
  return command;
}

/** Returns true when the command is a Windows batch script. */
export function isWindowsCommandScript(command: string): boolean {
  const extension = path.extname(command).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

/**
 * Builds the command and argument list passed to child_process.
 *
 * On Windows, .cmd and .bat files must run through cmd.exe; this function
 * applies the escaping rules cmd.exe expects, including the double escaping
 * required by npm's node_modules/.bin shims.
 */
export function buildCommandInvocation(
  command: string,
  args: readonly string[],
  options: BuildCommandInvocationOptions = {},
): CommandInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || (!options.forceShell && !isWindowsCommandScript(command))) {
    return { command, args: [...args] };
  }

  const doubleEscape = isNodeModulesCmdShim(command);
  const shellCommand = [
    escapeCommand(command),
    ...args.map((argument) => escapeArgument(argument, doubleEscape)),
  ].join(' ');
  const comSpec = options.comSpec ?? process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';

  return {
    command: comSpec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

/** Runs a command with native argument passing and Windows cmd.exe fallback. */
export function execCommand(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<CommandOutput> {
  const invocation = buildCommandInvocation(resolveCommandPath(command), args);
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      withVerbatimArguments(options, invocation),
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** Synchronous variant of {@link execCommand}; returns nothing and throws on failure. */
export function execCommandSync(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions = {},
): void {
  const invocation = buildCommandInvocation(resolveCommandPath(command), args);
  execFileSync(invocation.command, invocation.args, withVerbatimArguments(options, invocation));
}

function withVerbatimArguments<T extends ExecFileOptions | ExecFileSyncOptions>(
  options: T,
  invocation: CommandInvocation,
): T {
  if (invocation.windowsVerbatimArguments !== true) return options;
  return { ...options, windowsVerbatimArguments: true };
}

function commandExtensions(command: string, env: NodeJS.ProcessEnv): string[] {
  // An explicit extension must be matched literally; cmd.exe only appends
  // PATHEXT entries when the command has no extension of its own.
  if (path.win32.extname(command) !== '') return [''];
  return (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension !== '');
}

function firstExisting(candidate: string, extensions: readonly string[]): string | undefined {
  for (const extension of extensions) {
    const filePath = extension === '' ? candidate : `${candidate}${extension}`;
    if (existsSync(filePath)) return filePath;
  }
  return undefined;
}

function isNodeModulesCmdShim(command: string): boolean {
  return /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
}

// The escaping below mirrors cross-spawn's cmd.exe handling. The algorithm is
// based on https://qntm.org/cmd and keeps carets, quotes, and trailing
// backslashes from changing the argument list.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(command: string): string {
  return command.replace(CMD_META_CHARS, '^$1');
}

function escapeArgument(argument: string, doubleEscape: boolean): string {
  let escaped = String(argument);

  // Backslashes before a quote must be doubled; the quote itself is escaped.
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  // Backslashes before the closing quote must be doubled as well.
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');

  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, '^$1');
  if (doubleEscape) escaped = escaped.replace(CMD_META_CHARS, '^$1');
  return escaped;
}
