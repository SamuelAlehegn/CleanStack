import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TemplateEngine } from '../dist/templates/template-engine.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(repositoryRoot, 'templates', 'spring-boot');
const manifest = JSON.parse(await readFile(path.join(templateRoot, 'manifest.json'), 'utf8'));

function createContext(options) {
  return {
    project: {
      name: 'demo-shop',
      packageName: 'com.acme.shop',
      entities: [],
      options: {
        backend: true,
        frontend: false,
        database: 'postgresql',
        auth: 'none',
        buildTool: 'maven',
        docker: false,
        dryRun: false,
        outputDir: '.',
        ...options,
      },
    },
    entities: [],
  };
}

function destinationFor(entry) {
  return entry.destination
    .replaceAll('{{package}}', 'com/acme/shop')
    .replaceAll('{{ApplicationName}}', 'DemoShop');
}

function applies(entry, options) {
  return Object.entries(entry.when ?? {}).every(([key, expected]) => options[key] === expected);
}

async function renderProject(options) {
  const context = createContext(options);
  const engine = new TemplateEngine({
    projectRoot: path.join(repositoryRoot, 'tests', '.render'),
    userTemplatesDir: path.join(repositoryRoot, 'tests', '.render', 'user'),
    builtInTemplatesDir: templateRoot,
  });

  const files = new Map();
  for (const entry of manifest.files) {
    if (!applies(entry, context.project.options)) continue;
    files.set(destinationFor(entry), await engine.render(entry.template, context));
  }
  return files;
}

test('renders a complete Maven, PostgreSQL, Docker project', async () => {
  const files = await renderProject({
    database: 'postgresql',
    buildTool: 'maven',
    docker: true,
  });

  assert.ok(files.has('pom.xml'));
  assert.ok(files.has('Dockerfile'));
  assert.ok(files.has('docker-compose.yml'));
  assert.ok(files.has('src/main/java/com/acme/shop/DemoShopApplication.java'));
  assert.ok(files.has('src/main/java/com/acme/shop/infrastructure/security/package-info.java'));

  assert.match(files.get('pom.xml'), /<artifactId>spring-boot-starter-webmvc<\/artifactId>/);
  assert.match(files.get('pom.xml'), /<artifactId>postgresql<\/artifactId>/);
  assert.match(
    files.get('src/main/java/com/acme/shop/DemoShopApplication.java'),
    /package com\.acme\.shop;/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/application/GreetingService.java'),
    /public GreetingService\(Clock clock\)/,
  );
  assert.match(files.get('README.md'), /src\/main\/java\/com\/acme\/shop\//);
  assert.match(files.get('docker-compose.yml'), /SPRING_DATASOURCE_URL/);

  for (const [destination, content] of files) {
    assert.doesNotMatch(
      content,
      /\{\{/,
      `${destination} contains an unresolved template expression`,
    );
  }
});

test('renders a Gradle and H2 project without Docker files', async () => {
  const files = await renderProject({
    database: 'h2',
    buildTool: 'gradle',
    docker: false,
  });

  assert.ok(files.has('build.gradle.kts'));
  assert.ok(files.has('settings.gradle.kts'));
  assert.equal(files.has('pom.xml'), false);
  assert.equal(files.has('Dockerfile'), false);
  assert.equal(files.has('docker-compose.yml'), false);

  assert.match(files.get('build.gradle.kts'), /spring-boot-starter-webmvc/);
  assert.match(files.get('build.gradle.kts'), /spring-boot-h2console/);
  assert.match(files.get('build.gradle.kts'), /runtimeOnly\("com\.h2database:h2"\)/);
  assert.doesNotMatch(files.get('build.gradle.kts'), /org\.postgresql:postgresql/);
});

test('renders JWT and Keycloak resource-server configuration only when selected', async () => {
  for (const [auth, buildTool, issuerVariable] of [
    ['jwt', 'maven', 'JWT_ISSUER_URI'],
    ['keycloak', 'gradle', 'KEYCLOAK_ISSUER_URI'],
  ]) {
    const files = await renderProject({ auth, buildTool });
    const buildFile = buildTool === 'maven' ? files.get('pom.xml') : files.get('build.gradle.kts');
    const securityConfig = files.get(
      'src/main/java/com/acme/shop/infrastructure/security/SecurityConfig.java',
    );

    assert.ok(securityConfig);
    assert.match(buildFile, /spring-boot-starter-oauth2-resource-server/);
    assert.match(files.get('src/main/resources/application.yml'), new RegExp(issuerVariable));
    assert.match(securityConfig, /anyRequest\(\)\.authenticated\(\)/);
    assert.match(securityConfig, /actuator\/health/);
  }

  const unauthenticated = await renderProject({ auth: 'none' });
  assert.equal(
    unauthenticated.has('src/main/java/com/acme/shop/infrastructure/security/SecurityConfig.java'),
    false,
  );
  assert.doesNotMatch(unauthenticated.get('pom.xml'), /spring-boot-starter-oauth2-resource-server/);
});

test('every built-in template is referenced by the manifest', async () => {
  const referenced = new Set(
    manifest.files.map((entry) => path.join(templateRoot, entry.template)),
  );

  async function collect(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(entryPath);
      } else if (entry.name.endsWith('.hbs')) {
        assert.ok(
          referenced.has(entryPath),
          `${path.relative(templateRoot, entryPath)} is missing from manifest.json`,
        );
      }
    }
  }

  await collect(templateRoot);
});
