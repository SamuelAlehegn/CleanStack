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

test('generates Angular CRUD pages and routes for configured entities', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-angular-entities-'));
  try {
    await writeFile(
      path.join(cwd, 'cleanstack.config.json'),
      JSON.stringify({
        name: 'configured-name',
        packageName: 'com.example',
        entities: [
          {
            name: 'Product',
            fields: [{ name: 'name', type: 'String', required: true, maxLength: 120 }],
          },
        ],
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
    await runNewCommand(['demo', '--yes'], { cwd, logger });

    const uiRoot = path.join(cwd, 'demo', 'demo-ui', 'src', 'app');
    assert.match(await readFile(path.join(uiRoot, 'app.routes.ts'), 'utf8'), /path: 'products'/);
    assert.match(
      await readFile(path.join(uiRoot, 'models', 'product.ts'), 'utf8'),
      /export interface Product/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'services', 'product.service.ts'), 'utf8'),
      /export class ProductService/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'pages', 'products', 'list', 'list.component.ts'), 'utf8'),
      /export class ProductListComponent/,
    );
    assert.match(
      await readFile(
        path.join(uiRoot, 'pages', 'products', 'detail', 'detail.component.ts'),
        'utf8',
      ),
      /export class ProductDetailComponent/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'pages', 'products', 'form', 'form.component.ts'), 'utf8'),
      /export class ProductFormComponent/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'app.component.ts'), 'utf8'),
      /export class AppComponent/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'layout', 'app-layout', 'app-layout.component.ts'), 'utf8'),
      /export class AppLayoutComponent/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'app.routes.ts'), 'utf8'),
      /component: AppLayoutComponent/,
    );
    assert.match(await readFile(path.join(uiRoot, '..', 'styles.scss'), 'utf8'), /:root/);
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
