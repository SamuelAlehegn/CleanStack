import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createProgram, extractGlobalFlags } from '../dist/cli/program.js';

const execFileAsync = promisify(execFile);

const silentLogger = {
  debug() {},
  info() {},
  success() {},
  warn() {},
  error() {},
  table() {},
};

function createHarness() {
  const calls = [];
  const handlers = {
    newCommand: async (args) => calls.push(['new', args]),
    entityCommand: async (args) => calls.push(['entity', args]),
    regenerateCommand: async (args) => calls.push(['regenerate', args]),
    openapiCommand: async (args) => calls.push(['openapi', args]),
    templatesCommand: async (args) => calls.push(['templates', args]),
    configCommand: async (args) => calls.push(['config', args]),
    doctorCommand: async (args) => calls.push(['doctor', args]),
    uiCommand: async (args) => calls.push(['ui', args]),
  };
  const output = { stdout: '', stderr: '' };
  const program = createProgram({
    version: '9.9.9',
    logger: silentLogger,
    handlers,
    exitOverride: true,
  });
  program.configureOutput({
    writeOut: (text) => {
      output.stdout += text;
    },
    writeErr: (text) => {
      output.stderr += text;
    },
  });
  return { calls, program, output };
}

async function route(argv) {
  const harness = createHarness();
  await harness.program.parseAsync(argv, { from: 'user' });
  return harness;
}

// ---------------------------------------------------------------------------
// Global flags
// ---------------------------------------------------------------------------

test('extracts global verbosity flags from any position', () => {
  assert.deepEqual(extractGlobalFlags(['--verbose', 'new', 'demo', '-q']), {
    args: ['new', 'demo'],
    verbose: true,
    quiet: true,
  });
  assert.deepEqual(extractGlobalFlags(['entity', 'Product', '-v', '--quiet']), {
    args: ['entity', 'Product'],
    verbose: true,
    quiet: true,
  });
  assert.deepEqual(extractGlobalFlags(['templates', 'list']), {
    args: ['templates', 'list'],
    verbose: false,
    quiet: false,
  });
});

// ---------------------------------------------------------------------------
// Command routing and aliases
// ---------------------------------------------------------------------------

test('routes new with its own flags intact', async () => {
  const { calls } = await route(['new', 'demo', '--yes', '--db', 'h2']);
  assert.deepEqual(calls, [['new', ['demo', '--yes', '--db', 'h2']]]);
});

test('routes entity, generate entity, and g e to the entity handler', async () => {
  assert.deepEqual((await route(['entity', 'Product'])).calls, [['entity', ['Product']]]);
  assert.deepEqual((await route(['generate', 'entity', 'Product'])).calls, [
    ['entity', ['Product']],
  ]);
  assert.deepEqual((await route(['g', 'e', 'Product', '--field', 'name:String'])).calls, [
    ['entity', ['Product', '--field', 'name:String']],
  ]);
});

test('routes regenerate and its alias', async () => {
  assert.deepEqual((await route(['regenerate', '--all'])).calls, [['regenerate', ['--all']]]);
  assert.deepEqual((await route(['r', 'entity', 'Product'])).calls, [
    ['regenerate', ['entity', 'Product']],
  ]);
});

test('routes openapi and its api alias with flags intact', async () => {
  assert.deepEqual((await route(['openapi', '--input', 'openapi/openapi.json'])).calls, [
    ['openapi', ['--input', 'openapi/openapi.json']],
  ]);
  assert.deepEqual((await route(['api', '--dry-run'])).calls, [['openapi', ['--dry-run']]]);
});

test('routes templates subcommands with their flags', async () => {
  assert.deepEqual((await route(['templates', 'list', 'spring-boot'])).calls, [
    ['templates', ['list', 'spring-boot']],
  ]);
  assert.deepEqual((await route(['templates', 'init', '--force'])).calls, [
    ['templates', ['init', '--force']],
  ]);
  assert.deepEqual((await route(['templates', 'diff'])).calls, [['templates', ['diff']]]);
  assert.deepEqual(
    (await route(['templates', 'reset', 'spring-boot/root/README.md', '--dry-run'])).calls,
    [['templates', ['reset', 'spring-boot/root/README.md', '--dry-run']]],
  );
  // No subcommand defaults to listing.
  assert.deepEqual((await route(['templates'])).calls, [['templates', ['list']]]);
});

test('routes config, doctor, and ui', async () => {
  assert.deepEqual((await route(['config', 'show', '--json'])).calls, [
    ['config', ['show', '--json']],
  ]);
  assert.deepEqual((await route(['doctor'])).calls, [['doctor', []]]);
  assert.deepEqual((await route(['doctor', '--help'])).calls, [['doctor', ['--help']]]);
  assert.deepEqual((await route(['ui'])).calls, [['ui', []]]);
});

test('passes per-command help through so rich usage text is used', async () => {
  assert.deepEqual((await route(['new', 'demo', '--help'])).calls, [['new', ['demo', '--help']]]);
  assert.deepEqual((await route(['templates', 'list', '--help'])).calls, [
    ['templates', ['list', '--help']],
  ]);
});

test('reports unknown commands with exit code 1', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.program.parseAsync(['deploy'], { from: 'user' }),
    (error) => error.exitCode === 1,
  );
  assert.match(harness.output.stderr, /unknown command 'deploy'/);
});

// ---------------------------------------------------------------------------
// Global help and version
// ---------------------------------------------------------------------------

test('--version prints the package version', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.program.parseAsync(['--version'], { from: 'user' }),
    (error) => error.exitCode === 0,
  );
  assert.match(harness.output.stdout, /9\.9\.9/);
});

test('--help lists every command and global flag', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.program.parseAsync(['--help'], { from: 'user' }),
    (error) => error.exitCode === 0,
  );
  for (const command of [
    'new',
    'entity',
    'generate',
    'regenerate',
    'openapi',
    'templates',
    'config',
    'doctor',
    'ui',
  ]) {
    assert.match(harness.output.stdout, new RegExp(`\\b${command}\\b`));
  }
  for (const flag of ['--verbose', '--quiet', '--version', '--help']) {
    assert.match(harness.output.stdout, new RegExp(flag.replace('-', '\\-')));
  }
});

// ---------------------------------------------------------------------------
// Entry point wiring
// ---------------------------------------------------------------------------

const cliEntry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

async function runCli(cwd, args) {
  try {
    const that = await execFileAsync(process.execPath, [cliEntry, ...args], { cwd });
    return { ...that, code: 0 };
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      code: error.code ?? 1,
    };
  }
}

test('entry point prints help with no arguments and with --help', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-cli-'));
  try {
    for (const args of [[], ['--help']]) {
      const result = await runCli(root, args);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Usage: cleanstack/);
      assert.match(result.stdout, /config/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entry point prints the version and fails on unknown commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-cli-'));
  try {
    const version = await runCli(root, ['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

    const unknown = await runCli(root, ['deploy']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown command 'deploy'/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entry point shows new help without generating files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-cli-'));
  try {
    const result = await runCli(root, ['new', 'demo', '--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: cleanstack new/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entry point accepts global flags after the command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-cli-'));
  try {
    const result = await runCli(root, ['templates', 'list', '--verbose']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /spring-boot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
