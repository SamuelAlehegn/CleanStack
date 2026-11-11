import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runNewCommand } from '../dist/cli/new.js';
import { ConfigLoader } from '../dist/core/config-loader.js';
import { EntityParser } from '../dist/core/entity-parser.js';
import { addEntityNavLink, addEntityRoutes } from '../dist/core/frontend-updates.js';
import { writeGeneratedFile } from '../dist/core/generated-file.js';
import { parseOpenApiDocument } from '../dist/core/openapi-client.js';
import { BUILT_IN_TEMPLATE_ROOT, TemplateEngine } from '../dist/templates/template-engine.js';
import { buildCommandInvocation, execCommand, resolveCommandPath } from '../dist/utils/command.js';
import { FileSystemService } from '../dist/utils/file-system.js';
import {
  assertRelativePath,
  isPathInside,
  isSamePath,
  pathSegmentProblem,
  UnsafePathError,
} from '../dist/utils/path-safety.js';
import { detectLineEnding, normalizeFileContents, stripBom } from '../dist/utils/text.js';

const noopLogger = { log: () => {} };
const hasLoneLf = (contents) => contents.replace(/\r\n/g, '').includes('\n');

test('path safety rejects Windows absolute, UNC, and drive-relative paths', () => {
  for (const unsafe of [
    'C:work',
    'c:work',
    'C:\\work',
    'C:/work',
    '\\\\server\\share',
    '\\root-relative',
    '../escape',
  ]) {
    assert.throws(() => assertRelativePath(unsafe, '/root'), UnsafePathError, unsafe);
  }

  assert.equal(assertRelativePath('src\\main\\java', '/root'), 'src/main/java');
  assert.equal(assertRelativePath('./src//app', '/root'), 'src/app');
});

test('path segment validation rejects names Windows cannot create', () => {
  for (const invalid of [
    '',
    '.',
    '..',
    'a/b',
    'a\\b',
    'con',
    'NUL.txt',
    'com1',
    'bad:name',
    'question?',
    'trailing.',
    'trailing ',
  ]) {
    assert.notEqual(pathSegmentProblem(invalid), undefined, invalid);
  }
  for (const valid of ['demo', 'my-app', 'app_2', '.gitignore']) {
    assert.equal(pathSegmentProblem(valid), undefined, valid);
  }
});

test('path comparisons use Windows case-insensitive semantics', () => {
  assert.equal(isSamePath('C:\\Repo', 'c:\\repo', 'win32'), true);
  assert.equal(isPathInside('C:\\Repo', 'c:\\repo\\src\\App.java', 'win32'), true);
  assert.equal(isPathInside('C:\\Repo', 'C:\\Repository', 'win32'), false);
  assert.equal(isSamePath('/repo', '/REPO', 'linux'), false);
});

test('line-ending policy is CRLF for Windows scripts and LF elsewhere', () => {
  for (const file of ['run.cmd', 'run.BAT', 'run.ps1', 'run.reg', 'run.vbs']) {
    assert.equal(normalizeFileContents(file, 'one\ntwo\n'), 'one\r\ntwo\r\n', file);
  }
  assert.equal(normalizeFileContents('README.md', 'one\r\ntwo\r\n'), 'one\ntwo\n');
  assert.equal(stripBom('\uFEFFhello'), 'hello');
  assert.equal(normalizeFileContents('notes.txt', '\uFEFFone\r\ntwo'), 'one\ntwo');
  assert.equal(detectLineEnding('a\r\nb\r\nc\n'), '\r\n');
  assert.equal(detectLineEnding('a\nb\r\nc\n'), '\n');
  assert.equal(detectLineEnding('no line break'), undefined);
});

