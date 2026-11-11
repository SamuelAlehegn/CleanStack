import assert from 'node:assert/strict';
import {
  access as nodeAccess,
  chmod as nodeChmod,
  cp as nodeCopy,
  link as nodeLink,
  mkdir,
  mkdtemp,
  readFile as nodeReadFile,
  readdir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm,
  symlink,
  writeFile as writeNodeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileExistsError,
  FileSystemService,
  InvalidOperationError,
} from '../dist/utils/file-system.js';
import { UnsafePathError } from '../dist/utils/path-safety.js';

/** The Node adapter with individual operations replaceable for failure tests. */
function nodeAdapter(overrides = {}) {
  return {
    access: (filePath) => nodeAccess(filePath),
    chmod: (filePath, mode) => nodeChmod(filePath, mode),
    copy: (source, destination, options) =>
      nodeCopy(source, destination, {
        recursive: true,
        force: options.overwrite,
        errorOnExist: !options.overwrite,
      }),
    link: (source, destination) => nodeLink(source, destination),
    mkdir: (directoryPath) => mkdir(directoryPath, { recursive: true }),
    readFile: (filePath) => nodeReadFile(filePath, 'utf8'),
    readdir: (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
    realpath: (filePath) => nodeRealpath(filePath),
    remove: (filePath, options) => rm(filePath, options),
    rename: (source, destination) => nodeRename(source, destination),
    writeFile: (filePath, contents, options) =>
      writeNodeFile(filePath, contents, {
        encoding: 'utf8',
        flag: options.overwrite ? 'w' : 'wx',
      }),
    ...overrides,
  };
}

async function createFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-filesystem-'));
  const rootDir = path.join(parent, 'root');
  await mkdir(rootDir, { recursive: true });
  await writeNodeFile(path.join(parent, 'keep.txt'), 'keep');
  const actions = [];
  const logger = { log: (action) => actions.push(action) };

  return {
    parent,
    rootDir,
    actions,
    service: (options = {}) => new FileSystemService({ rootDir, logger, ...options }),
    async cleanup() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test('creates directories, writes, reads, and lists files', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.createDirectory('src/nested');
    await fs.writeFile('src/top.txt', 'top');
    await fs.writeFile('src/nested/deep.txt', 'deep');

    assert.equal(await fs.exists('src/nested/deep.txt'), true);
    assert.equal(await fs.exists('src/missing.txt'), false);
    assert.equal(await fs.readFile('src/nested/deep.txt'), 'deep');
    assert.deepEqual(await fs.listFiles('src'), ['nested/deep.txt', 'top.txt']);
    assert.deepEqual(await fs.listFiles('src', { recursive: false }), ['top.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('protects existing files unless overwrite is requested', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('notes.txt', 'first');

    await assert.rejects(fs.writeFile('notes.txt', 'second'), FileExistsError);
    assert.equal(await fs.readFile('notes.txt'), 'first');

    await fs.writeFile('notes.txt', 'second', { overwrite: true });
    assert.equal(await fs.readFile('notes.txt'), 'second');
  } finally {
    await fixture.cleanup();
  }
});

test('backs up overwritten files without replacing previous backups', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('notes.txt', 'one');
    await fs.writeFile('notes.txt', 'two', { overwrite: true, backup: true });
    await fs.writeFile('notes.txt', 'three', { overwrite: true, backup: true });

    assert.equal(await fs.readFile('notes.txt'), 'three');
    assert.equal(await fs.readFile('notes.txt.bak'), 'one');
    assert.equal(await fs.readFile('notes.txt.bak.1'), 'two');
  } finally {
    await fixture.cleanup();
  }
});

