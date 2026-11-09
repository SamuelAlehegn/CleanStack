import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runEntityCommand } from '../dist/cli/entity.js';
import { runNewCommand } from '../dist/cli/new.js';

const logger = { debug() {}, info() {}, success() {}, warn() {} };

async function generateProject(cwd, optionOverrides = {}) {
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
        ...optionOverrides,
      },
    }),
  );
  await runNewCommand(['demo', '--yes', '--no-entities'], { cwd, logger });
  return path.join(cwd, 'demo');
}

async function readProjectFile(projectRoot, relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('generates backend and frontend artifacts from an entities/ descriptor', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'entities', 'Product.yaml'),
      [
        'name: Product',
        'fields:',
        '  - name: name',
        '    type: String',
        '    required: true',
        '    maxLength: 120',
        '  - name: price',
        '    type: BigDecimal',
        '    required: true',
        '',
      ].join('\n'),
    );

    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/java/com/example/domain/Product.java',
      ),
      /class Product/,
    );
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/java/com/example/controller/ProductController.java',
      ),
      /@RequestMapping\("\/api\/products"\)/,
    );
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/migration/V2__create_products_table.sql',
      ),
      /CREATE TABLE products/,
    );
    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/models/product.ts'),
      /export interface Product/,
    );
    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/services/product.service.ts'),
      /export class ProductService/,
    );
    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/pages/products/list/list.component.ts'),
      /export class ProductListComponent/,
    );
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-ui/src/app/pages/products/detail/detail.component.ts',
      ),
      /export class ProductDetailComponent/,
    );
    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/pages/products/form/form.component.ts'),
      /export class ProductFormComponent/,
    );

    const routes = await readProjectFile(projectRoot, 'demo-ui/src/app/app.routes.ts');
    assert.match(routes, /path: 'products'/);
    assert.match(routes, /module\.ProductListComponent/);

    const layout = await readProjectFile(
      projectRoot,
      'demo-ui/src/app/layout/app-layout/app-layout.component.html',
    );
    assert.match(layout, /routerLink="\/products"/);
    assert.match(layout, /<span>Products<\/span>/);

    const servicePath = 'demo-backend/src/main/java/com/example/service/ProductService.java';
    const customizedService = (await readProjectFile(projectRoot, servicePath)).replace(
      /(\r?\n)(\s*)\/\/ <\/cleanstack:user-code>/,
      '$1    public void customProductHook() {}$1$2// </cleanstack:user-code>',
    );
    await writeFile(path.join(projectRoot, servicePath), customizedService);

    await runEntityCommand(['Product'], { cwd: projectRoot, logger });
    assert.match(await readProjectFile(projectRoot, servicePath), /customProductHook/);

    const updatedRoutes = await readProjectFile(projectRoot, 'demo-ui/src/app/app.routes.ts');
    assert.equal(updatedRoutes.match(/path: 'products'/g)?.length, 1);
    const updatedLayout = await readProjectFile(
      projectRoot,
      'demo-ui/src/app/layout/app-layout/app-layout.component.html',
    );
    assert.equal(updatedLayout.match(/routerLink="\/products"/g)?.length, 1);

    await runEntityCommand(['Product', '--force'], { cwd: projectRoot, logger });
    assert.doesNotMatch(await readProjectFile(projectRoot, servicePath), /customProductHook/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generates only backend artifacts with inline fields and --backend', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-inline-'));
  try {
    const projectRoot = await generateProject(cwd);

    await runEntityCommand(
      [
        'Category',
        '--field',
        'title:String:required:maxLength=80',
        '--table',
        'categories',
        '--backend',
      ],
      { cwd: projectRoot, logger },
    );

    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/java/com/example/domain/Category.java',
      ),
      /@Table\(name = "categories"\)/,
    );
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/migration/V2__create_categories_table.sql',
      ),
      /title VARCHAR\(80\) NOT NULL/,
    );
    await assert.rejects(readProjectFile(projectRoot, 'demo-ui/src/app/models/category.ts'), {
      code: 'ENOENT',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('finds a lowercase descriptor and generates only frontend artifacts with --frontend', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-frontend-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'entities', 'product.yml'),
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    await runEntityCommand(['product', '--frontend'], { cwd: projectRoot, logger });

    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/models/product.ts'),
      /export interface Product/,
    );
    assert.match(
      await readProjectFile(projectRoot, 'demo-ui/src/app/pages/products/list/list.component.ts'),
      /export class ProductListComponent/,
    );
    await assert.rejects(
      readProjectFile(projectRoot, 'demo-backend/src/main/java/com/example/domain/Product.java'),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('accepts an explicit descriptor outside the generated project', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-descriptor-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(cwd, 'descriptors'), { recursive: true });
    await writeFile(
      path.join(cwd, 'descriptors', 'Product.yaml'),
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    await runEntityCommand(
      ['Product', '--descriptor', '../descriptors/Product.yaml', '--backend'],
      { cwd: projectRoot, logger },
    );

    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/java/com/example/domain/Product.java',
      ),
      /class Product/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('--dry-run reports entity changes without writing files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-dry-run-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'entities', 'Product.yaml'),
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    const domainPath = 'demo-backend/src/main/java/com/example/domain/Product.java';
    await runEntityCommand(['Product', '--dry-run'], { cwd: projectRoot, logger });
    await assert.rejects(readProjectFile(projectRoot, domainPath), { code: 'ENOENT' });

    await runEntityCommand(['Product'], { cwd: projectRoot, logger });
    const before = await readProjectFile(projectRoot, domainPath);
    await runEntityCommand(['Product', '--force', '--dry-run'], { cwd: projectRoot, logger });
    assert.equal(await readProjectFile(projectRoot, domainPath), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('reports a missing descriptor with guidance', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-missing-'));
  try {
    const projectRoot = await generateProject(cwd);

    await assert.rejects(runEntityCommand(['Missing'], { cwd: projectRoot, logger }), {
      message: /No descriptor was found for "Missing"/,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('suggests a similar descriptor name and how to define an inline entity', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-typo-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'entities', 'Product.yaml'),
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );

    await assert.rejects(runEntityCommand(['Productt'], { cwd: projectRoot, logger }), (error) => {
      assert.match(error.message, /No descriptor was found for "Productt"/);
      assert.ok(error.suggestions.some((hint) => /Did you mean "Product"/.test(hint)));
      assert.ok(
        error.suggestions.some((hint) => /--field name:String/.test(hint)),
        'expected an inline-entity suggestion',
      );
      return true;
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('creates a descriptive update migration when fields change', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-update-migration-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    const descriptorPath = path.join(projectRoot, 'entities', 'Product.yaml');
    await writeFile(
      descriptorPath,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    await writeFile(
      descriptorPath,
      [
        'name: Product',
        'tableName: catalog_products',
        'fields:',
        '  - name: name',
        '    type: String',
        '    maxLength: 80',
        '    required: true',
        "    default: 'unknown'",
        '  - name: price',
        '    type: BigDecimal',
        '    required: true',
        '  - name: sku',
        '    type: String',
        '    unique: true',
        '',
      ].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    const migrations = await readdir(
      path.join(projectRoot, 'demo-backend/src/main/resources/db/migration'),
    );
    const updateFile = migrations.find((file) => file.startsWith('V3__update_catalog_products_'));
    assert.ok(updateFile, `expected an update migration, got ${migrations.join(', ')}`);
    assert.match(updateFile, /rename_products_to_catalog_products/);
    assert.match(updateFile, /alter_name/);
    assert.match(updateFile, /add_sku/);

    const update = await readProjectFile(
      projectRoot,
      `demo-backend/src/main/resources/db/migration/${updateFile}`,
    );
    assert.match(update, /ALTER TABLE products RENAME TO catalog_products;/);
    assert.match(update, /ALTER COLUMN name SET DATA TYPE VARCHAR\(80\);/);
    assert.match(update, /ALTER COLUMN name SET NOT NULL;/);
    assert.match(update, /ALTER COLUMN name SET DEFAULT 'unknown';/);
    assert.match(update, /ADD COLUMN sku VARCHAR\(255\);/);
    assert.match(update, /uq_catalog_products_sku UNIQUE \(sku\)/);

    // The original create migration is append-only and keeps its version.
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/migration/V2__create_products_table.sql',
      ),
      /CREATE TABLE products/,
    );

    // Running again after the rename must not create a duplicate table.
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });
    const after = await readdir(
      path.join(projectRoot, 'demo-backend/src/main/resources/db/migration'),
    );
    assert.equal(
      after.some((file) => file.startsWith('V4__create_catalog_products_table')),
      false,
      `expected no duplicate create migration, got ${after.join(', ')}`,
    );
    assert.equal(after.filter((file) => file.startsWith('V3__update_catalog_products_')).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generates explicit seed data and supports --seed / --no-seed', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-seed-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    const descriptorPath = path.join(projectRoot, 'entities', 'Product.yaml');
    await writeFile(
      descriptorPath,
      [
        'name: Product',
        'seed: true',
        'fields:',
        '  - name: name',
        '    type: String',
        '  - name: price',
        '    type: BigDecimal',
        '',
      ].join('\n'),
    );

    await runEntityCommand(['Product', '--no-seed'], { cwd: projectRoot, logger });
    const migrationDirectory = path.join(
      projectRoot,
      'demo-backend/src/main/resources/db/migration',
    );
    assert.equal(
      (await readdir(migrationDirectory)).some((file) => file.includes('__seed_')),
      false,
    );

    await runEntityCommand(['Product', '--seed'], { cwd: projectRoot, logger });
    const seeded = (await readdir(migrationDirectory)).find((file) =>
      file.includes('__seed_products.sql'),
    );
    assert.ok(seeded);
    const seed = await readProjectFile(
      projectRoot,
      `demo-backend/src/main/resources/db/migration/${seeded}`,
    );
    assert.match(seed, /INSERT INTO products/);
    assert.match(seed, /'Sample Product'/);

    await writeFile(
      descriptorPath,
      [
        'name: Product',
        'seedData:',
        '  - id: 11111111-1111-4111-8111-111111111111',
        '    name: Existing product',
        '    price: 12.5',
        'fields:',
        '  - name: name',
        '    type: String',
        '  - name: price',
        '    type: BigDecimal',
        '',
      ].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    const seedFiles = (await readdir(migrationDirectory)).filter((file) =>
      file.includes('__seed_products.sql'),
    );
    assert.equal(seedFiles.length, 1, 'a second seed migration must not duplicate rows');

    await writeFile(
      path.join(projectRoot, 'entities', 'Category.yaml'),
      [
        'name: Category',
        'seedData:',
        '  - id: 22222222-2222-4222-8222-222222222222',
        '    name: Existing category',
        'fields:',
        '  - name: name',
        '    type: String',
        '',
      ].join('\n'),
    );
    await runEntityCommand(['Category'], { cwd: projectRoot, logger });
    const categorySeed = (await readdir(migrationDirectory)).find((file) =>
      file.includes('__seed_categories.sql'),
    );
    assert.ok(categorySeed);
    const category = await readProjectFile(
      projectRoot,
      `demo-backend/src/main/resources/db/migration/${categorySeed}`,
    );
    assert.match(category, /22222222-2222-4222-8222-222222222222/);
    assert.match(category, /'Existing category'/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generates Liquibase update and seed changelogs when descriptors change', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-liquibase-update-'));
  try {
    const projectRoot = await generateProject(cwd, { migrationTool: 'liquibase' });
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    const descriptorPath = path.join(projectRoot, 'entities', 'Product.yaml');
    await writeFile(
      descriptorPath,
      ['name: Product', 'fields:', '  - name: name', '    type: String', ''].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    await writeFile(
      descriptorPath,
      [
        'name: Product',
        'fields:',
        '  - name: name',
        '    type: String',
        '  - name: sku',
        '    type: String',
        '    unique: true',
        'seedData:',
        "  - name: 'Demo product'",
        "    sku: 'DEMO-1'",
        '',
      ].join('\n'),
    );
    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    const directory = path.join(
      projectRoot,
      'demo-backend/src/main/resources/db/changelog/changes',
    );
    const files = await readdir(directory);
    const update = files.find((file) => file.startsWith('V3__update_products_add_sku'));
    assert.ok(update, `expected a Liquibase update changelog, got ${files.join(', ')}`);
    const updateContents = await readProjectFile(
      projectRoot,
      `demo-backend/src/main/resources/db/changelog/changes/${update}`,
    );
    assert.match(updateContents, /<addColumn tableName="products">/);
    assert.match(updateContents, /<column name="sku" type="VARCHAR\(255\)">/);
    assert.match(updateContents, /uniqueConstraintName="uq_products_sku"/);

    const seed = files.find((file) => file === 'V4__seed_products.xml');
    assert.ok(seed, `expected a Liquibase seed changelog, got ${files.join(', ')}`);
    const seedContents = await readProjectFile(
      projectRoot,
      `demo-backend/src/main/resources/db/changelog/changes/${seed}`,
    );
    assert.match(seedContents, /<insert tableName="products">/);
    assert.match(seedContents, /<column name="sku" value="DEMO-1"\/>/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generates Liquibase changelogs when the project selects Liquibase', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-entity-liquibase-'));
  try {
    const projectRoot = await generateProject(cwd, { migrationTool: 'liquibase' });
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'entities', 'Product.yaml'),
      [
        'name: Product',
        'fields:',
        '  - name: name',
        '    type: String',
        '    required: true',
        '',
      ].join('\n'),
    );

    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/changelog/changes/V2__create_products_table.xml',
      ),
      /<createTable tableName="products">[\s\S]*<column name="name" type="VARCHAR\(255\)">/,
    );
    assert.match(
      await readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/changelog/db.changelog-master.xml',
      ),
      /includeAll path="changes"/,
    );
    assert.match(
      await readProjectFile(projectRoot, 'demo-backend/src/main/resources/application.yml'),
      /change-log: classpath:db\/changelog\/db\.changelog-master\.xml/,
    );
    await assert.rejects(
      readProjectFile(
        projectRoot,
        'demo-backend/src/main/resources/db/migration/V2__create_products_table.sql',
      ),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
