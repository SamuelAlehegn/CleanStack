import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEntityModels } from '../dist/core/entity-model.js';
import { withSqlMetadata } from '../dist/core/sql-types.js';
import { TemplateEngine } from '../dist/templates/template-engine.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(repositoryRoot, 'templates', 'spring-boot');
const manifest = JSON.parse(await readFile(path.join(templateRoot, 'manifest.json'), 'utf8'));

function createContext(options, configuredEntities = []) {
  const database = options.database ?? 'postgresql';
  const entities = buildEntityModels(configuredEntities).map((entity, index) => ({
    ...withSqlMetadata(entity, database),
    migrationVersion: index + 2,
  }));
  return {
    project: {
      name: 'demo-shop',
      packageName: 'com.acme.shop',
      entities,
      options: {
        backend: true,
        frontend: false,
        database: 'postgresql',
        auth: 'none',
        buildTool: 'maven',
        docker: false,
        migrationTool: 'flyway',
        seed: false,
        dryRun: false,
        outputDir: '.',
        ...options,
      },
    },
    entities,
  };
}

function destinationFor(entry) {
  return entry.destination
    .replaceAll('{{package}}', 'com/acme/shop')
    .replaceAll('{{ApplicationName}}', 'DemoShop');
}

function applies(entry, options) {
  return Object.entries(entry.when ?? {}).every(([key, expected]) =>
    Array.isArray(expected) ? expected.includes(options[key]) : options[key] === expected,
  );
}

async function renderProject(options) {
  const context = createContext(options, options.entities ?? []);
  const engine = new TemplateEngine({
    projectRoot: path.join(repositoryRoot, 'tests', '.render'),
    userTemplatesDir: path.join(repositoryRoot, 'tests', '.render', 'user'),
    builtInTemplatesDir: templateRoot,
  });

  const files = new Map();
  for (const entry of manifest.files) {
    if (entry.internal === true) continue;
    if (!applies(entry, context.project.options)) continue;
    const items = entry.forEach === 'entities' ? context.entities : [undefined];
    for (const entity of items) {
      const entryContext = entity ? { ...context, entity } : context;
      const destination = destinationFor(entry).replace(
        /{{entity\.([A-Za-z][A-Za-z0-9]*)}}/g,
        (_match, key) => String(entity?.[key] ?? ''),
      );
      files.set(destination, await engine.render(entry.template, entryContext));
    }
  }
  return files;
}

