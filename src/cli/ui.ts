import { stat } from 'node:fs/promises';
import path from 'node:path';
import { CliOptionError } from '../core/config-loader.js';
import type { Logger } from '../utils/logger.js';
import { hasBuiltUi, startServer } from '../web/server.js';

export const UI_USAGE = `Usage: cleanstack ui [options]

Start CleanStack Studio on a local port. The studio is a thin client over the
same engine as the CLI, so projects and entities are generated exactly as they
would be from this terminal.

Options:
  --port <number>      Port to listen on (default: 5173, use 0 for any free port)
  --host <name>        Host to bind (default: 127.0.0.1)
  --workspace <path>   Workspace used to discover and create projects
                       (default: CLEANSTACK_WEB_WORKSPACE or the current directory)
  --dev                Start Vite with hot reload instead of the built UI
  --static             Serve the built UI only, with bundled demo data and no API
  -h, --help           Show this help

Static mode is intended for demos and static hosting. It never reads or writes
the local filesystem; generation, previews of generated files, and downloads
are disabled.`;

export interface UiCommandArguments {
  dev: boolean;
  static: boolean;
  port: number;
  host: string;
  workspace: string;
  help: boolean;
}

export interface UiCommandOptions {
  cwd?: string;
  logger: Logger;
  /** Environment variables to read. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Replaced in tests. */
  startServerImpl?: typeof startServer;
  /** Replaced in tests. */
  hasBuiltUiImpl?: typeof hasBuiltUi;
}

export interface StartedUi {
  url: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = '127.0.0.1';

/** Parses `cleanstack ui` arguments without touching the filesystem. */
export function parseUiArguments(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): UiCommandArguments {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  let dev = false;
  let staticMode = false;
  let help = false;
  let port: number | undefined;
  let host: string | undefined;
  let workspace: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--dev') {
      dev = true;
      continue;
    }
    if (token === '--static') {
      staticMode = true;
      continue;
    }

    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (name === '--port' || name === '--host' || name === '--workspace') {
      const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
      const value = inlineValue ?? args[index + 1];
      if (
        value === undefined ||
        value === '' ||
        (inlineValue === undefined && value.startsWith('-'))
      ) {
        throw new CliOptionError(`Option "${name}" requires a value.`);
      }
      if (inlineValue === undefined) index += 1;
      if (name === '--port') port = parsePort(value);
      if (name === '--host') host = value;
      if (name === '--workspace') workspace = path.resolve(cwd, value);
      continue;
    }

    throw new CliOptionError(`Unknown option "${token}".`, [
      'Run "cleanstack ui --help" to see the available options.',
    ]);
  }

  return {
    dev,
    static: staticMode,
    port: port ?? DEFAULT_PORT,
    host: host ?? DEFAULT_HOST,
    workspace: workspace ?? path.resolve(cwd, env.CLEANSTACK_WEB_WORKSPACE ?? '.'),
    help,
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliOptionError(`"${value}" is not a valid port.`, [
      'Use a whole number between 0 and 65535.',
    ]);
  }
  return port;
}

/** Starts the web UI and resolves once it is accepting connections. */
export async function runUiCommand(args: string[], options: UiCommandOptions): Promise<StartedUi> {
  const parseOptions: { cwd?: string; env?: Record<string, string | undefined> } = {};
  if (options.cwd !== undefined) parseOptions.cwd = options.cwd;
  if (options.env !== undefined) parseOptions.env = options.env;
  const parsed = parseUiArguments(args, parseOptions);
  if (parsed.help) {
    options.logger.info(UI_USAGE);
    return { url: '', close: async () => {} };
  }

  if (!parsed.static) {
    const workspaceStat = await stat(parsed.workspace).catch(() => undefined);
    if (workspaceStat === undefined || !workspaceStat.isDirectory()) {
      throw new CliOptionError(
        `Workspace "${parsed.workspace}" does not exist or is not a directory.`,
        ['Pass an existing directory with --workspace <path>.'],
      );
    }
  }

  const uiBuilt = await (options.hasBuiltUiImpl ?? hasBuiltUi)();
  if (!uiBuilt && !parsed.dev) {
    throw new CliOptionError('The CleanStack UI bundle has not been built yet.', [
      'Run "npm run ui:build" and try again.',
      'Or start the UI in development mode with "cleanstack ui --dev".',
    ]);
  }

  let started: Awaited<ReturnType<typeof startServer>>;
  try {
    started = await (options.startServerImpl ?? startServer)({
      dev: parsed.dev,
      host: parsed.host,
      port: parsed.port,
      workspace: parsed.workspace,
      static: parsed.static,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EADDRINUSE') {
      throw new CliOptionError(`Port ${parsed.port} is already in use.`, [
        'Try another port with --port <number>, or stop the process using it.',
      ]);
    }
    if (code === 'EACCES') {
      throw new CliOptionError(`Cannot bind to port ${parsed.port}.`, [
        'Choose a port above 1024, or run with sufficient permissions.',
      ]);
    }
    throw error;
  }

  options.logger.success(`CleanStack Studio running at ${started.url}`);
  if (parsed.static) {
    options.logger.info('Static demo mode: bundled sample data, no local API access.');
  } else {
    options.logger.info(`Workspace: ${parsed.workspace}`);
  }
  options.logger.info('Press Ctrl+C to stop.');

  return {
    url: started.url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}
