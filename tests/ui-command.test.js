import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseUiArguments, runUiCommand, UI_USAGE } from '../dist/cli/ui.js';
import { startServer } from '../dist/web/server.js';

function recordingLogger() {
  const messages = [];
  const record = (level) => (message) => messages.push(`${level}: ${message}`);
  return {
    messages,
    debug: record('debug'),
    info: record('info'),
    success: record('success'),
    warn: record('warn'),
    error: record('error'),
    table() {},
  };
}

async function createWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), 'cleanstack-ui-'));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('ui defaults to localhost, port 5173, and the current directory', () => {
  const cwd = path.resolve('/tmp/cleanstack-ui-defaults');
  assert.deepEqual(parseUiArguments([], { cwd, env: {} }), {
    dev: false,
    static: false,
    port: 5173,
    host: '127.0.0.1',
    workspace: cwd,
    help: false,
  });
});

test('ui parses port, host, workspace, dev, and static flags', () => {
  const cwd = path.resolve('/tmp/cleanstack-ui-flags');
  assert.deepEqual(
    parseUiArguments(
      [
        '--port',
        '8080',
        '--host=0.0.0.0',
        '--workspace',
        'projects',
        '--dev',
        '--static',
        '--port=0',
      ],
      { cwd, env: {} },
    ),
    {
      dev: true,
      static: true,
      port: 0,
      host: '0.0.0.0',
      workspace: path.join(cwd, 'projects'),
      help: false,
    },
  );
});

test('ui reads the workspace from CLEANSTACK_WEB_WORKSPACE', () => {
  const cwd = path.resolve('/tmp/cleanstack-ui-env');
  assert.equal(
    parseUiArguments([], { cwd, env: { CLEANSTACK_WEB_WORKSPACE: 'workspace' } }).workspace,
    path.join(cwd, 'workspace'),
  );
});

test('ui rejects invalid ports, missing values, and unknown options', () => {
  assert.throws(() => parseUiArguments(['--port', '70000']), /not a valid port/);
  assert.throws(() => parseUiArguments(['--port', '3.5']), /not a valid port/);
  assert.throws(() => parseUiArguments(['--port']), /requires a value/);
  assert.throws(() => parseUiArguments(['--workspace', '--dev']), /requires a value/);
  assert.throws(() => parseUiArguments(['--bogus']), /Unknown option "--bogus"/);
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

test('ui --help prints usage without starting the server', async () => {
  const logger = recordingLogger();
  let started = false;
  const result = await runUiCommand(['--help'], {
    logger,
    startServerImpl: async () => {
      started = true;
      throw new Error('should not start');
    },
  });

  assert.equal(result.url, '');
  assert.equal(started, false);
  assert.equal(logger.messages.length, 1);
  assert.ok(logger.messages[0].includes(UI_USAGE.split('\n')[0]));
});

test('ui requires an existing workspace in local mode', async () => {
  const root = await createWorkspace();
  try {
    await assert.rejects(
      runUiCommand([], {
        cwd: root,
        logger: recordingLogger(),
        env: { CLEANSTACK_WEB_WORKSPACE: path.join(root, 'missing') },
        hasBuiltUiImpl: async () => true,
      }),
      /does not exist or is not a directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ui asks for a build before serving the production bundle', async () => {
  const root = await createWorkspace();
  try {
    await assert.rejects(
      runUiCommand([], {
        cwd: root,
        logger: recordingLogger(),
        env: {},
        hasBuiltUiImpl: async () => false,
      }),
      /bundle has not been built/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ui passes parsed options to the server and reports the URL', async () => {
  const root = await createWorkspace();
  const logger = recordingLogger();
  let received;
  const fakeServer = { close: (callback) => callback() };

  try {
    const result = await runUiCommand(['--port', '0', '--static'], {
      cwd: root,
      logger,
      env: {},
      hasBuiltUiImpl: async () => true,
      startServerImpl: async (options) => {
        received = options;
        return { server: fakeServer, url: 'http://127.0.0.1:4321' };
      },
    });

    assert.equal(result.url, 'http://127.0.0.1:4321');
    assert.deepEqual(received, {
      dev: false,
      host: '127.0.0.1',
      port: 0,
      workspace: root,
      static: true,
    });
    assert.match(
      logger.messages.join('\n'),
      /CleanStack Studio running at http:\/\/127\.0\.0\.1:4321/,
    );
    assert.match(logger.messages.join('\n'), /Static demo mode/);
    await result.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ui reports a friendly message when the port is in use', async () => {
  const root = await createWorkspace();
  try {
    await assert.rejects(
      runUiCommand(['--port', '5173'], {
        cwd: root,
        logger: recordingLogger(),
        env: {},
        hasBuiltUiImpl: async () => true,
        startServerImpl: async () => {
          throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
        },
      }),
      /Port 5173 is already in use/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ui explains permission errors when binding a privileged port', async () => {
  const root = await createWorkspace();
  try {
    await assert.rejects(
      runUiCommand(['--port', '80'], {
        cwd: root,
        logger: recordingLogger(),
        env: {},
        hasBuiltUiImpl: async () => true,
        startServerImpl: async () => {
          throw Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
        },
      }),
      /Cannot bind to port 80/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Static mode server
// ---------------------------------------------------------------------------

test('static server rejects API calls while the normal server answers them', async () => {
  const root = await createWorkspace();
  let staticServer;
  let localServer;

  try {
    staticServer = await startServer({
      dev: false,
      host: '127.0.0.1',
      port: 0,
      workspace: root,
      static: true,
    });
    const blocked = await fetch(`${staticServer.url}/api/health`);
    assert.equal(blocked.status, 404);
    assert.match(blocked.headers.get('content-type') ?? '', /application\/json/);
    const body = await blocked.json();
    assert.match(body.error, /static demo/i);
    assert.deepEqual(body.suggestions, [
      'Run "cleanstack ui" without --static to use the local engine.',
    ]);

    localServer = await startServer({
      dev: false,
      host: '127.0.0.1',
      port: 0,
      workspace: root,
    });
    const healthy = await fetch(`${localServer.url}/api/health`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { ok: true });
  } finally {
    if (staticServer !== undefined) await closeServer(staticServer.server);
    if (localServer !== undefined) await closeServer(localServer.server);
    await rm(root, { recursive: true, force: true });
  }
});