test('template rendering applies destination line endings directly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-render-eol-'));
  try {
    const engine = new TemplateEngine({
      projectRoot: root,
      userTemplatesDir: path.join(root, 'user-templates'),
      builtInTemplatesDir: BUILT_IN_TEMPLATE_ROOT,
    });

    const windowsScript = await engine.render('spring-boot/build/mvnw.cmd.hbs', {});
    assert.ok(windowsScript.includes('\r\n'));
    assert.equal(hasLoneLf(windowsScript), false);

    const attributes = await engine.render('project/root/.gitattributes.hbs', {});
    assert.ok(attributes.includes('*.cmd text eol=crlf'));
    assert.equal(attributes.includes('\r'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generated files follow destination line endings and preserve merged CRLF', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-generated-eol-'));
  const fileSystem = new FileSystemService({ rootDir: root, logger: noopLogger });
  try {
    const created = await writeGeneratedFile(fileSystem, 'tool.cmd', 'echo one\necho two\n');
    assert.equal(created.status, 'created');
    const script = await readFile(path.join(root, 'tool.cmd'), 'utf8');
    assert.equal(script, 'echo one\r\necho two\r\n');

    const bomResult = await writeGeneratedFile(fileSystem, 'notes.txt', '\uFEFFhello\n');
    assert.equal(bomResult.status, 'created');
    assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'hello\n');

    const template = [
      'class Service {',
      '  // <cleanstack:user-code id="service.custom">',
      '  // </cleanstack:user-code>',
      '}',
      '',
    ].join('\n');
    await writeGeneratedFile(fileSystem, 'Service.java', template);
    const generated = await readFile(path.join(root, 'Service.java'), 'utf8');
    const windowsCheckout = generated
      .replace(/\n/g, '\r\n')
      .replace(
        '  // </cleanstack:user-code>',
        '  public void custom() {}\r\n  // </cleanstack:user-code>',
      );
    await writeFile(path.join(root, 'Service.java'), windowsCheckout);

    const updatedTemplate = template.replace('class Service {', '// generated v2\nclass Service {');
    const merged = await writeGeneratedFile(fileSystem, 'Service.java', updatedTemplate);
    assert.equal(merged.status, 'updated');
    const mergedContent = await readFile(path.join(root, 'Service.java'), 'utf8');
    assert.match(mergedContent, /generated v2/);
    assert.match(mergedContent, /custom\(\)/);
    assert.ok(mergedContent.includes('\r\n'));
    assert.equal(hasLoneLf(mergedContent), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontend route and navigation insertions preserve CRLF', () => {
  const entity = {
    name: 'Product',
    pluralName: 'Products',
    routeName: 'products',
    className: 'Product',
  };
  const routes = ['export const routes = [', '];', ''].join('\r\n');
  const routesResult = addEntityRoutes(routes, entity);
  assert.match(routesResult, /path: 'products'/);
  assert.equal(hasLoneLf(routesResult), false);

  const navigation = ['<nav>', '</nav>', ''].join('\r\n');
  const navigationResult = addEntityNavLink(navigation, entity);
  assert.match(navigationResult, /routerLink="\/products"/);
  assert.equal(hasLoneLf(navigationResult), false);
});

