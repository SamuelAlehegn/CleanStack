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

test('team defaults suppress prompts for provided settings', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-team-defaults-'));
  try {
    await writeFile(
      path.join(cwd, '.cleanstackrc.yml'),
      [
        'packageName: com.team',
        'options:',
        '  database: h2',
        '  auth: none',
        '  buildTool: maven',
        '  frontend: false',
        '  docker: false',
        '',
      ].join('\n'),
    );

    // No --yes: the command must not prompt for settings the team file provides.
    await runNewCommand(['demo', '--no-entities'], { cwd, logger });

    const application = path.join(
      cwd,
      'demo',
      'demo-backend',
      'src/main/resources/application.yml',
    );
    assert.match(await readFile(application, 'utf8'), /jdbc:h2/);
    await assert.rejects(readFile(path.join(cwd, 'demo', 'demo-ui', 'package.json'), 'utf8'), {
      code: 'ENOENT',
    });
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
    assert.match(
      await readFile(path.join(uiRoot, 'api', 'README.md'), 'utf8'),
      /cleanstack openapi/,
    );
    assert.match(
      await readFile(path.join(uiRoot, 'api', 'generated', '.gitkeep'), 'utf8'),
      /^\s*$/,
    );
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

test('rerunning new preserves user code in protected regions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-safe-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities']);
    const servicePath = path.join(
      cwd,
      'demo',
      'demo-backend',
      'src/main/java/com/example/service/GreetingService.java',
    );
    const service = await readFile(servicePath, 'utf8');
    await writeFile(
      servicePath,
      service.replace(
        /(\r?\n)(\s*)\/\/ <\/cleanstack:user-code>/,
        '$1    public String customHook() { return "kept"; }$1$2// </cleanstack:user-code>',
      ),
    );

    await createProject(cwd, ['demo', '--yes', '--no-entities']);
    assert.match(await readFile(servicePath, 'utf8'), /customHook/);

    await createProject(cwd, ['demo', '--yes', '--no-entities', '--force']);
    assert.doesNotMatch(await readFile(servicePath, 'utf8'), /customHook/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('--dry-run reports changes without writing generated files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-new-dry-run-'));
  try {
    await createProject(cwd, ['demo', '--yes', '--no-entities']);
    const servicePath = path.join(
      cwd,
      'demo',
      'demo-backend',
      'src/main/java/com/example/service/GreetingService.java',
    );
    const before = await readFile(servicePath, 'utf8');

    await createProject(cwd, ['demo', '--yes', '--no-entities', '--force', '--dry-run']);
    assert.equal(await readFile(servicePath, 'utf8'), before);

    await runNewCommand(['ghost', '--yes', '--no-entities', '--dry-run'], { cwd, logger });
    await assert.rejects(readFile(path.join(cwd, 'ghost')), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
