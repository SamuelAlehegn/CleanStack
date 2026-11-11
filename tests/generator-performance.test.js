import assert from 'node:assert/strict';
import {
  access as nodeAccess,
  chmod as nodeChmod,
  cp as nodeCopy,
  link as nodeLink,
  mkdir as nodeMkdir,
  mkdtemp,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm as nodeRemove,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderManifest } from '../dist/templates/manifest.js';
import { TemplateEngine } from '../dist/templates/template-engine.js';
import { FileSystemService } from '../dist/utils/file-system.js';

const silentLogger = { log() {} };

const project = {
  name: 'demo',
  packageName: 'com.example',
  entities: [],
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
};

async function writeFileAt(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  await nodeMkdir(path.dirname(filePath), { recursive: true });
  await nodeWriteFile(filePath, contents);
}

/** Wraps the Node adapter so tests can observe concurrent writes. */
function createTrackingAdapter(delayMs) {
  const state = { active: 0, maxActive: 0, writes: [] };
  const adapter = {
    access: (filePath) => nodeAccess(filePath),
    chmod: (filePath, mode) => nodeChmod(filePath, mode),
    copy: (source, destination, options) =>
      nodeCopy(source, destination, {
        recursive: true,
        force: options.overwrite,
        errorOnExist: !options.overwrite,
      }),
    link: (source, destination) => nodeLink(source, destination),
    mkdir: (directoryPath) => nodeMkdir(directoryPath, { recursive: true }),
    readFile: (filePath) => nodeReadFile(filePath, 'utf8'),
    readdir: (directoryPath) => nodeReaddir(directoryPath, { withFileTypes: true }),
    realpath: (filePath) => nodeRealpath(filePath),
    remove: (filePath, options) => nodeRemove(filePath, options),
    rename: (source, destination) => nodeRename(source, destination),
    async writeFile(filePath, contents, options) {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await nodeWriteFile(filePath, contents, {
          encoding: 'utf8',
          flag: options.overwrite ? 'w' : 'wx',
        });
        state.writes.push(filePath);
      } finally {
        state.active -= 1;
      }
    },
  };
  return { adapter, state };
}

async function createFixture(fileCount) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-performance-'));
  const pack = path.join(root, '.cleanstack', 'templates', 'perf-pack');
  const files = [];

  for (let index = 0; index < fileCount; index += 1) {
    const template = `file-${index}.hbs`;
    const destination = `generated/file-${index}.txt`;
    const contents = `content ${index}`;
    await writeFileAt(pack, template, contents);
    files.push({ template, destination, contents });
  }
  await writeFileAt(pack, 'manifest.json', JSON.stringify({ files }));

  return { root, files, engine: new TemplateEngine({ projectRoot: root }) };
}

test('writes independent files concurrently while keeping report order', async () => {
  const fixture = await createFixture(8);
  try {
    const { adapter, state } = createTrackingAdapter(10);
    const output = new FileSystemService({
      rootDir: fixture.root,
      adapter,
      logger: silentLogger,
    });
    const reported = [];

    const written = await renderManifest(
      'perf-pack',
      project,
      {},
      fixture.engine,
      output,
      silentLogger,
      { concurrency: 4, onFile: (result) => reported.push(result.path) },
    );

    assert.equal(state.maxActive > 1, true, 'expected more than one write in flight');
    assert.equal(state.maxActive <= 4, true, `expected at most 4 writes, saw ${state.maxActive}`);
    assert.deepEqual(
      written,
      fixture.files.map((file) => file.destination),
    );
    assert.deepEqual(reported, written);
    for (const file of fixture.files) {
      assert.equal(
        await nodeReadFile(path.join(fixture.root, file.destination), 'utf8'),
        file.contents,
      );
    }
  } finally {
    await nodeRemove(fixture.root, { recursive: true, force: true });
  }
});

test('sequential rendering still respects the concurrency option', async () => {
  const fixture = await createFixture(3);
  try {
    const { adapter, state } = createTrackingAdapter(5);
    const output = new FileSystemService({
      rootDir: fixture.root,
      adapter,
      logger: silentLogger,
    });

    await renderManifest('perf-pack', project, {}, fixture.engine, output, silentLogger, {
      concurrency: 1,
    });

    assert.equal(state.maxActive, 1);
  } finally {
    await nodeRemove(fixture.root, { recursive: true, force: true });
  }
});

test('entries sharing a destination stay ordered and the last one wins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-performance-'));
  try {
    const pack = path.join(root, '.cleanstack', 'templates', 'perf-pack');
    await writeFileAt(pack, 'first.hbs', 'first');
    await writeFileAt(pack, 'second.hbs', 'second');
    await writeFileAt(
      pack,
      'manifest.json',
      JSON.stringify({
        files: [
          { template: 'first.hbs', destination: 'shared.txt' },
          { template: 'second.hbs', destination: 'shared.txt' },
        ],
      }),
    );
    const output = new FileSystemService({ rootDir: root, logger: silentLogger });

    const written = await renderManifest(
      'perf-pack',
      project,
      {},
      new TemplateEngine({ projectRoot: root }),
      output,
      silentLogger,
      { concurrency: 4, force: true },
    );

    assert.deepEqual(written, ['shared.txt', 'shared.txt']);
    assert.equal(await nodeReadFile(path.join(root, 'shared.txt'), 'utf8'), 'second');
  } finally {
    await nodeRemove(root, { recursive: true, force: true });
  }
});
