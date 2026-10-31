import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNewCommand } from '../dist/cli/new.js';

const logger = { debug() {}, info() {}, success() {}, warn() {} };

async function createProject(
  cwd,
  args,
  entities = [
    {
      name: 'Product',
      fields: [{ name: 'name', type: 'String', required: true }],
    },
  ],
) {
  await writeFile(
    path.join(cwd, 'cleanstack.config.json'),
    JSON.stringify({
      name: 'configured-name',
      packageName: 'com.example',
      entities,
      options: {
        backend: true,
        frontend: false,
        database: 'h2',
        auth: 'none',
        buildTool: 'maven',
        docker: false,
        dryRun: false,
        outputDir: '.',
      },
    }),
  );
  await runNewCommand(args, { cwd, logger });
}

test('generates configured entities by default when prompts are skipped', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-entities-'));
  try {
    await createProject(cwd, ['demo', '--yes']);

    const generated = path.join(
      cwd,
      'demo',
      'demo-backend',
      'src/main/java/com/example/domain/Product.java',
    );
    assert.match(await readFile(generated, 'utf8'), /@Entity/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('--no-entities skips configured entities', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-no-entities-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities']);

    const generated = path.join(
      cwd,
      'demo',
      'demo-backend',
      'src/main/java/com/example/domain/Product.java',
    );
    await assert.rejects(readFile(generated, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('--entities handles a missing entities directory when no config entities exist', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-empty-entities-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--entities'], []);
    assert.match(
      await readFile(path.join(cwd, 'demo', 'demo-backend', 'pom.xml'), 'utf8'),
      /spring-boot-starter-data-jpa/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
