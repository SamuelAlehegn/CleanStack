import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runEntityCommand } from '../dist/cli/entity.js';
import { runNewCommand } from '../dist/cli/new.js';

const logger = { debug() {}, info() {}, success() {}, warn() {} };

async function generateProject(cwd) {
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
