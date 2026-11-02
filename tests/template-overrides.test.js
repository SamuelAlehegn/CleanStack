import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runEntityCommand } from '../dist/cli/entity.js';
import { runNewCommand } from '../dist/cli/new.js';
import { runRegenerateCommand } from '../dist/cli/regenerate.js';
import { renderManifest, templateContext } from '../dist/templates/manifest.js';
import { TemplateEngine } from '../dist/templates/template-engine.js';
import { FileSystemService } from '../dist/utils/file-system.js';

const logger = { debug() {}, info() {}, success() {}, warn() {} };

const demoProject = {
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

async function writeTemplate(rootPath, relativePath, content) {
  const filePath = path.join(rootPath, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-override-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

/** Creates a project with `cleanstack new` before any override templates exist. */
async function generateProject(workspace) {
  await writeFile(
    path.join(workspace, 'cleanstack.config.json'),
    JSON.stringify({
      name: demoProject.name,
      packageName: demoProject.packageName,
      entities: [],
      options: {
        ...demoProject.options,
        frontend: true,
      },
    }),
  );
  await runNewCommand(['demo', '--yes', '--no-entities'], { cwd: workspace, logger });
  return path.join(workspace, 'demo');
}

test('cleanstack new applies a project-level single-file override', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const projectRoot = await generateProject(workspace);

    // The override is added after generation, so rerunning `new` picks it up.
    // Keeping the protected region lets the safe merge apply the new template.
    await writeTemplate(
      workspace,
      '.cleanstack/templates/spring-boot/root/README.md.hbs',
      [
        '# overridden README for {{pascalCase project.name}}',
        '',
        '<!-- <cleanstack:user-code id="readme.project-notes"> -->',
        '<!-- </cleanstack:user-code> -->',
      ].join('\n'),
    );
    await runNewCommand(['demo', '--yes', '--no-entities'], { cwd: workspace, logger });

    const readme = await readFile(path.join(projectRoot, 'demo-backend', 'README.md'), 'utf8');
    assert.match(readme, /# overridden README for Demo/);
    assert.match(readme, /<cleanstack:user-code id="readme.project-notes" checksum=/);
    // Every other file still comes from the built-in templates.
    assert.match(
      await readFile(path.join(projectRoot, 'demo-backend', 'pom.xml'), 'utf8'),
      /spring-boot-starter-data-jpa/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanstack entity applies a user-level single-file override', async () => {
  const { root, workspace } = await createWorkspace();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  try {
    // Point the user override directory at a fixture location.
    const home = path.join(root, 'home');
    await writeTemplate(
      home,
      '.cleanstack/templates/angular/src/app/models/Entity.ts.hbs',
      '// USER-OVERRIDE {{entity.className}}\nexport interface {{entity.className}}Custom {}\n',
    );
    if (process.platform === 'win32') {
      process.env.USERPROFILE = home;
    } else {
      process.env.HOME = home;
    }

    const projectRoot = await generateProject(workspace);
    await mkdir(path.join(projectRoot, 'entities'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'entities', 'Product.yaml'),
      'name: Product\nfields:\n  - name: name\n    type: String\n',
    );

    await runEntityCommand(['Product'], { cwd: projectRoot, logger });

    const model = await readFile(
      path.join(projectRoot, 'demo-ui', 'src', 'app', 'models', 'product.ts'),
      'utf8',
    );
    assert.match(model, /USER-OVERRIDE Product/);
    assert.match(model, /export interface ProductCustom/);

    // Built-in templates still drive untouched files.
    const service = await readFile(
      path.join(projectRoot, 'demo-ui', 'src', 'app', 'services', 'product.service.ts'),
      'utf8',
    );
    assert.match(service, /export class ProductService/);
  } finally {
    if (process.platform === 'win32') {
      process.env.USERPROFILE = previousUserProfile;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('regenerate applies a project-level override while protecting user code', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    const projectRoot = await generateProject(workspace);
    const readmePath = path.join(projectRoot, 'demo-backend', 'README.md');

    // The override keeps the protected region so the safe merge can apply it.
    // Inside a generated project, `regenerate` resolves overrides from the
    // project's own `.cleanstack/templates` directory.
    await writeTemplate(
      projectRoot,
      '.cleanstack/templates/spring-boot/root/README.md.hbs',
      [
        '# overridden README',
        '',
        '<!-- <cleanstack:user-code id="readme.project-notes"> -->',
        'kept notes',
        '<!-- </cleanstack:user-code> -->',
      ].join('\n'),
    );

    await runRegenerateCommand([], { cwd: projectRoot, logger });

    const readme = await readFile(readmePath, 'utf8');
    assert.match(readme, /# overridden README/);
    assert.match(readme, /kept notes/);
    assert.match(readme, /<cleanstack:user-code id="readme.project-notes" checksum=/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project-level manifest override replaces the file list of one set', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    await writeTemplate(
      workspace,
      '.cleanstack/templates/spring-boot/override-only.hbs',
      'added by override: {{project.name}}\n',
    );
    await writeTemplate(
      workspace,
      '.cleanstack/templates/spring-boot/manifest.json',
      JSON.stringify({
        files: [{ template: 'override-only.hbs', destination: 'OVERRIDE.md' }],
      }),
    );

    const engine = new TemplateEngine({ projectRoot: workspace });
    const output = new FileSystemService({ rootDir: workspace });
    const written = await renderManifest(
      'spring-boot',
      demoProject,
      templateContext(demoProject),
      engine,
      output,
      { log: () => {} },
    );

    assert.ok(written.includes('OVERRIDE.md'));
    assert.match(
      await readFile(path.join(workspace, 'OVERRIDE.md'), 'utf8'),
      /added by override: demo/,
    );
    // The overridden manifest fully controls the file list, so files that the
    // pack author removed stay untouched.
    assert.ok(!written.includes('pom.xml'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a manifest override without a files array is rejected with its source', async () => {
  const { root, workspace } = await createWorkspace();
  try {
    await writeTemplate(
      workspace,
      '.cleanstack/templates/spring-boot/manifest.json',
      JSON.stringify({ files: 'not-an-array' }),
    );

    const engine = new TemplateEngine({ projectRoot: workspace });
    await assert.rejects(
      renderManifest(
        'spring-boot',
        demoProject,
        templateContext(demoProject),
        engine,
        new FileSystemService({ rootDir: workspace }),
        { log: () => {} },
      ),
      /must declare a "files" array/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
