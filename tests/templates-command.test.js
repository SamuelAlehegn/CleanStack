import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCommand } from '../dist/cli/command-router.js';
import { parseTemplatesCommandArguments, runTemplatesCommand } from '../dist/cli/templates.js';
import { TemplateEngine } from '../dist/templates/template-engine.js';

const silentLogger = {
  debug() {},
  info() {},
  success() {},
  warn() {},
  error() {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-templates-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

function writeFileAt(rootPath, relativePath, content) {
  const filePath = path.join(rootPath, relativePath);
  return mkdir(path.dirname(filePath), { recursive: true }).then(() =>
    writeFile(filePath, content),
  );
}

/** Full-featured logger that records messages for assertions. */
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
    /** Flattens table rows so source assertions work on plain lines. */
    table(_columns, rows) {
      const line = rows.map((row) => `${row.pack}/${row.template}=${row.source}`).join(' | ');
      messages.push(`info: table: ${line}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Command routing and argument parsing
// ---------------------------------------------------------------------------

test('the router maps "templates" and keeps subcommand arguments', () => {
  assert.deepEqual(resolveCommand(['templates', 'list']), {
    name: 'templates',
    args: ['list'],
  });
  assert.deepEqual(resolveCommand(['templates', 'reset', 'spring-boot/root/README.md.hbs']), {
    name: 'templates',
    args: ['reset', 'spring-boot/root/README.md.hbs'],
  });
});

test('parses templates subcommands and flags', () => {
  assert.equal(parseTemplatesCommandArguments([]).subcommand, 'list');
  assert.equal(parseTemplatesCommandArguments(['list', 'spring-boot']).pack, 'spring-boot');
  assert.equal(parseTemplatesCommandArguments(['diff']).subcommand, 'diff');
  assert.equal(parseTemplatesCommandArguments(['reset', 'a/b.hbs']).name, 'a/b.hbs');

  const init = parseTemplatesCommandArguments(['init', '--force', '--dry-run']);
  assert.equal(init.subcommand, 'init');
  assert.equal(init.force, true);
  assert.equal(init.dryRun, true);

  assert.equal(parseTemplatesCommandArguments(['--help']).help, true);
});

test('rejects unknown subcommands, missing reset names, and stray positionals', () => {
  assert.throws(
    () => parseTemplatesCommandArguments(['explode']),
    /Unknown templates subcommand "explode"/,
  );
  assert.throws(() => parseTemplatesCommandArguments(['reset']), /requires a template name/);
  assert.throws(
    () => parseTemplatesCommandArguments(['reset', 'one', 'two']),
    /accepts a single template name/,
  );
  assert.throws(
    () => parseTemplatesCommandArguments(['list', 'a', 'b']),
    /accepts a single pack name/,
  );
  assert.throws(() => parseTemplatesCommandArguments(['init', '--nope']), /Unknown option/);
});

// ---------------------------------------------------------------------------
// templates list
// ---------------------------------------------------------------------------

test('list reports every built-in template with its source', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runTemplatesCommand(['list', 'spring-boot'], { cwd: workspace, logger });

    const output = logger.messages.join('\n');
    assert.match(output, /spring-boot\/root\/README\.md\.hbs=built-in/);
    assert.match(output, /spring-boot\/build\/pom\.xml\.hbs=built-in/);
    // Built-in templates resolve from the built-in level when no overrides exist.
    assert.doesNotMatch(output, /=project/);
    assert.doesNotMatch(output, /=user/);

    const tableLines = logger.messages.filter((message) => message.includes('table:'));
    assert.ok(tableLines.length > 0);
    assert.ok(tableLines[0].split(' | ').length > 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list marks overridden templates and override-only files', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    await writeFileAt(
      workspace,
      '.cleanstack/templates/spring-boot/root/README.md.hbs',
      '# My README',
    );
    await writeFileAt(workspace, '.cleanstack/templates/spring-boot/extra.hbs', 'extra');
    await writeFileAt(workspace, '.cleanstack/templates/spring-boot/manifest.json', '{"files":[]}');

    const logger = recordingLogger();
    await runTemplatesCommand(['list', 'spring-boot'], { cwd: workspace, logger });
    const output = logger.messages.join('\n');

    assert.match(output, /manifest\.json is overridden at the project level/);
    assert.match(output, /spring-boot\/root\/README\.md\.hbs=project/);
    assert.match(output, /spring-boot\/extra\.hbs=project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list rejects unknown pack names', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    await assert.rejects(
      runTemplatesCommand(['list', 'rust'], { cwd: workspace, logger: silentLogger }),
      /Unknown template pack "rust"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// templates init
// ---------------------------------------------------------------------------

test('init copies built-in templates into the project override directory', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runTemplatesCommand(['init'], { cwd: workspace, logger });

    const readme = await readFile(
      path.join(workspace, '.cleanstack', 'templates', 'spring-boot', 'root', 'README.md.hbs'),
      'utf8',
    );
    assert.match(readme, /<cleanstack:user-code id="readme.project-notes">/);
    await readFile(
      path.join(workspace, '.cleanstack', 'templates', 'angular', 'manifest.json'),
      'utf8',
    );
    assert.match(logger.messages.join('\n'), /Copied \d+ template file/);

    // A second init keeps existing overrides intact.
    await runTemplatesCommand(['init'], { cwd: workspace, logger: silentLogger });
    assert.equal(
      readme,
      await readFile(
        path.join(workspace, '.cleanstack', 'templates', 'spring-boot', 'root', 'README.md.hbs'),
        'utf8',
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('init --force overwrites, --dry-run writes nothing', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const overridePath = path.join(
      workspace,
      '.cleanstack',
      'templates',
      'spring-boot',
      'root',
      'README.md.hbs',
    );
    await mkdir(path.dirname(overridePath), { recursive: true });
    await writeFile(overridePath, '# my custom README');

    await runTemplatesCommand(['init'], { cwd: workspace, logger: silentLogger });
    assert.equal(await readFile(overridePath, 'utf8'), '# my custom README');

    await runTemplatesCommand(['init', '--dry-run'], { cwd: workspace, logger: silentLogger });
    assert.equal(await readFile(overridePath, 'utf8'), '# my custom README');

    await runTemplatesCommand(['init', '--force'], { cwd: workspace, logger: silentLogger });
    const restored = await readFile(overridePath, 'utf8');
    assert.match(restored, /<cleanstack:user-code id="readme.project-notes">/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// templates diff
// ---------------------------------------------------------------------------

test('diff reports a clean override with nothing to change', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const logger = recordingLogger();
    await runTemplatesCommand(['diff'], { cwd: workspace, logger });
    const output = logger.messages.join('\n');
    assert.match(output, /no overrides/);
    assert.match(output, /Overrides are identical|differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff shows modified and override-only files with added and removed lines', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    await writeFileAt(
      workspace,
      '.cleanstack/templates/spring-boot/root/README.md.hbs',
      '# custom heading\n\nnew ending line\n',
    );
    await writeFileAt(workspace, '.cleanstack/templates/spring-boot/extra.hbs', 'extra\n');

    const logger = recordingLogger();
    await runTemplatesCommand(['diff', 'spring-boot'], { cwd: workspace, logger });
    const output = logger.messages.join('\n');

    assert.match(output, /modified spring-boot\/root\/README\.md\.hbs \(project\)/);
    assert.match(output, /added spring-boot\/extra\.hbs \(override only, project\)/);
    assert.match(output, /- # \{\{pascalCase project\.name\}\}/);
    assert.match(output, /\+ # custom heading/);
    assert.match(output, /1 override file\(s\) differ|2 override file\(s\) differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diff counts identical overrides as unchanged', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    // Copy the built-in README verbatim; diff must not flag it.
    const builtIn = await readFile(
      path.join(
        new URL('.', import.meta.url).pathname,
        '..',
        'templates',
        'spring-boot',
        'root',
        'README.md.hbs',
      ),
      'utf8',
    );
    await writeFileAt(workspace, '.cleanstack/templates/spring-boot/root/README.md.hbs', builtIn);

    const logger = recordingLogger();
    await runTemplatesCommand(['diff', 'spring-boot'], { cwd: workspace, logger });
    assert.match(logger.messages.join('\n'), /Overrides are identical to the built-in templates/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// templates reset
// ---------------------------------------------------------------------------

test('reset removes a project override and the built-in template applies again', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const overridePath = path.join(
      workspace,
      '.cleanstack',
      'templates',
      'spring-boot',
      'root',
      'README.md.hbs',
    );
    await writeFileAt(
      workspace,
      '.cleanstack/templates/spring-boot/root/README.md.hbs',
      '# custom README',
    );
    const before = new TemplateEngine({ projectRoot: workspace });
    assert.equal((await before.resolve('spring-boot/root/README.md.hbs')).location, 'project');

    const logger = recordingLogger();
    await runTemplatesCommand(['reset', 'spring-boot/root/README.md', '--dry-run'], {
      cwd: workspace,
      logger,
    });
    assert.equal(await readFile(overridePath, 'utf8'), '# custom README');

    await runTemplatesCommand(['reset', 'spring-boot/root/README.md'], {
      cwd: workspace,
      logger,
    });
    await assert.rejects(() => readFile(overridePath, 'utf8'), /ENOENT/);
    assert.equal((await before.resolve('spring-boot/root/README.md.hbs')).location, 'built-in');
    assert.match(logger.messages.join('\n'), /Removed project override/);

    await assert.rejects(
      runTemplatesCommand(['reset', 'spring-boot/root/README.md'], {
        cwd: workspace,
        logger: silentLogger,
      }),
      /uses the built-in template/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reset falls back to the user override and rejects unknown templates', async () => {
  const { root, workspace } = await createWorkspace();
  const previousHome = process.env.HOME;
  try {
    const home = path.join(root, 'home');
    await writeFileAt(
      home,
      '.cleanstack/templates/spring-boot/root/README.md.hbs',
      '# from user dir',
    );
    if (process.platform === 'win32') {
      process.env.USERPROFILE = home;
    } else {
      process.env.HOME = home;
    }

    const logger = recordingLogger();
    await runTemplatesCommand(['reset', 'spring-boot/root/README.md.hbs'], {
      cwd: workspace,
      logger,
    });
    assert.match(logger.messages.join('\n'), /Removed user override/);

    await assert.rejects(
      runTemplatesCommand(['reset', 'spring-boot/does-not-exist.hbs'], {
        cwd: workspace,
        logger: silentLogger,
      }),
      /No template named/,
    );
  } finally {
    if (process.platform === 'win32') {
      process.env.USERPROFILE = previousHome;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});