async function renderEntityMigration(options, entityConfig, template, extra = {}) {
  const context = createContext(options, [entityConfig]);
  const engine = new TemplateEngine({
    projectRoot: path.join(repositoryRoot, 'tests', '.render'),
    userTemplatesDir: path.join(repositoryRoot, 'tests', '.render', 'user'),
    builtInTemplatesDir: templateRoot,
  });
  return engine.render(template, { ...context, entity: context.entities[0], ...extra });
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
  assert.ok(files.has('src/main/java/com/acme/shop/security/package-info.java'));
  assert.ok(files.has('src/main/java/com/acme/shop/config/ApplicationConfig.java'));
  assert.ok(files.has('src/main/java/com/acme/shop/controller/GreetingController.java'));
  assert.ok(files.has('src/main/java/com/acme/shop/service/GreetingService.java'));
  assert.equal(
    [...files.keys()].some((destination) =>
      /\/((application)|(infrastructure))\//.test(destination),
    ),
    false,
  );

  assert.match(files.get('pom.xml'), /<artifactId>spring-boot-starter-webmvc<\/artifactId>/);
  assert.match(files.get('pom.xml'), /<artifactId>postgresql<\/artifactId>/);
  assert.match(
    files.get('src/main/java/com/acme/shop/DemoShopApplication.java'),
    /package com\.acme\.shop;/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/service/GreetingService.java'),
    /public GreetingService\(Clock clock\)/,
  );
  assert.match(files.get('README.md'), /src\/main\/java\/com\/acme\/shop\//);
  assert.match(files.get('README.md'), /curl "http:\/\/localhost:8080\/api\/greetings\?name=Ada"/);
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
  assert.match(files.get('README.md'), /gradle bootRun "--args=--spring\.profiles\.active=dev"/);
  assert.doesNotMatch(files.get('README.md'), /--args='/);
});

test('renders JWT, OIDC, Keycloak, and Auth0 resource-server configuration', async () => {
  for (const [auth, buildTool, issuerVariable] of [
    ['jwt', 'maven', 'JWT_ISSUER_URI'],
    ['oidc', 'maven', 'OIDC_ISSUER_URI'],
    ['keycloak', 'gradle', 'KEYCLOAK_ISSUER_URI'],
    ['auth0', 'gradle', 'AUTH0_ISSUER_URI'],
  ]) {
    const files = await renderProject({ auth, buildTool });
    const buildFile = buildTool === 'maven' ? files.get('pom.xml') : files.get('build.gradle.kts');
    const securityConfig = files.get('src/main/java/com/acme/shop/security/SecurityConfig.java');

    assert.ok(securityConfig);
    assert.match(buildFile, /spring-boot-starter-oauth2-resource-server/);
    assert.match(files.get('src/main/resources/application.yml'), new RegExp(issuerVariable));
    assert.match(securityConfig, /anyRequest\(\)\.authenticated\(\)/);
    assert.match(securityConfig, /actuator\/health/);
    assert.match(
      files.get('src/main/java/com/acme/shop/controller/AuthController.java'),
      /@RequestMapping\("\/api\/auth"\)/,
    );
  }
});

test('renders session login security without OAuth2 resource-server dependencies', async () => {
  const files = await renderProject({ auth: 'session', buildTool: 'maven' });
  const securityConfig = files.get('src/main/java/com/acme/shop/security/SecurityConfig.java');
  const authController = files.get('src/main/java/com/acme/shop/controller/AuthController.java');

  assert.match(files.get('pom.xml'), /spring-boot-starter-security/);
  assert.doesNotMatch(files.get('pom.xml'), /spring-boot-starter-oauth2-resource-server/);
  assert.match(securityConfig, /formLogin/);
  assert.match(securityConfig, /logoutUrl\("\/api\/auth\/logout"\)/);
  assert.match(securityConfig, /CookieCsrfTokenRepository/);
  assert.match(securityConfig, /setCookiePath\("\/"\)/);
  assert.match(securityConfig, /InMemoryUserDetailsManager/);
  assert.match(files.get('src/main/resources/application.yml'), /APP_SECURITY_USERNAME/);
  assert.match(files.get('src/main/resources/application.yml'), /servlet:[\s\S]*session:/);
  assert.match(authController, /@GetMapping\("\/csrf"\)/);
  assert.match(authController, /@GetMapping\("\/me"\)/);
});

test('omits security files and dependencies when authentication is disabled', async () => {
  const unauthenticated = await renderProject({ auth: 'none' });
  assert.equal(
    unauthenticated.has('src/main/java/com/acme/shop/security/SecurityConfig.java'),
    false,
  );
  assert.equal(
    unauthenticated.has('src/main/java/com/acme/shop/controller/AuthController.java'),
    false,
  );
  assert.doesNotMatch(unauthenticated.get('pom.xml'), /spring-boot-starter-oauth2-resource-server/);
  assert.doesNotMatch(unauthenticated.get('pom.xml'), /spring-boot-starter-security/);
});

test('publishes the OpenAPI contract with springdoc', async () => {
  const files = await renderProject({ auth: 'jwt' });

  assert.match(files.get('pom.xml'), /springdoc-openapi-starter-webmvc-ui/);
  assert.match(files.get('pom.xml'), /<springdoc.version>3\.2\.0<\/springdoc.version>/);
  assert.match(files.get('src/main/resources/application.yml'), /springdoc:/);
  assert.match(files.get('src/main/resources/application.yml'), /\/v3\/api-docs/);
  assert.match(
    files.get('src/main/java/com/acme/shop/config/OpenApiConfig.java'),
    /class OpenApiConfig/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/security/SecurityConfig.java'),
    /\/v3\/api-docs\/\*\*/,
  );
  assert.match(files.get('README.md'), /cleanstack openapi/);
  assert.match(files.get('README.md'), /--contract-first/);

  const gradle = await renderProject({ buildTool: 'gradle' });
  assert.match(gradle.get('build.gradle.kts'), /springdoc-openapi-starter-webmvc-ui:3\.2\.0/);
});

test('renders entity artifacts and a Flyway migration for configured entities', async () => {
  const product = {
    name: 'Product',
    relations: [],
    fields: [
      { name: 'name', type: 'String', required: true, maxLength: 120, validations: [] },
      { name: 'price', type: 'BigDecimal', required: true, min: 0, validations: [] },
      { name: 'createdAt', type: 'Instant', required: true, validations: [] },
    ],
  };
  const options = { entities: [product] };
  const files = await renderProject(options);
  const migration = await renderEntityMigration(
    options,
    product,
    'resources/db/migration/CreateTable.sql.hbs',
  );

  assert.match(files.get('src/main/java/com/acme/shop/domain/Product.java'), /class Product/);
  assert.match(
    files.get('src/main/java/com/acme/shop/domain/Product.java'),
    /@Entity[\s\S]*@Table\(name = "products"\)/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/controller/ProductController.java'),
    /@RequestMapping\("\/api\/products"\)/,
  );
  assert.match(migration, /CREATE TABLE products[\s\S]*name VARCHAR\(120\) NOT NULL/);
  assert.match(migration, /created_at TIMESTAMP WITH TIME ZONE NOT NULL/);
  assert.match(
    files.get('src/main/java/com/acme/shop/web/dto/ProductRequest.java'),
    /import java\.math\.BigDecimal;/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/web/dto/ProductRequest.java'),
    /import java\.time\.Instant;/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/web/dto/ProductResponse.java'),
    /import java\.math\.BigDecimal;/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/service/ProductService.java'),
    /entity\.setId\(id\)/,
  );
  assert.match(
    files.get('src/main/java/com/acme/shop/config/ApplicationConfig.java'),
    /package com\.acme\.shop\.config;/,
  );
  assert.ok(files.has('src/main/java/com/acme/shop/repository/ProductRepository.java'));
  assert.ok(files.has('src/main/java/com/acme/shop/exception/ProductNotFoundException.java'));
  assert.ok(files.has('src/main/java/com/acme/shop/web/mapper/ProductMapper.java'));
  assert.equal(
    [...files.keys()].some((destination) =>
      /\/((application)|(infrastructure))\//.test(destination),
    ),
    false,
  );
});

test('renders Liquibase changelogs and dependencies when selected', async () => {
  const product = {
    name: 'Product',
    relations: [],
    fields: [
      { name: 'name', type: 'String', required: true, validations: [] },
      { name: 'active', type: 'boolean', required: true, default: true, validations: [] },
    ],
  };
  const options = { migrationTool: 'liquibase', database: 'mysql', entities: [product] };
  const files = await renderProject(options);

  assert.ok(files.has('src/main/resources/db/changelog/db.changelog-master.xml'));
  assert.match(
    files.get('src/main/resources/db/changelog/db.changelog-master.xml'),
    /includeAll path="changes"/,
  );
  assert.ok(files.has('src/main/resources/db/changelog/changes/V1__baseline.xml'));
  assert.equal(files.has('src/main/resources/db/migration/V1__baseline.sql'), false);
  assert.match(
    files.get('src/main/resources/application.yml'),
    /liquibase:[\s\S]*db\.changelog-master\.xml/,
  );
  assert.doesNotMatch(files.get('src/main/resources/application.yml'), /flyway:/);
  assert.match(files.get('pom.xml'), /org\.liquibase[\s\S]*liquibase-core/);
  assert.doesNotMatch(files.get('pom.xml'), /spring-boot-starter-flyway/);

  const migration = await renderEntityMigration(
    options,
    product,
    'resources/db/changelog/changes/CreateTable.xml.hbs',
  );
  assert.match(migration, /<createTable tableName="products">/);
  assert.match(migration, /<column name="id" type="CHAR\(36\)">/);
  assert.match(migration, /defaultValueBoolean="true"/);
});

test('renders update and seed migration templates', async () => {
  const product = {
    name: 'Product',
    relations: [],
    fields: [
      { name: 'name', type: 'String', required: true, validations: [] },
      { name: 'price', type: 'BigDecimal', validations: [] },
    ],
  };
  const migration = {
    action: 'update',
    version: 3,
    description: 'Update table products.',
    fileName: 'V3__update_products_add_sku.sql',
    changesetId: '3-update-products',
    author: 'cleanstack',
    changes: [
      {
        kind: 'add-column',
        label: 'add_sku',
        description: 'Add column sku',
        statements: ['ALTER TABLE products ADD COLUMN sku VARCHAR(255);'],
        liquibase:
          '<addColumn tableName="products"><column name="sku" type="VARCHAR(255)"/></addColumn>',
      },
    ],
    seedStatements: [
      "INSERT INTO products (id, name) VALUES ('00000000-0000-4000-8000-000000000000', 'Sample');",
    ],
    liquibaseSeed: '',
    seedRows: [],
    hasSeedData: false,
  };

  const update = await renderEntityMigration(
    { database: 'postgresql' },
    product,
    'resources/db/migration/UpdateTable.sql.hbs',
    { migration },
  );
  assert.match(update, /ALTER TABLE products ADD COLUMN sku VARCHAR\(255\);/);
  assert.match(update, /migration\.update\.3/);

  const seed = await renderEntityMigration(
    { database: 'postgresql' },
    product,
    'resources/db/migration/SeedData.sql.hbs',
    { migration },
  );
  assert.match(seed, /INSERT INTO products/);
  assert.match(seed, /migration\.seed\.product/);

  const liquibase = await renderEntityMigration(
    { migrationTool: 'liquibase' },
    product,
    'resources/db/changelog/changes/UpdateTable.xml.hbs',
    { migration },
  );
  assert.match(liquibase, /<addColumn tableName="products">/);
  assert.match(liquibase, /changeSet id="3-update-products"/);
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
