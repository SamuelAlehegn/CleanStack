import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

function postJson(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
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