test('writes atomically without leaving temporary files behind', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('notes.txt', 'first');
    await fs.writeFile('notes.txt', 'second', { overwrite: true });

    assert.equal(await fs.readFile('notes.txt'), 'second');
    assert.deepEqual((await readdir(fixture.rootDir)).sort(), ['notes.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('preserves the previous file and cleans up when an atomic replace fails', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('notes.txt', 'first');
    const failing = fixture.service({
      adapter: nodeAdapter({
        rename: async () => {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
      }),
    });

    await assert.rejects(failing.writeFile('notes.txt', 'second', { overwrite: true }), {
      message: 'disk full',
    });
    assert.equal(await fs.readFile('notes.txt'), 'first');
    assert.deepEqual((await readdir(fixture.rootDir)).sort(), ['notes.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('create-only writes refuse a destination that appears after the pre-check', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('notes.txt', 'first');
    const targetPath = path.join(fixture.rootDir, 'notes.txt');
    const racing = fixture.service({
      adapter: nodeAdapter({
        access: async (filePath) => {
          if (filePath === targetPath) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          await nodeAccess(filePath);
        },
      }),
    });

    await assert.rejects(racing.writeFile('notes.txt', 'second'), FileExistsError);
    assert.equal(await fs.readFile('notes.txt'), 'first');
    assert.deepEqual((await readdir(fixture.rootDir)).sort(), ['notes.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('falls back to rename when the filesystem cannot create hard links', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service({
      adapter: nodeAdapter({
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EPERM' });
        },
      }),
    });

    await fs.writeFile('notes.txt', 'first');
    assert.equal(await fs.readFile('notes.txt'), 'first');
    assert.deepEqual((await readdir(fixture.rootDir)).sort(), ['notes.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('rename fallback re-checks the destination before replacing it', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('notes.txt', 'first');
    const targetPath = path.join(fixture.rootDir, 'notes.txt');
    let targetChecks = 0;
    const racing = fixture.service({
      adapter: nodeAdapter({
        access: async (filePath) => {
          if (filePath === targetPath && targetChecks++ === 0) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          await nodeAccess(filePath);
        },
        link: async () => {
          throw Object.assign(new Error('hard links unsupported'), { code: 'EPERM' });
        },
      }),
    });

    await assert.rejects(racing.writeFile('notes.txt', 'second'), FileExistsError);
    assert.equal(await fs.readFile('notes.txt'), 'first');
    assert.deepEqual((await readdir(fixture.rootDir)).sort(), ['notes.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('dry-run reports actions but skips every mutation', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('existing.txt', 'existing');
    const dryRun = fixture.service({ dryRun: true });

    await dryRun.createDirectory('generated');
    await dryRun.writeFile('generated/new.txt', 'new', { overwrite: true });
    await dryRun.copy('existing.txt', 'copy.txt');
    await dryRun.delete('existing.txt');

    assert.equal(dryRun.dryRun, true);
    assert.equal(await fs.exists('generated'), false);
    assert.equal(await fs.exists('copy.txt'), false);
    assert.equal(await fs.exists('existing.txt'), true);
    assert.ok(fixture.actions.some((action) => action.status === 'skipped'));
  } finally {
    await fixture.cleanup();
  }
});

test('rejects absolute paths, traversal, empty paths, and NUL bytes', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();

    await assert.rejects(fs.readFile('../keep.txt'), UnsafePathError);
    await assert.rejects(fs.readFile('/etc/passwd'), UnsafePathError);
    await assert.rejects(fs.writeFile('..', 'nope'), UnsafePathError);
    await assert.rejects(fs.readFile(''), TypeError);
    await assert.rejects(fs.readFile('nul\0byte'), TypeError);
  } finally {
    await fixture.cleanup();
  }
});

test('follows symlinks that stay inside the root and rejects escaping ones', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks requires elevated privileges on Windows.');
    return;
  }

  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('inside.txt', 'inside');
    await symlink(
      path.join(fixture.rootDir, 'inside.txt'),
      path.join(fixture.rootDir, 'alias.txt'),
    );
    await symlink(path.join(fixture.parent, 'keep.txt'), path.join(fixture.rootDir, 'escape.txt'));

    assert.equal(await fs.readFile('alias.txt'), 'inside');
    await assert.rejects(fs.readFile('escape.txt'), UnsafePathError);

    const listed = await fs.listFiles('.');
    // Directory listings report real entries only; symlinks are skipped to avoid cycles.
    assert.deepEqual(listed, ['inside.txt']);
  } finally {
    await fixture.cleanup();
  }
});

test('refuses to copy into the root or into itself and to delete the root', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('file.txt', 'x');
    await fs.createDirectory('dir');
    await fs.writeFile('dir/child.txt', 'y');

    await assert.rejects(fs.copy('dir', '.'), InvalidOperationError);
    await assert.rejects(fs.copy('file.txt', '.'), InvalidOperationError);
    await assert.rejects(fs.copy('dir', 'dir/nested'), InvalidOperationError);
    await assert.rejects(fs.delete('.'), InvalidOperationError);
  } finally {
    await fixture.cleanup();
  }
});

test('copies and deletes files and directories', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('from.txt', 'copy me');
    await fs.copy('from.txt', 'to.txt');
    assert.equal(await fs.readFile('to.txt'), 'copy me');
    await assert.rejects(fs.copy('from.txt', 'to.txt'), FileExistsError);
    await fs.copy('from.txt', 'to.txt', { overwrite: true });

    await fs.createDirectory('dir');
    await fs.writeFile('dir/child.txt', 'child');
    await fs.copy('dir', 'dir-copy');
    assert.deepEqual(await fs.listFiles('dir-copy'), ['child.txt']);

    await fs.delete('to.txt');
    assert.equal(await fs.exists('to.txt'), false);
    await fs.delete('dir', { recursive: true });
    assert.equal(await fs.exists('dir'), false);
    await fs.delete('missing.txt', { force: true });
  } finally {
    await fixture.cleanup();
  }
});

test('logs started and completed actions with their status', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await fs.writeFile('logged.txt', 'value', { overwrite: true });

    const writeActions = fixture.actions.filter((action) => action.operation === 'writeFile');
    assert.deepEqual(
      writeActions.map((action) => action.status),
      ['started', 'succeeded'],
    );
    assert.equal(writeActions[0].path, 'logged.txt');
  } finally {
    await fixture.cleanup();
  }
});

test('requires parent directories to exist before writing files', async () => {
  const fixture = await createFixture();
  try {
    const fs = fixture.service();
    await assert.rejects(fs.writeFile('missing/deep.txt', 'value'), { code: 'ENOENT' });
  } finally {
    await fixture.cleanup();
  }
});
