import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseConfigCommandArguments, runConfigCommand } from '../dist/cli/config.js';

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
    table(_columns, rows) {
      messages.push(`info: ${rows.map((row) => `${row.setting}=${row.value}`).join(' | ')}`);
    },
  };
}

async function createWorkspace(config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  const valid = {
    name: 'demo',
    packageName: 'com.example',
    entities: [{ name: 'Product', fields: [{ name: 'name', type: 'String' }] }],
    options: { database: 'h2', auth: 'none' },
    ...config,
  };
  await writeFile(path.join(root, 'cleanstack.config.json'), JSON.stringify(valid));
  return root;
}

test('parses config subcommands and flags', () => {
  assert.deepEqual(parseConfigCommandArguments([]), {
    subcommand: 'show',
    json: false,
    help: false,
  });
  assert.deepEqual(parseConfigCommandArguments(['path']), {
    subcommand: 'path',
    json: false,
    help: false,
  });
  assert.deepEqual(parseConfigCommandArguments(['validate', '--json']), {
    subcommand: 'validate',
    json: true,
    help: false,
  });
  assert.equal(parseConfigCommandArguments(['--help']).help, true);
  assert.equal(parseConfigCommandArguments(['show', '--verbose']).subcommand, 'show');
});

test('rejects unknown config subcommands, extra arguments, and options', () => {
  assert.throws(() => parseConfigCommandArguments(['deploy']), /Unknown config subcommand/);
  assert.throws(() => parseConfigCommandArguments(['show', 'path']), /single subcommand/);
  assert.throws(() => parseConfigCommandArguments(['--json=true']), /Unknown option/);
});

test('config show prints a summary table', async () => {
  const root = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runConfigCommand([], { cwd: root, logger });
    const output = logger.messages.join('\n');
    assert.match(output, /Configuration: .*cleanstack\.config\.json/);
    assert.match(output, /Name=demo/);
    assert.match(output, /Package=com\.example/);
    assert.match(output, /Database=h2/);
    assert.match(output, /Migration tool=flyway/);
    assert.match(output, /Seed data=no/);
    assert.match(output, /Auth=none/);
    assert.match(output, /Entities=Product/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config show --json prints the normalized configuration', async () => {
  const root = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runConfigCommand(['show', '--json'], { cwd: root, logger });
    const jsonMessage = logger.messages
      .find((message) => message.startsWith('info: {'))
      ?.slice('info: '.length);
    assert.ok(jsonMessage, 'expected a JSON info message');
    const parsed = JSON.parse(jsonMessage);
    assert.equal(parsed.name, 'demo');
    assert.equal(parsed.options.database, 'h2');
    // Defaults are filled in by the schema.
    assert.equal(parsed.options.buildTool, 'maven');
    assert.equal(parsed.options.backend, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config path prints the configuration file and walks up parents', async () => {
  const root = await createWorkspace();
  try {
    const nested = path.join(root, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    const logger = recordingLogger();
    await runConfigCommand(['path'], { cwd: nested, logger });
    assert.equal(logger.messages.join('\n'), `info: ${path.join(root, 'cleanstack.config.json')}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config validate reports a valid configuration', async () => {
  const root = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runConfigCommand(['validate'], { cwd: root, logger });
    const output = logger.messages.join('\n');
    assert.match(output, /Configuration is valid/);
    assert.match(output, /Project "demo" with 1 entity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config validate rejects an invalid configuration with readable issues', async () => {
  const root = await createWorkspace();
  try {
    await writeFile(
      path.join(root, 'cleanstack.config.json'),
      JSON.stringify({ name: '', packageName: 'not a package' }),
    );
    await assert.rejects(
      runConfigCommand(['validate'], { cwd: root, logger: recordingLogger() }),
      /Invalid configuration in .*cleanstack\.config\.json/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config reports when no configuration file exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    for (const args of [[], ['path'], ['validate']]) {
      await assert.rejects(
        runConfigCommand(args, { cwd: root, logger: recordingLogger(), env: {} }),
        /No CleanStack configuration file was found/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Team defaults, YAML, and environment variables
// ---------------------------------------------------------------------------

test('config show reads team defaults from .cleanstackrc.yml', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    await writeFile(
      path.join(root, '.cleanstackrc.yml'),
      'packageName: com.team\noptions:\n  database: h2\n  auth: none\n',
    );
    const logger = recordingLogger();
    await runConfigCommand(['show'], { cwd: root, logger, env: {} });
    const output = logger.messages.join('\n');
    assert.match(output, /Name=\(not set\)/);
    assert.match(output, /Package=com\.team/);
    assert.match(output, /Database=h2/);
    assert.match(output, /Auth=none/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config validate accepts team defaults without a project name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    await writeFile(
      path.join(root, '.cleanstackrc.yml'),
      'options:\n  database: h2\nentities:\n  - name: Product\n    fields: []\n',
    );
    const logger = recordingLogger();
    await runConfigCommand(['validate'], { cwd: root, logger, env: {} });
    const output = logger.messages.join('\n');
    assert.match(output, /Configuration is valid/);
    assert.match(output, /Team defaults without a project name, with 1 entity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('environment variables override file values in config show', async () => {
  const root = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runConfigCommand(['show'], {
      cwd: root,
      logger,
      env: {
        CLEANSTACK_DATABASE: 'mysql',
        CLEANSTACK_PACKAGE: 'com.env',
        CLEANSTACK_DOCKER: 'true',
      },
    });
    const output = logger.messages.join('\n');
    assert.match(output, /Package=com\.env/);
    assert.match(output, /Database=mysql/);
    assert.match(output, /Docker=yes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLEANSTACK_CONFIG selects the configuration file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    const configDir = path.join(root, 'configs');
    await mkdir(configDir);
    const configPath = path.join(configDir, 'team.yml');
    await writeFile(configPath, 'name: from-env-config\noptions:\n  auth: none\n');

    const logger = recordingLogger();
    await runConfigCommand(['path'], {
      cwd: root,
      logger,
      env: { CLEANSTACK_CONFIG: path.join('configs', 'team.yml') },
    });
    assert.equal(logger.messages.join('\n'), `info: ${configPath}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLEANSTACK_CONFIG reports a missing file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    await assert.rejects(
      runConfigCommand(['path'], {
        cwd: root,
        logger: recordingLogger(),
        env: { CLEANSTACK_CONFIG: 'missing.yml' },
      }),
      /Configuration file .*missing\.yml" does not exist/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
