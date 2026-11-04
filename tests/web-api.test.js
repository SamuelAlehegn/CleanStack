import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { createApiHandler } from '../dist/web/api.js';

async function startApi(workspace) {
  const handler = createApiHandler({ workspace });
  const server = createServer((request, response) => {
    void handler(request, response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function call(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function callBinary(baseUrl, pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { response, buffer };
}

function postJson(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function writeEntityDescriptor(workspace) {
  await mkdir(path.join(workspace, 'entities'), { recursive: true });
  await writeFile(
    path.join(workspace, 'entities', 'Product.yaml'),
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
}

test('web API exposes the shared engine metadata', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-web-meta-'));
  const app = await startApi(workspace);
  context.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const response = await call(app.url, '/api/meta');
  assert.equal(response.status, 200);
  assert.ok(response.body.fieldTypes.includes('String'));
  assert.ok(response.body.fieldTypes.includes('BigDecimal'));
  assert.ok(response.body.validations.includes('Email'));
  assert.deepEqual(response.body.databases, ['postgresql', 'mysql', 'h2']);
  assert.equal(response.body.defaults.database, 'postgresql');
  assert.equal(response.body.defaults.frontend, true);
  assert.equal(response.body.capabilities.localGeneration, true);
  assert.equal(response.body.capabilities.archiveDownload, true);
});

test('web API creates a project and an entity through the CLI engine', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-web-api-'));
  const app = await startApi(workspace);
  context.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const created = await call(
    app.url,
    '/api/projects',
    postJson({
      name: 'demo-shop',
      packageName: 'com.example.demo',
      outputDir: 'apps',
      database: 'h2',
      auth: 'none',
      buildTool: 'maven',
      frontend: false,
      docker: false,
      includeEntities: false,
      git: false,
      force: false,
    }),
  );

  assert.equal(created.status, 201);
  const project = created.body.project;
  assert.equal(project.name, 'demo-shop');
  assert.equal(project.rootDir, path.join(workspace, 'apps', 'demo-shop'));
  assert.equal(project.relativePath, 'apps/demo-shop');
  assert.equal(project.backend, true);
  assert.equal(project.frontend, false);
  assert.deepEqual(project.entities, []);
  assert.ok(created.body.command.includes('new'));
  assert.ok(created.body.command.includes('--no-entities'));
  assert.ok(created.body.command.includes('--no-docker'));
  assert.ok(created.body.command.includes('--no-dry-run'));
  assert.ok(!created.body.command.includes('--git'));
  assert.ok(!created.body.command.includes('--force'));
  assert.ok(created.body.messages.some((message) => message.level === 'success'));

  const workspaceResponse = await call(app.url, '/api/workspace');
  assert.equal(workspaceResponse.status, 200);
  assert.equal(workspaceResponse.body.projects.length, 1);
  assert.equal(workspaceResponse.body.projects[0].rootDir, project.rootDir);

  const fileList = await call(
    app.url,
    `/api/projects/files?path=${encodeURIComponent(project.rootDir)}`,
  );
  assert.equal(fileList.status, 200);
  assert.ok(fileList.body.files.length > 0);
  assert.ok(fileList.body.files.every((file) => !file.path.includes('node_modules')));

  const readme = fileList.body.files.find(
    (file) => file.path === 'README.md' || file.path.endsWith('/README.md'),
  );
  assert.ok(readme, 'generated backend should include README.md');

  const fileContent = await call(
    app.url,
    `/api/projects/file?path=${encodeURIComponent(project.rootDir)}&file=${encodeURIComponent(readme.path)}`,
  );
  assert.equal(fileContent.status, 200);
  assert.equal(fileContent.body.binary, false);
  assert.match(fileContent.body.content, /DemoShopBackend/);

  const entityResponse = await call(
    app.url,
    '/api/entities',
    postJson({
      projectPath: project.rootDir,
      name: 'Product',
      fields: [
        { name: 'name', type: 'String', required: true, maxLength: 120 },
        { name: 'price', type: 'BigDecimal', required: true },
        { name: 'sku', type: 'String', unique: true },
      ],
    }),
  );

  assert.equal(entityResponse.status, 201);
  assert.equal(entityResponse.body.project.entities.length, 1);
  assert.equal(entityResponse.body.project.entities[0].name, 'Product');
  assert.ok(entityResponse.body.command.includes('entity'));
  assert.ok(
    entityResponse.body.messages.some(
      (message) => message.level === 'success' && message.message.includes('Product'),
    ),
  );

  const refreshedFiles = await call(
    app.url,
    `/api/projects/files?path=${encodeURIComponent(project.rootDir)}`,
  );
  const productFile = refreshedFiles.body.files.find((file) => file.path.endsWith('/Product.java'));
  assert.ok(productFile, 'generated entity should create a Product.java file');

  const productContent = await call(
    app.url,
    `/api/projects/file?path=${encodeURIComponent(project.rootDir)}&file=${encodeURIComponent(productFile.path)}`,
  );
  assert.equal(productContent.status, 200);
  assert.match(productContent.body.content, /class Product/);

  const refreshedWorkspace = await call(app.url, '/api/workspace');
  assert.equal(refreshedWorkspace.body.projects[0].entities[0].name, 'Product');

  const duplicate = await call(
    app.url,
    '/api/projects',
    postJson({
      name: 'demo-shop',
      packageName: 'com.example.demo',
      outputDir: 'apps',
      database: 'h2',
      auth: 'none',
      buildTool: 'maven',
      frontend: false,
      docker: false,
    }),
  );
  assert.equal(duplicate.status, 409);

  const unsafe = await call(
    app.url,
    `/api/projects/file?path=${encodeURIComponent(project.rootDir)}&file=${encodeURIComponent('../package.json')}`,
  );
  assert.equal(unsafe.status, 400);
});

test('web API previews, generates, edits, and saves relation-aware entities', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-web-editor-'));
  const app = await startApi(workspace);
  context.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  const created = await call(
    app.url,
    '/api/projects',
    postJson({
      name: 'catalog-demo',
      packageName: 'com.example.catalog',
      outputDir: 'apps',
      database: 'h2',
      auth: 'none',
      buildTool: 'maven',
      frontend: true,
      docker: false,
      includeEntities: false,
      git: false,
      force: false,
    }),
  );
  assert.equal(created.status, 201);
  const project = created.body.project;

  const category = await call(
    app.url,
    '/api/entities',
    postJson({
      projectPath: project.rootDir,
      name: 'Category',
      fields: [
        {
          name: 'name',
          type: 'String',
          required: true,
          maxLength: 80,
          validations: ['NotBlank'],
        },
      ],
      relations: [],
    }),
  );
  assert.equal(category.status, 201);

  const productDefinition = {
    name: 'Product',
    fields: [
      {
        name: 'name',
        type: 'String',
        required: true,
        minLength: 2,
        maxLength: 120,
        validations: ['NotBlank'],
      },
      {
        name: 'price',
        type: 'BigDecimal',
        required: true,
        min: 0,
        validations: ['PositiveOrZero'],
      },
      { name: 'sku', type: 'String', unique: true, pattern: '^[A-Z0-9-]+$' },
      { name: 'status', type: 'String', default: 'draft' },
    ],
    relations: [{ field: 'category', type: 'many-to-one', target: 'Category', required: true }],
  };

  const preview = await call(
    app.url,
    '/api/entities/preview',
    postJson({ projectPath: project.rootDir, ...productDefinition }),
  );
  assert.equal(preview.status, 200);
  assert.match(preview.body.yaml, /name: Product/);
  assert.match(preview.body.yaml, /maxLength: 120/);
  assert.match(preview.body.yaml, /validations:\n\s+- NotBlank/);
  assert.match(preview.body.yaml, /relations:\n\s+- field: category/);
  assert.match(preview.body.yaml, /target: Category/);
  assert.match(preview.body.yaml, /default: draft/);
  assert.ok(preview.body.files.some((file) => file.path.endsWith('/Product.java')));
  assert.ok(preview.body.files.some((file) => file.path.endsWith('/product.ts')));
  assert.ok(preview.body.files.some((file) => file.path.endsWith('/ProductController.java')));

  const afterPreviewFiles = await call(
    app.url,
    `/api/projects/files?path=${encodeURIComponent(project.rootDir)}`,
  );
  assert.ok(
    !afterPreviewFiles.body.files.some((file) => file.path.endsWith('/domain/Product.java')),
    'preview must not write generated files',
  );
  const afterPreviewWorkspace = await call(app.url, '/api/workspace');
  assert.equal(afterPreviewWorkspace.body.projects[0].entities.length, 1);

  const generated = await call(
    app.url,
    '/api/entities',
    postJson({ projectPath: project.rootDir, ...productDefinition }),
  );
  assert.equal(generated.status, 201);
  const product = generated.body.project.entities.find((entity) => entity.name === 'Product');
  assert.ok(product);
  assert.equal(product.fields.find((field) => field.name === 'name').validations[0], 'NotBlank');
  assert.equal(product.relations[0].field, 'category');
  assert.equal(product.relations[0].type, 'many-to-one');

  const generatedFiles = await call(
    app.url,
    `/api/projects/files?path=${encodeURIComponent(project.rootDir)}`,
  );
  const productFile = generatedFiles.body.files.find((file) =>
    file.path.endsWith('/domain/Product.java'),
  );
  assert.ok(productFile);
  const productContent = await call(
    app.url,
    `/api/projects/file?path=${encodeURIComponent(project.rootDir)}&file=${encodeURIComponent(productFile.path)}`,
  );
  assert.match(productContent.body.content, /@ManyToOne/);
  assert.match(productContent.body.content, /category_id/);

  const editedDefinition = {
    ...productDefinition,
    fields: [
      ...productDefinition.fields.map((field) =>
        field.name === 'name' ? { ...field, maxLength: 160 } : field,
      ),
      { name: 'description', type: 'String', maxLength: 500 },
    ],
  };
  const edited = await call(
    app.url,
    '/api/entities',
    postJson({ projectPath: project.rootDir, ...editedDefinition }),
  );
  assert.equal(edited.status, 201);
  const editedProduct = edited.body.project.entities.find((entity) => entity.name === 'Product');
  assert.equal(editedProduct.fields.find((field) => field.name === 'name').maxLength, 160);
  assert.equal(editedProduct.fields.find((field) => field.name === 'status').default, 'draft');
  assert.ok(editedProduct.fields.some((field) => field.name === 'description'));

  const saved = await call(app.url, '/api/entities/yaml', postJson(editedDefinition));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.path, 'entities/Product.yaml');
  assert.equal(saved.body.overwritten, false);
  const savedYaml = await readFile(path.join(workspace, 'entities', 'Product.yaml'), 'utf8');
  assert.match(savedYaml, /maxLength: 160/);
  assert.match(savedYaml, /target: Category/);

  const conflict = await call(app.url, '/api/entities/yaml', postJson(editedDefinition));
  assert.equal(conflict.status, 409);

  const overwritten = await call(
    app.url,
    '/api/entities/yaml',
    postJson({ ...editedDefinition, overwrite: true }),
  );
  assert.equal(overwritten.status, 200);
  assert.equal(overwritten.body.overwritten, true);

  const invalidTarget = await call(
    app.url,
    '/api/entities/preview',
    postJson({
      projectPath: project.rootDir,
      name: 'Review',
      fields: [{ name: 'body', type: 'String' }],
      relations: [{ field: 'product', type: 'many-to-one', target: 'Missing' }],
    }),
  );
  assert.equal(invalidTarget.status, 400);
  assert.match(invalidTarget.body.error, /unknown entity/i);
});

test('web API can include workspace entities and force a regeneration', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-web-entities-'));
  const app = await startApi(workspace);
  context.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  await writeEntityDescriptor(workspace);

  const request = {
    name: 'entity-demo',
    packageName: 'com.example.entitydemo',
    outputDir: 'apps',
    database: 'h2',
    auth: 'none',
    buildTool: 'maven',
    frontend: false,
    docker: false,
    includeEntities: true,
    git: false,
    force: false,
  };

  const created = await call(app.url, '/api/projects', postJson(request));
  assert.equal(created.status, 201);
  assert.ok(created.body.command.includes('--entities'));
  assert.equal(created.body.project.entities.length, 1);
  assert.equal(created.body.project.entities[0].name, 'Product');

  const regenerated = await call(app.url, '/api/projects', postJson({ ...request, force: true }));
  assert.equal(regenerated.status, 201);
  assert.ok(regenerated.body.command.includes('--force'));
  assert.equal(regenerated.body.project.entities[0].name, 'Product');
});

test('web API downloads a ZIP built by the CLI engine', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-web-zip-'));
  const app = await startApi(workspace);
  context.after(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
  });

  await writeEntityDescriptor(workspace);

  const download = await callBinary(
    app.url,
    '/api/projects/download',
    postJson({
      name: 'zip-demo',
      packageName: 'com.example.zipdemo',
      database: 'h2',
      auth: 'none',
      buildTool: 'maven',
      frontend: false,
      docker: true,
      includeEntities: true,
    }),
  );

  assert.equal(download.response.status, 200);
  assert.equal(download.response.headers.get('content-type'), 'application/zip');
  assert.match(download.response.headers.get('content-disposition') ?? '', /zip-demo\.zip/);

  const entries = unzipSync(new Uint8Array(download.buffer));
  const names = Object.keys(entries);
  assert.ok(names.length > 0);
  assert.ok(names.every((name) => name.startsWith('zip-demo/')));
  assert.ok(names.some((name) => name.endsWith('/README.md')));
  assert.ok(names.some((name) => name.endsWith('/Dockerfile')));
  assert.ok(
    names.includes(
      'zip-demo/zip-demo-backend/src/main/java/com/example/zipdemo/domain/Product.java',
    ),
  );
  assert.ok(names.includes('zip-demo/.cleanstack/project.json'));

  const workspaceResponse = await call(app.url, '/api/workspace');
  assert.equal(workspaceResponse.status, 200);
  assert.equal(workspaceResponse.body.projects.length, 0);

  const workspaceEntries = await readdir(workspace);
  assert.ok(!workspaceEntries.includes('zip-demo'));
  assert.ok(workspaceEntries.every((entry) => !entry.startsWith('.cleanstack-archive-')));
});
