import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNewCommand } from '../dist/cli/new.js';
import { parseOpenApiCommandArguments, runOpenApiCommand } from '../dist/cli/openapi.js';
import {
  DEFAULT_OPENAPI_CLIENT_DIRECTORY,
  generateAngularClient,
  loadOpenApiDocument,
  parseOpenApiDocument,
  syncOpenApiClient,
} from '../dist/core/openapi-client.js';

const silentLogger = {
  debug() {},
  info() {},
  success() {},
  warn() {},
  error() {},
};

const OPENAPI_SPEC = `openapi: 3.0.3
info:
  title: Demo API
  version: 1.0.0
paths:
  /api/products:
    get:
      operationId: listProducts
      responses:
        '200':
          description: Product list
`;

function recordingLogger() {
  const messages = [];
  const record = (level) => (message) => messages.push(`${level}: ${message}`);
  return {
    messages,
    debug: record('debug'),
    info: record('info'),
    success: record('success'),
    warn: record('warn'),
    error: record('error'),
  };
}

async function generateProject(cwd, { frontend = true } = {}) {
  await writeFile(
    path.join(cwd, 'cleanstack.config.json'),
    JSON.stringify({
      name: 'demo',
      packageName: 'com.example',
      entities: [],
      options: {
        backend: true,
        frontend,
        database: 'h2',
        auth: 'none',
        buildTool: 'maven',
        docker: false,
        dryRun: false,
        outputDir: '.',
      },
    }),
  );
  await runNewCommand(['demo', '--yes', '--no-entities'], { cwd, logger: silentLogger });
  return path.join(cwd, 'demo');
}

/** Fake generator that writes a mutable set of files into the staging directory. */
function fakeGenerator(files) {
  return async ({ outputDir }) => {
    for (const [relativePath, contents] of Object.entries(files)) {
      const target = path.join(outputDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await mkdir(path.join(outputDir, '.openapi-generator'), { recursive: true });
    await writeFile(path.join(outputDir, '.openapi-generator', 'FILES'), 'metadata');
  };
}

async function readManifest(projectRoot) {
  return JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        'demo-ui',
        DEFAULT_OPENAPI_CLIENT_DIRECTORY,
        '.cleanstack-openapi.json',
      ),
      'utf8',
    ),
  );
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('parses openapi defaults and value options', () => {
  assert.deepEqual(parseOpenApiCommandArguments([]), {
    force: false,
    dryRun: false,
    help: false,
  });

  const parsed = parseOpenApiCommandArguments([
    '--input',
    'http://localhost:8080/v3/api-docs',
    '--output=libs/api',
    '-g',
    'typescript-angular',
    '--force',
    '--dry-run',
  ]);
  assert.equal(parsed.input, 'http://localhost:8080/v3/api-docs');
  assert.equal(parsed.output, 'libs/api');
  assert.equal(parsed.generator, 'typescript-angular');
  assert.equal(parsed.force, true);
  assert.equal(parsed.dryRun, true);
});

test('accepts a positional spec and short aliases', () => {
  assert.equal(
    parseOpenApiCommandArguments(['openapi/openapi.json']).input,
    'openapi/openapi.json',
  );
  assert.equal(parseOpenApiCommandArguments(['-i', 'spec.yaml']).input, 'spec.yaml');
  assert.equal(parseOpenApiCommandArguments(['--spec', 'spec.json']).input, 'spec.json');
  assert.equal(parseOpenApiCommandArguments(['-o', 'src/app/api']).output, 'src/app/api');
});

test('rejects ambiguous or malformed openapi arguments', () => {
  assert.throws(
    () => parseOpenApiCommandArguments(['spec.yaml', '--input', 'other.yaml']),
    /either as an argument or with --input/,
  );
  assert.throws(
    () => parseOpenApiCommandArguments(['one.yaml', 'two.yaml']),
    /Unexpected argument/,
  );
  assert.throws(() => parseOpenApiCommandArguments(['--input']), /requires a value/);
  assert.throws(() => parseOpenApiCommandArguments(['--nope']), /Unknown option/);
});

test('openapi help flag is parsed without validation', () => {
  assert.equal(parseOpenApiCommandArguments(['--help']).help, true);
  assert.equal(parseOpenApiCommandArguments(['-h']).help, true);
});

// ---------------------------------------------------------------------------
// Document validation
// ---------------------------------------------------------------------------

test('parses YAML and JSON OpenAPI 3 documents', () => {
  const yaml = parseOpenApiDocument(OPENAPI_SPEC, 'spec.yaml');
  assert.equal(yaml.specVersion, '3.0.3');
  assert.equal(yaml.title, 'Demo API');
  assert.equal(yaml.version, '1.0.0');
  assert.match(yaml.hash, /^[a-f0-9]{64}$/);

  const json = parseOpenApiDocument(
    JSON.stringify({ openapi: '3.1.0', info: { title: 'JSON API', version: '2' }, paths: {} }),
    'spec.json',
  );
  assert.equal(json.specVersion, '3.1.0');
  assert.equal(json.title, 'JSON API');
});

