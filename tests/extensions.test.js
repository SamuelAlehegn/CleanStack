import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runExtensionsCommand } from '../dist/cli/extensions.js';
import { ExtensionRegistrySet, loadExtensions } from '../dist/core/extensions/index.js';
import {
  getActiveRegistry,
  resetActiveRegistry,
  resolveActiveFieldType,
} from '../dist/core/extensions/registry.js';
import { buildEntityModels } from '../dist/core/entity-model.js';
import { EntityParser } from '../dist/core/entity-parser.js';
import { sqlTypeForField } from '../dist/core/sql-types.js';
import { ExtensionRegistryError } from '../dist/core/extensions/registry.js';
import { ExtensionError } from '../dist/core/extensions/loader.js';

const silentLogger = {
  debug() {},
  info() {},
  success() {},
  warn() {},
  error() {},
  table() {},
};

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-extensions-'));
  return root;
}

async function writeExtension(rootPath, fileName, code) {
  const directory = path.join(rootPath, '.cleanstack', 'extensions');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, fileName), code);
}

const MONEY_EXTENSION = `
export default {
  name: 'money',
  register(registry) {
    registry.registerFieldType({
      name: 'Money',
      javaType: 'BigDecimal',
      javaImports: ['java.math.BigDecimal'],
      typescriptType: 'string',
      kind: 'numeric',
      sqlType: { postgresql: 'DECIMAL(19, 2)', h2: 'DECIMAL(19, 2)', mysql: 'DECIMAL(19, 2)' },
    });
  },
};
`;

test('registry fills field type defaults', () => {
  const registry = new ExtensionRegistrySet();
  registry.registerFieldType({ name: 'PhoneNumber' });
  const resolved = registry.resolveFieldType('PhoneNumber');
  assert.ok(resolved);
  assert.equal(resolved.javaType, 'PhoneNumber');
  assert.deepEqual([...resolved.javaImports], []);
  assert.equal(resolved.typescriptType, 'string');
  assert.equal(resolved.typescriptDefault, "''");
  assert.equal(resolved.kind, 'other');
  assert.equal(resolved.sqlTypeFor({ type: 'PhoneNumber' }, 'postgresql'), 'VARCHAR(255)');
});

test('registry resolves per-database and function sql types', () => {
  const registry = new ExtensionRegistrySet();
  registry.registerFieldType({
    name: 'Money',
    sqlType: { postgresql: 'DECIMAL(19, 2)' },
  });
  registry.registerFieldType({
    name: 'ShortCode',
    kind: 'string',
    sqlType: (field) => `VARCHAR(${field.maxLength ?? 10})`,
  });
  assert.equal(
    registry.resolveFieldType('Money').sqlTypeFor({ type: 'Money' }, 'postgresql'),
    'DECIMAL(19, 2)',
  );
  assert.equal(
    registry.resolveFieldType('Money').sqlTypeFor({ type: 'Money' }, 'h2'),
    'VARCHAR(255)',
  );
  assert.equal(
    registry.resolveFieldType('ShortCode').sqlTypeFor({ type: 'ShortCode', maxLength: 6 }, 'h2'),
    'VARCHAR(6)',
  );
});

test('registry rejects duplicates, built-ins, and invalid names', () => {
  const registry = new ExtensionRegistrySet();
  registry.registerFieldType({ name: 'Money' });
  assert.throws(() => registry.registerFieldType({ name: 'Money' }), ExtensionRegistryError);
  assert.throws(
    () => registry.registerFrontendFramework({ name: 'Money' }),
    ExtensionRegistryError,
  );
  assert.throws(() => registry.registerFieldType({ name: 'String' }), ExtensionRegistryError);
  assert.throws(
    () => registry.registerFrontendFramework({ name: 'angular' }),
    ExtensionRegistryError,
  );
  assert.throws(() => registry.registerFieldType({ name: 'has space' }), ExtensionRegistryError);
  assert.throws(
    () => registry.registerFrontendFramework({ name: 'React' }),
    ExtensionRegistryError,
  );
});

test('registry rejects registration after loading', () => {
  assert.throws(() => getActiveRegistry().registerFieldType({ name: 'Money' }));
});

