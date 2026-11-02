import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNewCommand } from '../dist/cli/new.js';
import { runEntityCommand } from '../dist/cli/entity.js';
import { runRegenerateCommand, parseRegenerateCommandArguments } from '../dist/cli/regenerate.js';

const logger = { debug() {}, info() {}, success() {}, warn() {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function generateProject(cwd, args = []) {
  await writeFile(
    path.join(cwd, 'cleanstack.config.json'),
    JSON.stringify({
      name: 'demo',
      packageName: 'com.example',
      entities: [],
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
  await runNewCommand(['demo', '--yes', '--no-entities', ...args], { cwd, logger });
  return path.join(cwd, 'demo');
}

async function addEntityDescriptor(projectRoot, content) {
  await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
  const lines = content.trim().split('\n');
  const nameLine = lines.find((l) => l.startsWith('name:'));
  const name = nameLine?.split(':')[1]?.trim() ?? 'Entity';
  await writeFile(path.join(projectRoot, 'entities', `${name}.yaml`), content);
}

async function readProjectFile(projectRoot, relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// parseRegenerateCommandArguments unit tests
// ---------------------------------------------------------------------------

test('parses "regenerate" with no arguments as project-skeleton target', () => {
  const result = parseRegenerateCommandArguments([]);
  assert.equal(result.target, 'project');
  assert.equal(result.force, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.help, false);
});

test('parses "regenerate --all"', () => {
  const result = parseRegenerateCommandArguments(['--all']);
  assert.equal(result.target, 'all');
});

test('parses "regenerate entity Product"', () => {
  const result = parseRegenerateCommandArguments(['entity', 'Product']);
  assert.equal(result.target, 'entity');
  assert.equal(result.entityName, 'Product');
});

test('parses --force and --dry-run flags', () => {
  const result = parseRegenerateCommandArguments(['--force', '--dry-run']);
  assert.equal(result.force, true);
  assert.equal(result.dryRun, true);
});

test('parses --backend / --no-backend side flags', () => {
  const backendOnly = parseRegenerateCommandArguments(['--backend']);
  assert.equal(backendOnly.backend, true);
  assert.equal(backendOnly.frontend, undefined);

  const noFrontend = parseRegenerateCommandArguments(['--no-frontend']);
  assert.equal(noFrontend.frontend, false);
  assert.equal(noFrontend.backend, undefined);
});

test('rejects --all combined with a positional entity target', () => {
  assert.throws(() => parseRegenerateCommandArguments(['--all', 'entity', 'Product']), /--all/);
});

test('rejects unknown flags', () => {
  assert.throws(() => parseRegenerateCommandArguments(['--unknown']), /Unknown option/);
});

test('rejects entity target without a name', () => {
  assert.throws(() => parseRegenerateCommandArguments(['entity']), /entity name is required/i);
});

test('rejects unknown regenerate targets', () => {
  assert.throws(() => parseRegenerateCommandArguments(['project']), /Unknown regenerate target/);
});

test('-h sets help flag', () => {
  const result = parseRegenerateCommandArguments(['-h']);
  assert.equal(result.help, true);
});

// ---------------------------------------------------------------------------
// Integration – regenerate project skeleton
// ---------------------------------------------------------------------------

test('regenerate preserves user code in protected regions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-protect-'));
  try {
    const projectRoot = await generateProject(cwd);
    const servicePath = 'demo-backend/src/main/java/com/example/service/GreetingService.java';

    // Inject custom code into a protected region
    const original = await readProjectFile(projectRoot, servicePath);
    const customized = original.replace(
      /(\r?\n)(\s*)\/\/ <\/cleanstack:user-code>/,
      '$1    public String customGreeting() { return "hello"; }$1$2// </cleanstack:user-code>',
    );
    await writeFile(path.join(projectRoot, servicePath), customized);

    // Run regenerate – skeleton only
    await runRegenerateCommand([], { cwd: projectRoot, logger });

    // User code must survive
    assert.match(await readProjectFile(projectRoot, servicePath), /customGreeting/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate --force overwrites protected regions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-force-'));
  try {
    const projectRoot = await generateProject(cwd);
    const servicePath = 'demo-backend/src/main/java/com/example/service/GreetingService.java';

    const original = await readProjectFile(projectRoot, servicePath);
    await writeFile(
      path.join(projectRoot, servicePath),
      original.replace(
        /(\r?\n)(\s*)\/\/ <\/cleanstack:user-code>/,
        '$1    public String customGreeting() { return "hello"; }$1$2// </cleanstack:user-code>',
      ),
    );

    await runRegenerateCommand(['--force'], { cwd: projectRoot, logger });
    assert.doesNotMatch(await readProjectFile(projectRoot, servicePath), /customGreeting/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate --dry-run does not write files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-dryrun-'));
  try {
    const projectRoot = await generateProject(cwd);
    const pomPath = 'demo-backend/pom.xml';
    const before = await readProjectFile(projectRoot, pomPath);

    await runRegenerateCommand(['--force', '--dry-run'], { cwd: projectRoot, logger });
    assert.equal(await readProjectFile(projectRoot, pomPath), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration – regenerate entity <name>
// ---------------------------------------------------------------------------

test('regenerate entity preserves user code in protected regions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-entity-'));
  try {
    const projectRoot = await generateProject(cwd);
    await addEntityDescriptor(
      projectRoot,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    // Generate entity first
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    const servicePath = 'demo-backend/src/main/java/com/example/service/ProductService.java';

    // Inject custom code
    const original = await readProjectFile(projectRoot, servicePath);
    const customized = original.replace(
      /(\r?\n)(\s*)\/\/ <\/cleanstack:user-code>/,
      '$1    public void customHook() {}$1$2// </cleanstack:user-code>',
    );
    await writeFile(path.join(projectRoot, servicePath), customized);

    // Regenerate only this entity
    await runRegenerateCommand(['entity', 'Product'], { cwd: projectRoot, logger });
    assert.match(await readProjectFile(projectRoot, servicePath), /customHook/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate entity errors for unknown entity names', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-unknown-'));
  try {
    const projectRoot = await generateProject(cwd);
    await assert.rejects(
      runRegenerateCommand(['entity', 'Ghost'], { cwd: projectRoot, logger }),
      /No entity named "Ghost" was found/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate entity --force replaces protected regions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-entity-force-'));
  try {
    const projectRoot = await generateProject(cwd);
    await addEntityDescriptor(
      projectRoot,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    const servicePath = 'demo-backend/src/main/java/com/example/service/ProductService.java';
    const original = await readProjectFile(projectRoot, servicePath);
    await writeFile(
      path.join(projectRoot, servicePath),
      original.replace(
        /(\r?\n)(\s*)\/\/ <\/cleanstack:user-code>/,
        '$1    public void customHook() {}$1$2// </cleanstack:user-code>',
      ),
    );

    await runRegenerateCommand(['entity', 'Product', '--force'], { cwd: projectRoot, logger });
    assert.doesNotMatch(await readProjectFile(projectRoot, servicePath), /customHook/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration – regenerate --all
// ---------------------------------------------------------------------------

test('regenerate --all re-generates skeleton and all entities', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-all-'));
  try {
    const projectRoot = await generateProject(cwd);
    await addEntityDescriptor(
      projectRoot,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    // Generate entity first so it's in metadata
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    // Regenerate everything
    await runRegenerateCommand(['--all'], { cwd: projectRoot, logger });

    // Skeleton files still present
    assert.match(
      await readProjectFile(projectRoot, 'demo-backend/pom.xml'),
      /spring-boot-starter-data-jpa/,
    );
    // Entity files regenerated
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/java/com/example/domain/Product.java',
      ),
      /class Product/,
    );
    // Angular routes regenerated
    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/app.routes.ts'),
      /path: 'products'/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate --all preserves existing entity migration version', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-all-migration-'));
  try {
    const projectRoot = await generateProject(cwd);
    await addEntityDescriptor(
      projectRoot,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    // The migration file should exist at V2
    const migrationBefore = await readProjectFile(
      projectRoot,
      'demo-backend/src/main/resources/db/migration/V2__create_products_table.sql',
    );
    assert.match(migrationBefore, /CREATE TABLE products/);

    // Regenerate --all – migration should stay at V2, not shift
    await runRegenerateCommand(['--all'], { cwd: projectRoot, logger });
    const migrationAfter = await readProjectFile(
      projectRoot,
      'demo-backend/src/main/resources/db/migration/V2__create_products_table.sql',
    );
    assert.match(migrationAfter, /CREATE TABLE products/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate --all discovers entities from entities/ directory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-all-discover-'));
  try {
    const projectRoot = await generateProject(cwd);

    // Write descriptor but do NOT run entity command first
    await addEntityDescriptor(
      projectRoot,
      ['name: Category', 'fields:', '  - name: label', '    type: String', ''].join('\n'),
    );

    await runRegenerateCommand(['--all'], { cwd: projectRoot, logger });

    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/java/com/example/domain/Category.java',
      ),
      /class Category/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate --all keeps migrations at their generated version', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-migrations-'));
  try {
    const projectRoot = await generateProject(cwd);
    // Descriptors are listed alphabetically, but Product is generated first so
    // its migration sits at V2 and Category ends up at V3.
    await addEntityDescriptor(
      projectRoot,
      ['name: Category', 'fields:', '  - name: label', '    type: String', ''].join('\n'),
    );
    await addEntityDescriptor(
      projectRoot,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    await runEntityCommand(['Product'], { cwd: projectRoot, logger });
    await runEntityCommand(['Category'], { cwd: projectRoot, logger });

    const migrations = path.join(projectRoot, 'demo-backend/src/main/resources/db/migration');
    assert.match(
      await readFile(path.join(migrations, 'V2__create_products_table.sql'), 'utf8'),
      /CREATE TABLE products/,
    );
    assert.match(
      await readFile(path.join(migrations, 'V3__create_categories_table.sql'), 'utf8'),
      /CREATE TABLE categories/,
    );

    await runRegenerateCommand(['--all'], { cwd: projectRoot, logger });

    // The renumbered destinations must not appear.
    await assert.rejects(
      readFile(path.join(migrations, 'V2__create_categories_table.sql'), 'utf8'),
      { code: 'ENOENT' },
    );
    await assert.rejects(readFile(path.join(migrations, 'V3__create_products_table.sql'), 'utf8'), {
      code: 'ENOENT',
    });
    assert.match(
      await readFile(path.join(migrations, 'V2__create_products_table.sql'), 'utf8'),
      /CREATE TABLE products/,
    );
    assert.match(
      await readFile(path.join(migrations, 'V3__create_categories_table.sql'), 'utf8'),
      /CREATE TABLE categories/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration – generation metadata
// ---------------------------------------------------------------------------

test('cleanstack new records generation metadata for regeneration', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-metadata-'));
  try {
    const projectRoot = await generateProject(cwd);

    const metadata = JSON.parse(
      await readFile(path.join(projectRoot, '.cleanstack', 'project.json'), 'utf8'),
    );
    assert.equal(metadata.version, 1);
    assert.equal(metadata.config.name, 'demo');
    assert.equal(metadata.config.packageName, 'com.example');
    assert.equal(metadata.config.options.database, 'h2');
    assert.equal(metadata.config.options.buildTool, 'maven');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('regenerate falls back to configuration when metadata is missing', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-regen-fallback-'));
  try {
    const projectRoot = await generateProject(cwd);
    const controllerPath =
      'demo-backend/src/main/java/com/example/controller/GreetingController.java';

    // Remove the metadata used by regenerate and damage a generated file.
    await rm(path.join(projectRoot, '.cleanstack'), { recursive: true, force: true });
    const controller = await readProjectFile(projectRoot, controllerPath);
    await writeFile(
      path.join(projectRoot, controllerPath),
      `${controller}\n    // stray-browser-change\n`,
    );

    // The configuration found next to the generated project drives the rerun.
    await runRegenerateCommand([], { cwd: projectRoot, logger });
    const restored = await readProjectFile(projectRoot, controllerPath);
    assert.equal(restored, controller);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