test('rejects Swagger 2, missing versions, and invalid YAML', () => {
  assert.throws(
    () => parseOpenApiDocument('swagger: "2.0"\npaths: {}', 'old.yaml'),
    /Swagger 2\.0/,
  );
  assert.throws(
    () => parseOpenApiDocument('info: { title: Nope }', 'not-openapi.yaml'),
    /not an OpenAPI 3/,
  );
  assert.throws(() => parseOpenApiDocument('openapi: 4.0.0', 'future.yaml'), /only OpenAPI 3/);
  assert.throws(() => parseOpenApiDocument('openapi: [', 'broken.yaml'), /Could not parse/);
});

test('loads an OpenAPI document from a URL before validating it', async () => {
  const project = {
    rootDir: '/tmp/demo',
    relativeRootDir: '.',
    workspaceRoot: '/tmp/demo',
    frontend: { directory: '/tmp/demo/demo-ui', relativeDirectory: 'demo-ui' },
  };
  const document = await loadOpenApiDocument({
    project,
    cwd: '/tmp/demo',
    input: 'http://localhost:8080/v3/api-docs',
    fetchImpl: async () => new Response(OPENAPI_SPEC, { status: 200 }),
  });
  assert.equal(document.title, 'Demo API');
  assert.equal(document.filePath, undefined);
});

test('reports unreachable and failed URL downloads', async () => {
  const project = {
    rootDir: '/tmp/demo',
    relativeRootDir: '.',
    workspaceRoot: '/tmp/demo',
    frontend: { directory: '/tmp/demo/demo-ui', relativeDirectory: 'demo-ui' },
  };
  await assert.rejects(
    loadOpenApiDocument({
      project,
      cwd: '/tmp/demo',
      input: 'http://localhost:8080/v3/api-docs',
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    }),
    /Could not download/,
  );
  await assert.rejects(
    loadOpenApiDocument({
      project,
      cwd: '/tmp/demo',
      input: 'http://localhost:8080/v3/api-docs',
      fetchImpl: async () => new Response('nope', { status: 404, statusText: 'Not Found' }),
    }),
    /HTTP 404/,
  );
});

// ---------------------------------------------------------------------------
// Safe synchronization
// ---------------------------------------------------------------------------

async function createSyncFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-openapi-sync-'));
  const staging = path.join(root, 'staging');
  const target = path.join(root, 'target');
  await mkdir(path.join(staging, 'api'), { recursive: true });
  await mkdir(path.join(staging, 'model'), { recursive: true });
  await writeFile(
    path.join(staging, 'api', 'product.service.ts'),
    'export class ProductService {}',
  );
  await writeFile(path.join(staging, 'model', 'product.ts'), 'export interface Product {}');
  await mkdir(path.join(staging, '.openapi-generator'), { recursive: true });
  await writeFile(path.join(staging, '.openapi-generator', 'FILES'), 'api/product.service.ts');
  return {
    root,
    staging,
    target,
    options: {
      stagingDir: staging,
      targetDir: target,
      generator: 'typescript-angular',
      specSource: 'openapi.yaml',
      specHash: 'abc123',
    },
  };
}

