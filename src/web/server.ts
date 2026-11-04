import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { createApiHandler } from './api.js';

interface WebServerOptions {
  dev: boolean;
  host: string;
  port: number;
  workspace: string;
  /** Serve the built UI only, with no local API. */
  static?: boolean;
}

interface ParsedArguments extends Partial<WebServerOptions> {
  help: boolean;
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const uiRoot = path.join(webRoot, 'dist');

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Starts the local CleanStack UI server. */
export async function startServer(options: WebServerOptions): Promise<{
  server: Server;
  url: string;
}> {
  const api =
    options.static === true ? undefined : createApiHandler({ workspace: options.workspace });
  let vite: ViteDevServer | undefined;

  const server = createServer((request, response) => {
    void dispatch(request, response);
  });

  if (options.dev) {
    const viteModule = await import('vite');
    vite = await viteModule.createServer({
      root: webRoot,
      appType: 'spa',
      server: {
        middlewareMode: true,
        ws: { server },
      },
    });
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/';
    if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) {
      if (api === undefined) {
        sendJson(response, 404, {
          error: 'The static demo does not include the local engine API.',
          suggestions: ['Run "cleanstack ui" without --static to use the local engine.'],
        });
        return;
      }
      await api(request, response);
      return;
    }

    if (vite !== undefined) {
      vite.middlewares(request, response, (error?: unknown) => {
        if (error !== undefined) {
          sendText(response, 500, 'The Vite development server could not render this page.');
        }
      });
      return;
    }

    await serveStatic(request, response);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const host = options.host === '0.0.0.0' ? 'localhost' : options.host;
  return { server, url: `http://${host}:${port}` };
}

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    sendText(response, 400, 'The requested path is not valid URL encoding.');
    return;
  }
  const relative = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
  const candidate = path.resolve(uiRoot, relative);

  if (candidate.startsWith(`${uiRoot}${path.sep}`)) {
    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) {
        await sendFile(response, candidate, request.method === 'HEAD');
        return;
      }
    } catch {
      // Fall through to the SPA entry point.
    }
  }

  try {
    const index = path.join(uiRoot, 'index.html');
    const contents = await readFile(index);
    response.writeHead(200, {
      'content-type': MIME_TYPES['.html']!,
      'content-length': contents.length,
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch {
    sendText(
      response,
      503,
      'The CleanStack UI has not been built yet. Run "npm run ui:build" and restart the server.',
    );
  }
}

async function sendFile(
  response: ServerResponse,
  filePath: string,
  headOnly: boolean,
): Promise<void> {
  const contents = await readFile(filePath);
  response.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': contents.length,
    'cache-control': 'no-store',
  });
  response.end(headOnly ? undefined : contents);
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(message);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const contents = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': contents.length,
    'cache-control': 'no-store',
  });
  response.end(contents);
}

/** True when the production UI bundle exists on disk. */
export async function hasBuiltUi(): Promise<boolean> {
  try {
    return (await stat(path.join(uiRoot, 'index.html'))).isFile();
  } catch {
    return false;
  }
}

const HELP = `Usage: cleanstack-web [options]

Serve the CleanStack web UI on top of the same engine used by the CLI.
Prefer "cleanstack ui", which supports the same options.

Options:
  --dev                Start Vite in middleware mode with hot reload
  --static             Serve the built UI only, with bundled demo data and no API
  --port <number>      Port to listen on (default: 5173)
  --host <name>        Host to bind (default: 127.0.0.1)
  --workspace <path>   Workspace used to discover and create projects
                       (default: CLEANSTACK_WEB_WORKSPACE or the current directory)
  -h, --help           Show this help`;

export function parseServerArguments(args: string[]): ParsedArguments {
  const result: ParsedArguments = { help: false };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--help' || token === '-h') {
      result.help = true;
      continue;
    }
    if (token === '--dev') {
      result.dev = true;
      continue;
    }
    if (token === '--static') {
      result.static = true;
      continue;
    }
    if (token === '--port' || token === '--host' || token === '--workspace') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Option "${token}" requires a value.`);
      }
      index += 1;
      if (token === '--port') result.port = parsePort(value);
      if (token === '--host') result.host = value;
      if (token === '--workspace') result.workspace = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option "${token}".`);
  }

  return result;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`"${value}" is not a valid port.`);
  }
  return port;
}

async function main(): Promise<void> {
  const parsed = parseServerArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return;
  }

  const workspace = path.resolve(
    parsed.workspace ?? process.env.CLEANSTACK_WEB_WORKSPACE ?? process.cwd(),
  );
  if (parsed.static !== true) {
    const workspaceStat = await stat(workspace).catch(() => undefined);
    if (workspaceStat === undefined || !workspaceStat.isDirectory()) {
      throw new Error(`Workspace "${workspace}" does not exist or is not a directory.`);
    }
  }

  const { url } = await startServer({
    dev: parsed.dev ?? false,
    host: parsed.host ?? '127.0.0.1',
    port: parsed.port ?? 5173,
    workspace,
    static: parsed.static ?? false,
  });
  console.log(`CleanStack UI running at ${url}`);
  console.log(
    parsed.static === true ? 'Mode: static demo (no local API)' : `Workspace: ${workspace}`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