test('loads extensions from the discovery directory', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    await writeExtension(workspace, 'money.mjs', MONEY_EXTENSION);
    const { extensions } = await loadExtensions({ cwd: workspace });
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0].name, 'money');
    assert.deepEqual(extensions[0].fieldTypes, ['Money']);
    assert.ok(resolveActiveFieldType('Money'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});

test('loads extensions from the configuration "extensions" list', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    const extensionPath = path.join(workspace, 'phone.cjs');
    await writeFile(
      extensionPath,
      `module.exports = { name: 'phone', register(registry) { registry.registerFieldType({ name: 'PhoneNumber', kind: 'string' }); } };`,
    );
    const { extensions } = await loadExtensions({
      cwd: workspace,
      config: { extensions: ['./phone.cjs'] },
    });
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0].name, 'phone');
    const resolved = resolveActiveFieldType('PhoneNumber');
    assert.equal(resolved.typescriptType, 'string');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});

test('reports modules that do not follow the contract', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    await writeExtension(workspace, 'broken.mjs', 'export default { nope: true };');
    await assert.rejects(() => loadExtensions({ cwd: workspace }), ExtensionError);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});

test('reports missing npm extensions with a suggestion', async () => {
  resetActiveRegistry();
  try {
    await assert.rejects(
      () => loadExtensions({ config: { extensions: ['cleanstack-ext-does-not-exist'] } }),
      (error) => {
        assert.ok(error instanceof ExtensionError);
        assert.match(error.message, /cleanstack-ext-does-not-exist/);
        assert.ok(error.suggestions.some((suggestion) => /npm i/.test(suggestion)));
        return true;
      },
    );
  } finally {
    resetActiveRegistry();
  }
});

test('parsed descriptors accept extension field types', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    await writeExtension(workspace, 'money.mjs', MONEY_EXTENSION);
    await loadExtensions({ cwd: workspace });

    const descriptor = path.join(workspace, 'invoice.yaml');
    await writeFile(
      descriptor,
      `name: Invoice
fields:
  - name: total
    type: Money
    required: true
    min: 0
`,
    );
    const parser = new EntityParser({ rootDir: workspace });
    const config = await parser.parseFile('invoice.yaml');
    assert.equal(config.fields[0].type, 'Money');

    const [model] = buildEntityModels([config]);
    assert.equal(model.fields[0].javaType, 'BigDecimal');
    assert.equal(model.fields[0].typescriptType, 'string');
    assert.ok(model.domainImports.includes('java.math.BigDecimal'));
    assert.equal(sqlTypeForField({ type: 'Money' }, 'postgresql'), 'DECIMAL(19, 2)');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});

test('extension field types are rejected once the registry is reset', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    const descriptor = path.join(workspace, 'invoice.yaml');
    await writeFile(
      descriptor,
      `name: Invoice
fields:
  - name: total
    type: Money
`,
    );
    const parser = new EntityParser({ rootDir: workspace });
    await assert.rejects(() => parser.parseFile('invoice.yaml'), /Invalid value/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});

test('registers frontend frameworks alongside the built-in angular', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    await writeExtension(
      workspace,
      'react.mjs',
      `export default {
  name: 'react',
  register(registry) {
    registry.registerFrontendFramework({ name: 'react', label: 'React' });
  },
};
`,
    );
    await loadExtensions({ cwd: workspace });
    const registry = getActiveRegistry();
    assert.equal(registry.getFrontendFramework('react').label, 'React');
    assert.equal(registry.getFrontendFramework('angular'), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});

test('extensions list prints a table and tolerates missing extensions', async () => {
  resetActiveRegistry();
  const workspace = await createWorkspace();
  try {
    const lines = [];
    const logger = { ...silentLogger, info: (message) => lines.push(message) };
    await runExtensionsCommand([], { cwd: workspace, logger });
    assert.ok(lines.some((line) => line.includes('No extensions loaded.')));

    await writeExtension(workspace, 'money.mjs', MONEY_EXTENSION);
    const tableLines = [];
    const rows = [];
    const reportingLogger = {
      ...silentLogger,
      info: (message) => tableLines.push(message),
      table: (columns, tableRows) => rows.push(...tableRows),
    };
    await runExtensionsCommand(['list'], { cwd: workspace, logger: reportingLogger });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'money');
    assert.match(rows[0].fieldTypes, /Money/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    resetActiveRegistry();
  }
});