test('creates the client and a manifest on first sync', async () => {
  const fixture = await createSyncFixture();
  try {
    const result = await syncOpenApiClient(fixture.options);
    assert.deepEqual(result.created, ['api/product.service.ts', 'model/product.ts']);
    assert.equal(result.updated.length, 0);
    assert.equal(result.removed.length, 0);

    assert.equal(
      await readFile(path.join(fixture.target, 'api', 'product.service.ts'), 'utf8'),
      'export class ProductService {}',
    );
    const manifest = JSON.parse(
      await readFile(path.join(fixture.target, '.cleanstack-openapi.json'), 'utf8'),
    );
    assert.equal(manifest.version, 1);
    assert.equal(manifest.generatedBy, 'cleanstack');
    assert.equal(manifest.spec.source, 'openapi.yaml');
    assert.equal(
      await readFile(path.join(fixture.target, '.openapi-generator'), 'utf8').catch(
        () => 'missing',
      ),
      'missing',
      'generator metadata must not be copied into the project',
    );
    assert.equal(manifest.files['api/product.service.ts'].length, 64);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('regeneration updates, removes stale, and preserves unknown files', async () => {
  const fixture = await createSyncFixture();
  try {
    await syncOpenApiClient(fixture.options);
    await writeFile(path.join(fixture.target, 'custom-adapter.ts'), 'export const adapter = true;');

    await writeFile(
      path.join(fixture.staging, 'api', 'product.service.ts'),
      'export class ProductService { list() {} }',
    );
    await rm(path.join(fixture.staging, 'model', 'product.ts'));
    await mkdir(path.join(fixture.staging, 'model'), { recursive: true });
    await writeFile(
      path.join(fixture.staging, 'model', 'category.ts'),
      'export interface Category {}',
    );

    const result = await syncOpenApiClient(fixture.options);
    assert.deepEqual(result.updated, ['api/product.service.ts']);
    assert.deepEqual(result.created, ['model/category.ts']);
    assert.deepEqual(result.removed, ['model/product.ts']);
    assert.deepEqual(result.preserved, ['custom-adapter.ts']);

    await assert.rejects(readFile(path.join(fixture.target, 'model', 'product.ts')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(path.join(fixture.target, 'model', 'category.ts'), 'utf8'),
      'export interface Category {}',
    );
    assert.equal(
      await readFile(path.join(fixture.target, 'custom-adapter.ts'), 'utf8'),
      'export const adapter = true;',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('refuses unmanaged non-empty targets and --force preserves unknown files', async () => {
  const fixture = await createSyncFixture();
  try {
    await mkdir(fixture.target, { recursive: true });
    await writeFile(path.join(fixture.target, 'existing.ts'), 'user file');
    await writeFile(path.join(fixture.target, 'product.ts'), 'polluted');

    await assert.rejects(syncOpenApiClient(fixture.options), /unmanaged non-empty directory/);

    const forced = await syncOpenApiClient({ ...fixture.options, force: true });
    assert.equal(forced.created.length, 2);
    assert.equal(
      await readFile(path.join(fixture.target, 'existing.ts'), 'utf8'),
      'user file',
      'unknown files must survive --force',
    );
    assert.equal(await readFile(path.join(fixture.target, 'product.ts'), 'utf8'), 'polluted');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('dry-run reports changes without touching the project', async () => {
  const fixture = await createSyncFixture();
  try {
    await syncOpenApiClient(fixture.options);
    const before = await readFile(path.join(fixture.target, 'api', 'product.service.ts'), 'utf8');
    await writeFile(
      path.join(fixture.staging, 'api', 'product.service.ts'),
      'export class ProductService { changed() {} }',
    );
    await rm(path.join(fixture.staging, 'model', 'product.ts'));

    const result = await syncOpenApiClient({ ...fixture.options, dryRun: true });
    assert.deepEqual(result.updated, ['api/product.service.ts']);
    assert.deepEqual(result.removed, ['model/product.ts']);
    assert.equal(
      await readFile(path.join(fixture.target, 'api', 'product.service.ts'), 'utf8'),
      before,
    );
    assert.match(
      await readFile(path.join(fixture.target, 'model', 'product.ts'), 'utf8'),
      /Product/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('warns when a tracked generated file was edited by hand', async () => {
  const fixture = await createSyncFixture();
  try {
    await syncOpenApiClient(fixture.options);
    await writeFile(
      path.join(fixture.target, 'api', 'product.service.ts'),
      'export class ProductService { userEdit() {} }',
    );

    const result = await syncOpenApiClient(fixture.options);
    assert.ok(
      result.warnings.some((warning) => warning.includes('api/product.service.ts')),
      'modified generated files should produce a warning',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects collisions with untracked files unless --force is used', async () => {
  const fixture = await createSyncFixture();
  try {
    await syncOpenApiClient(fixture.options);
    await writeFile(path.join(fixture.target, 'extra.ts'), 'user file');
    await writeFile(path.join(fixture.staging, 'extra.ts'), 'generated file');

    await assert.rejects(syncOpenApiClient(fixture.options), /would replace unmanaged files/);
    const result = await syncOpenApiClient({ ...fixture.options, force: true });
    assert.ok(result.updated.includes('extra.ts'));
    assert.equal(await readFile(path.join(fixture.target, 'extra.ts'), 'utf8'), 'generated file');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Command integration
// ---------------------------------------------------------------------------

test('openapi command discovers a spec and regenerates safely', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-openapi-command-'));
  try {
    const projectRoot = await generateProject(cwd);
    await mkdir(path.join(projectRoot, 'openapi'), { recursive: true });
    await writeFile(path.join(projectRoot, 'openapi', 'openapi.yaml'), OPENAPI_SPEC);

    const files = {
      'api/product.service.ts': 'export class ProductService { list() {} }',
      'model/product.ts': 'export interface Product { id: string }',
    };
    const logger = recordingLogger();
    await runOpenApiCommand([], {
      cwd: projectRoot,
      logger,
      runGenerator: fakeGenerator(files),
    });

    const clientRoot = path.join(projectRoot, 'demo-ui', DEFAULT_OPENAPI_CLIENT_DIRECTORY);
    assert.match(
      await readFile(path.join(clientRoot, 'api', 'product.service.ts'), 'utf8'),
      /list/,
    );
    const manifest = await readManifest(projectRoot);
    assert.equal(manifest.spec.source, path.join(projectRoot, 'openapi', 'openapi.yaml'));
    assert.equal(manifest.files['api/product.service.ts'].length, 64);
    assert.match(logger.messages.join('\n'), /Generated API client/);

    // Add a user-owned file and remove a generated file; regeneration should
    // preserve the first and delete only the stale tracked file.
    await writeFile(path.join(clientRoot, 'custom.ts'), 'custom');
    delete files['model/product.ts'];
    files['api/product.service.ts'] =
      'export class ProductService { list(): string[] { return []; } }';

    await runOpenApiCommand(['--input', path.join(projectRoot, 'openapi', 'openapi.yaml')], {
      cwd: projectRoot,
      logger: silentLogger,
      runGenerator: fakeGenerator(files),
    });

    assert.equal(await readFile(path.join(clientRoot, 'custom.ts'), 'utf8'), 'custom');
    await assert.rejects(readFile(path.join(clientRoot, 'model', 'product.ts')), {
      code: 'ENOENT',
    });
    assert.match(
      await readFile(path.join(clientRoot, 'api', 'product.service.ts'), 'utf8'),
      /return \[\]/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('openapi command supports a custom output inside the Angular project', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-openapi-output-'));
  try {
    const projectRoot = await generateProject(cwd);
    const spec = path.join(projectRoot, 'contract.json');
    await writeFile(spec, JSON.stringify({ openapi: '3.0.0', paths: {} }));

    await runOpenApiCommand(['--input', spec, '--output', 'libs/api'], {
      cwd: projectRoot,
      logger: silentLogger,
      runGenerator: fakeGenerator({ 'client.ts': 'export const client = true;' }),
    });

    assert.equal(
      await readFile(path.join(projectRoot, 'demo-ui', 'libs', 'api', 'client.ts'), 'utf8'),
      'export const client = true;',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('openapi command rejects outputs outside the Angular project', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-openapi-unsafe-'));
  try {
    const projectRoot = await generateProject(cwd);
    const spec = path.join(projectRoot, 'contract.json');
    await writeFile(spec, JSON.stringify({ openapi: '3.0.0', paths: {} }));

    await assert.rejects(
      runOpenApiCommand(['--input', spec, '--output', '../outside'], {
        cwd: projectRoot,
        logger: silentLogger,
        runGenerator: fakeGenerator({ 'client.ts': 'export const client = true;' }),
      }),
      /outside the filesystem root/,
    );
    await assert.rejects(readFile(path.join(projectRoot, 'outside', 'client.ts')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('openapi command fails when the project has no Angular app', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-openapi-no-ui-'));
  try {
    const projectRoot = await generateProject(cwd, { frontend: false });
    const spec = path.join(projectRoot, 'contract.json');
    await writeFile(spec, JSON.stringify({ openapi: '3.0.0', paths: {} }));

    await assert.rejects(
      runOpenApiCommand(['--input', spec], {
        cwd: projectRoot,
        logger: silentLogger,
        runGenerator: fakeGenerator({ 'client.ts': 'export const client = true;' }),
      }),
      /No Angular project was found/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generateAngularClient downloads a URL spec and reports a dry run', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-openapi-url-'));
  try {
    const projectRoot = await generateProject(cwd);
    const project = {
      rootDir: projectRoot,
      relativeRootDir: '.',
      workspaceRoot: projectRoot,
      frontend: {
        directory: path.join(projectRoot, 'demo-ui'),
        relativeDirectory: 'demo-ui',
      },
    };
    const result = await generateAngularClient({
      project,
      cwd: projectRoot,
      logger: silentLogger,
      input: 'http://localhost:8080/v3/api-docs',
      dryRun: true,
      fetchImpl: async () => new Response(OPENAPI_SPEC, { status: 200 }),
      runGenerator: fakeGenerator({ 'client.ts': 'export const client = true;' }),
    });

    assert.equal(result.spec.title, 'Demo API');
    assert.deepEqual(result.created, ['client.ts']);
    assert.equal(result.dryRun, true);
    await assert.rejects(
      readFile(path.join(projectRoot, 'demo-ui', DEFAULT_OPENAPI_CLIENT_DIRECTORY, 'client.ts')),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      readFile(
        path.join(
          projectRoot,
          'demo-ui',
          DEFAULT_OPENAPI_CLIENT_DIRECTORY,
          '.cleanstack-openapi.json',
        ),
      ),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
