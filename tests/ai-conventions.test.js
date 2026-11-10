import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNewCommand } from '../dist/cli/new.js';
import { runRegenerateCommand } from '../dist/cli/regenerate.js';

const logger = { debug() {}, info() {}, success() {}, warn() {}, error() {} };

const RULE_FILES = [
  '.ai/README.md',
  '.ai/rules/architecture.md',
  '.ai/rules/naming-conventions.md',
  '.ai/rules/protected-regions.md',
  '.ai/rules/adding-an-entity.md',
];

async function createProject(cwd, args, entities = []) {
  await writeFile(
    path.join(cwd, 'cleanstack.config.json'),
    JSON.stringify({
      name: 'configured-name',
      packageName: 'com.example',
      entities,
      options: {
        backend: true,
        frontend: true,
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

test('new generates workspace-root architecture docs and .ai rules for agents', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-ai-new-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities']);

    const root = path.join(cwd, 'demo');
    for (const file of ['ARCHITECTURE.md', 'AGENTS.md', ...RULE_FILES]) {
      const contents = await readFile(path.join(root, ...file.split('/')), 'utf8');
      assert.ok(contents.length > 0, `${file} should not be empty`);
    }

    const architecture = await readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
    assert.match(architecture, /# Demo — Architecture/);
    assert.match(architecture, /demo-backend\/ARCHITECTURE\.md/);
    assert.match(architecture, /demo-ui/);
    assert.match(architecture, /architecture\.project-notes/);

    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /\.ai\/rules\/naming-conventions\.md/);
    assert.match(agents, /cleanstack:user-code/);

    const naming = await readFile(path.join(root, '.ai/rules/naming-conventions.md'), 'utf8');
    assert.match(naming, /ProductController/);
    assert.match(naming, /product\.service\.ts/);
    assert.match(naming, /\/api\/products/);

    const regions = await readFile(path.join(root, '.ai/rules/protected-regions.md'), 'utf8');
    assert.match(regions, /cleanstack regenerate --dry-run/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('new without a frontend keeps .ai rules but drops ui references', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-ai-backend-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities', '--frontend', 'none']);

    const root = path.join(cwd, 'demo');
    for (const file of ['ARCHITECTURE.md', 'AGENTS.md', ...RULE_FILES]) {
      await readFile(path.join(root, ...file.split('/')), 'utf8');
    }

    const architecture = await readFile(path.join(root, 'ARCHITECTURE.md'), 'utf8');
    assert.doesNotMatch(architecture, /demo-ui/);

    const architectureRules = await readFile(path.join(root, '.ai/rules/architecture.md'), 'utf8');
    assert.match(architectureRules, /generated without a frontend/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('--dry-run does not write the .ai rules', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-ai-dry-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities', '--dry-run']);

    await assert.rejects(readFile(path.join(cwd, 'demo', 'AGENTS.md'), 'utf8'), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(path.join(cwd, 'demo', '.ai', 'README.md'), 'utf8'), {
      code: 'ENOENT',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate refreshes root docs but preserves notes in the protected region', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-ai-regen-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities']);

    const architecturePath = path.join(cwd, 'demo', 'ARCHITECTURE.md');
    const original = await readFile(architecturePath, 'utf8');
    assert.match(
      original,
      /<cleanstack:user-code id="architecture\.project-notes" checksum="sha256:[0-9a-f]{64}">/,
    );
    const withNote = original.replace(
      /(<cleanstack:user-code id="architecture\.project-notes"[^>]*> -->)/,
      '$1\nCustom workspace note kept across regenerations.',
    );
    await writeFile(architecturePath, withNote);

    await runRegenerateCommand([], { cwd: path.join(cwd, 'demo'), logger });

    const regenerated = await readFile(architecturePath, 'utf8');
    assert.match(regenerated, /Custom workspace note kept across regenerations\./);
    assert.match(regenerated, /# Demo — Architecture/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate entity leaves workspace-root docs untouched', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-ai-entity-'));
  try {
    await createProject(
      cwd,
      ['demo', '--yes', '--frontend', 'none'],
      [
        {
          name: 'Product',
          fields: [{ name: 'name', type: 'String', required: true }],
        },
      ],
    );

    const agentsPath = path.join(cwd, 'demo', 'AGENTS.md');
    const original = await readFile(agentsPath, 'utf8');
    const withEdit = `${original}\nHandwritten agent addendum.\n`;
    await writeFile(agentsPath, withEdit);

    await runRegenerateCommand(['entity', 'Product'], {
      cwd: path.join(cwd, 'demo'),
      logger,
    });

    assert.equal(await readFile(agentsPath, 'utf8'), withEdit);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
