import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TemplateEngine, TemplateNotFoundError } from '../dist/templates/template-engine.js';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-template-engine-'));
  const projectRoot = path.join(root, 'project');
  const userTemplatesDir = path.join(root, 'user', '.cleanstack', 'templates');
  const builtInTemplatesDir = path.join(root, 'built-in');

  return {
    root,
    projectRoot,
    projectTemplatesDir: path.join(projectRoot, '.cleanstack', 'templates'),
    userTemplatesDir,
    builtInTemplatesDir,
    engine: (options = {}) =>
      new TemplateEngine({ projectRoot, userTemplatesDir, builtInTemplatesDir, ...options }),
    async write(directory, relativePath, content) {
      const filePath = path.join(directory, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
      return filePath;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('project templates override user and built-in templates', async () => {
  const fixture = await createFixture();
  try {
    await fixture.write(fixture.projectTemplatesDir, 'greeting.hbs', 'project {{name}}');
    await fixture.write(fixture.userTemplatesDir, 'greeting.hbs', 'user {{name}}');
    await fixture.write(fixture.builtInTemplatesDir, 'greeting.hbs', 'built-in {{name}}');

    assert.equal(await fixture.engine().render('greeting', { name: 'Ada' }), 'project Ada');
  } finally {
    await fixture.cleanup();
  }
});

test('falls back from project to user and built-in templates', async () => {
  const fixture = await createFixture();
  try {
    await fixture.write(fixture.userTemplatesDir, 'user-only.hbs', 'from user');
    await fixture.write(fixture.builtInTemplatesDir, 'built-in-only.hbs', 'from built-in');

    assert.equal(await fixture.engine().render('user-only', {}), 'from user');
    assert.equal(await fixture.engine().render('built-in-only', {}), 'from built-in');
  } finally {
    await fixture.cleanup();
  }
});

test('loads partials and applies the same location priority', async () => {
  const fixture = await createFixture();
  try {
    await fixture.write(fixture.projectTemplatesDir, 'page.hbs', '{{> header}}');
    await fixture.write(fixture.projectTemplatesDir, 'partials/header.hbs', 'project header');
    await fixture.write(fixture.userTemplatesDir, 'partials/header.hbs', 'user header');
    await fixture.write(fixture.builtInTemplatesDir, 'partials/header.hbs', 'built-in header');

    assert.equal(await fixture.engine().render('page', {}), 'project header');
  } finally {
    await fixture.cleanup();
  }
});

test('registers naming, pluralization, comparison, and JSON helpers', async () => {
  const fixture = await createFixture();
  try {
    await fixture.write(
      fixture.builtInTemplatesDir,
      'helpers.hbs',
      '{{camelCase "HTTP response_code"}}|{{pascalCase "user profile"}}|{{pluralize "category"}}|{{pluralize 2 "entity"}}|{{#if (eq value "ok")}}yes{{/if}}|{{json payload}}',
    );

    const output = await fixture.engine().render('helpers', {
      value: 'ok',
      payload: { active: true },
    });
    assert.equal(
      output,
      'httpResponseCode|UserProfile|categories|entities|yes|{\n  "active": true\n}',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('dry-run mode renders a preview without modifying templates', async () => {
  const fixture = await createFixture();
  try {
    const templatePath = await fixture.write(
      fixture.projectTemplatesDir,
      'preview.hbs',
      'Hello {{name}}',
    );
    const engine = fixture.engine({ dryRun: true });

    assert.equal(engine.dryRun, true);
    assert.equal(await engine.render('preview', { name: 'Grace' }), 'Hello Grace');
    assert.equal(await readFile(templatePath, 'utf8'), 'Hello {{name}}');
  } finally {
    await fixture.cleanup();
  }
});

test('missing templates report every searched location', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(fixture.engine().render('missing', {}), (error) => {
      assert.ok(error instanceof TemplateNotFoundError);
      assert.match(error.message, /Template "missing" was not found/);
      assert.equal(error.searchedPaths.length, 3);
      assert.match(error.message, /project[\\/]\.cleanstack[\\/]templates/);
      return true;
    });
  } finally {
    await fixture.cleanup();
  }
});

test('rejects traversal paths', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(fixture.engine().render('../outside', {}), /must be a relative path/);
  } finally {
    await fixture.cleanup();
  }
});