test('config, entity, and OpenAPI readers accept UTF-8 BOMs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-bom-'));
  try {
    await writeFile(
      path.join(root, '.cleanstackrc.yml'),
      '\uFEFFpackageName: com.example\noptions:\n  buildTool: gradle\n',
    );
    const defaults = await new ConfigLoader().loadDefaults({ cwd: root });
    assert.equal(defaults.options.buildTool, 'gradle');

    await mkdir(path.join(root, 'entities'));
    await writeFile(
      path.join(root, 'entities', 'Product.yaml'),
      '\uFEFFname: Product\nfields:\n  - name: name\n    type: String\n',
    );
    const entity = await new EntityParser({ rootDir: root }).parseFile('entities/Product.yaml');
    assert.equal(entity.name, 'Product');

    const spec = parseOpenApiDocument(
      '\uFEFFopenapi: 3.0.0\ninfo:\n  title: BOM API\n  version: "1.0"\npaths: {}\n',
      'inline.yaml',
    );
    assert.equal(spec.title, 'BOM API');
    assert.equal(spec.contents.startsWith('\uFEFF'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows command invocation routes .cmd files through cmd.exe', () => {
  const args = ['--yes', '@scope/pkg', '--output', 'C:\\work dir'];
  const invocation = buildCommandInvocation('C:\\Program Files\\nodejs\\npx.cmd', args, {
    platform: 'win32',
    comSpec: 'cmd.exe',
  });

  assert.equal(invocation.command, 'cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.args.length, 4);
  assert.match(invocation.args[3], /npx\.cmd/);
  assert.match(invocation.args[3], /Program\^ Files/);
  assert.match(invocation.args[3], /@scope\/pkg/);
  assert.equal(invocation.windowsVerbatimArguments, true);

  const nativeExecutable = buildCommandInvocation('git', ['init'], { platform: 'win32' });
  assert.deepEqual(nativeExecutable, { command: 'git', args: ['init'] });

  const posix = buildCommandInvocation('npx.cmd', ['--version'], { platform: 'linux' });
  assert.deepEqual(posix, { command: 'npx.cmd', args: ['--version'] });
});

test('Windows command resolution appends PATHEXT entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-command-path-'));
  try {
    const script = path.join(root, 'tool.cmd');
    await writeFile(script, '@echo off\r\necho tool\r\n');
    const resolved = resolveCommandPath(script.replace(/\.cmd$/i, ''), {
      platform: 'win32',
      env: { PATHEXT: '.cmd' },
    });
    assert.equal(resolved, script);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('execCommand runs the current Node executable', async () => {
  const result = await execCommand(process.execPath, ['-e', 'process.stdout.write("command-ok")']);
  assert.equal(result.stdout, 'command-ok');
});

test('new accepts an absolute output directory and writes portable scripts', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-absolute-output-'));
  const cwd = path.join(parent, 'cwd');
  const outputRoot = path.join(parent, 'generated');
  const messages = [];
  const logger = {
    debug() {},
    info(message) {
      messages.push(message);
    },
    success(message) {
      messages.push(message);
    },
    warn(message) {
      messages.push(message);
    },
  };
  try {
    await mkdir(cwd);
    await runNewCommand(
      [
        'demo',
        '--yes',
        '--no-entities',
        '--frontend',
        'none',
        '--auth',
        'none',
        '--db',
        'h2',
        '--output-dir',
        outputRoot,
      ],
      { cwd, logger },
    );

    const targetRoot = path.join(outputRoot, 'demo');
    const backendRoot = path.join(targetRoot, 'demo-backend');
    assert.match(await readFile(path.join(backendRoot, 'pom.xml'), 'utf8'), /<project/);
    await assert.rejects(stat(path.join(cwd, 'demo')), { code: 'ENOENT' });

    const attributes = await readFile(path.join(targetRoot, '.gitattributes'), 'utf8');
    assert.match(attributes, /^\* text=auto eol=lf$/m);
    assert.match(attributes, /^\*\.cmd text eol=crlf$/m);

    const windowsScript = await readFile(path.join(backendRoot, 'mvnw.cmd'), 'utf8');
    assert.ok(windowsScript.includes('\r\n'));
    assert.equal(hasLoneLf(windowsScript), false);

    if (process.platform !== 'win32') {
      const wrapper = await stat(path.join(backendRoot, 'mvnw'));
      assert.ok((wrapper.mode & 0o111) !== 0, 'mvnw should be executable on POSIX');
    }

    const output = messages.join('\n');
    assert.match(output, new RegExp(`Generated demo in ${escapeRegExp(targetRoot)}`));
    assert.match(output, /Next steps:/);
    assert.match(output, process.platform === 'win32' ? /\.\\mvnw\.cmd/ : /\.\/mvnw/);
    assert.doesNotMatch(output, /\(cd /);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('new rejects Windows-reserved names and drive-relative output directories', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-name-validation-'));
  const logger = { debug() {}, info() {}, success() {}, warn() {} };
  try {
    for (const name of ['con', 'NUL.txt', 'bad:name']) {
      await assert.rejects(
        runNewCommand([name, '--yes', '--no-entities', '--frontend', 'none'], { cwd, logger }),
        /Project name/,
        name,
      );
    }

    await assert.rejects(
      runNewCommand(
        ['demo', '--yes', '--no-entities', '--frontend', 'none', '--output-dir', 'C:work'],
        { cwd, logger },
      ),
      /Output directory/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
