import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CliOptionError,
  ConfigLoader,
  parseCommandLineOptions,
} from '../dist/core/config-loader.js';

test('parses a positional project name and generation options', () => {
  assert.deepEqual(
    parseCommandLineOptions([
      'new',
      'shop',
      '--db',
      'mysql',
      '--docker',
      '--no-frontend',
      '--output-dir=build',
    ]),
    {
      name: 'shop',
      options: { database: 'mysql', docker: true, frontend: false, outputDir: 'build' },
    },
  );
});

test('supports option aliases and inline boolean values', () => {
  assert.deepEqual(
    parseCommandLineOptions(['--package', 'com.acme', '--build', 'gradle', '--docker=false']),
    { packageName: 'com.acme', options: { buildTool: 'gradle', docker: false } },
  );
});

test('accepts a project name after "--"', () => {
  assert.deepEqual(parseCommandLineOptions(['new', '--', 'my-app']), { name: 'my-app' });
});

test('keeps a positional name after a boolean flag', () => {
  assert.deepEqual(parseCommandLineOptions(['new', '--docker', 'my-app']), {
    name: 'my-app',
    options: { docker: true },
  });
  assert.deepEqual(parseCommandLineOptions(['new', '--docker', 'false', 'my-app']), {
    name: 'my-app',
    options: { docker: false },
  });
});

test('rejects unknown options instead of silently ignoring them', () => {
  assert.throws(
    () => parseCommandLineOptions(['--wat', 'value']),
    (error) => error instanceof CliOptionError && /Unknown option "--wat"/.test(error.message),
  );
});

test('rejects options that are missing a value', () => {
  assert.throws(
    () => parseCommandLineOptions(['--name']),
    (error) => error instanceof CliOptionError && /requires a value/.test(error.message),
  );
});

test('rejects invalid boolean values', () => {
  assert.throws(
    () => parseCommandLineOptions(['--docker=maybe']),
    (error) => error instanceof CliOptionError && /expects "true" or "false"/.test(error.message),
  );
});

test('rejects negating a non-boolean option', () => {
  assert.throws(
    () => parseCommandLineOptions(['--no-package']),
    (error) => error instanceof CliOptionError && /cannot be negated/.test(error.message),
  );
});

test('rejects a project name provided twice', () => {
  assert.throws(
    () => parseCommandLineOptions(['new', 'shop', '--name', 'other']),
    (error) => error instanceof CliOptionError && /more than once/.test(error.message),
  );
});

test('rejects unexpected positional arguments', () => {
  assert.throws(
    () => parseCommandLineOptions(['new', 'shop', 'extra']),
    (error) => error instanceof CliOptionError && /Unexpected argument "extra"/.test(error.message),
  );
});

test('applies schema defaults when no configuration is present', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    const config = await new ConfigLoader().load({ cwd, args: ['shop'] });

    assert.equal(config.name, 'shop');
    assert.equal(config.packageName, 'com.example');
    assert.deepEqual(config.options, {
      backend: true,
      frontend: true,
      database: 'postgresql',
      auth: 'jwt',
      buildTool: 'maven',
      docker: false,
      dryRun: false,
      outputDir: '.',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('merges CLI overrides on top of .cleanstackrc', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    await writeFile(
      path.join(cwd, '.cleanstackrc'),
      JSON.stringify({
        name: 'from-file',
        packageName: 'com.file',
        options: { database: 'h2', docker: false, outputDir: 'generated' },
      }),
    );

    const config = await new ConfigLoader().load({
      cwd,
      args: ['--docker', '--db', 'mysql'],
    });

    assert.equal(config.name, 'from-file');
    assert.equal(config.packageName, 'com.file');
    assert.equal(config.options.database, 'mysql');
    assert.equal(config.options.docker, true);
    assert.equal(config.options.outputDir, 'generated');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('loads cleanstack.config.ts default exports', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    await writeFile(
      path.join(cwd, 'cleanstack.config.ts'),
      "export default { name: 'from-ts', options: { auth: 'keycloak' } };\n",
    );

    const config = await new ConfigLoader().load({ cwd });

    assert.equal(config.name, 'from-ts');
    assert.equal(config.options.auth, 'keycloak');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('rejects unknown configuration keys', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    await writeFile(
      path.join(cwd, '.cleanstackrc'),
      JSON.stringify({ name: 'shop', package: 'com.acme' }),
    );

    await assert.rejects(new ConfigLoader().load({ cwd }), (error) => {
      assert.equal(error.name, 'ZodError');
      assert.ok(error.message.includes('package'));
      return true;
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('reports malformed JSON with the configuration path', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-config-'));
  try {
    const configPath = path.join(cwd, '.cleanstackrc');
    await writeFile(configPath, '{ "name": ');

    await assert.rejects(new ConfigLoader().load({ cwd }), (error) => {
      assert.match(error.message, /Unable to read configuration from/);
      assert.ok(error.message.includes(configPath));
      return true;
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
