import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TemplateEngine } from '../dist/templates/template-engine.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateRoot = path.join(repositoryRoot, 'templates', 'angular');
const manifest = JSON.parse(await readFile(path.join(templateRoot, 'manifest.json'), 'utf8'));

const OIDC_AUTH_MODES = new Set(['oidc', 'keycloak', 'auth0']);

function applies(entry, options) {
  return Object.entries(entry.when ?? {}).every(([key, expected]) =>
    Array.isArray(expected) ? expected.includes(options[key]) : options[key] === expected,
  );
}

function createContext(auth) {
  const project = {
    name: 'demo-shop',
    packageName: 'com.acme.shop',
    entities: [],
    options: {
      backend: true,
      frontend: true,
      database: 'postgresql',
      auth,
      buildTool: 'maven',
      docker: false,
      migrationTool: 'flyway',
      seed: false,
      dryRun: false,
      outputDir: '.',
    },
  };
  return { project, entities: [], ApplicationName: 'DemoShop' };
}

async function renderProject(auth) {
  const context = createContext(auth);
  const engine = new TemplateEngine({
    projectRoot: path.join(repositoryRoot, 'tests', '.render'),
    userTemplatesDir: path.join(repositoryRoot, 'tests', '.render', 'user'),
    builtInTemplatesDir: templateRoot,
  });

  const files = new Map();
  for (const entry of manifest.files) {
    if (entry.internal === true) continue;
    if (!applies(entry, context.project.options)) continue;
    const items = entry.forEach === 'entities' ? [] : [undefined];
    for (const item of items) {
      const entryContext = item ? { ...context, entity: item } : context;
      files.set(entry.destination, await engine.render(entry.template, entryContext));
    }
  }
  return files;
}

test('renders JWT login, profile, guard, and token interceptor', async () => {
  const files = await renderProject('jwt');

  assert.match(files.get('src/app/core/auth/auth.service.ts'), /TOKEN_KEY/);
  assert.match(files.get('src/app/core/auth/auth.guard.ts'), /canActivate|CanActivateFn/);
  assert.match(files.get('src/app/core/auth/auth.interceptor.ts'), /Authorization/);
  assert.ok(files.has('src/app/pages/auth/login/login.component.ts'));
  assert.ok(files.has('src/app/pages/auth/profile/profile.component.ts'));
  assert.match(files.get('src/app/pages/auth/login/login.component.html'), /Access token/);
  assert.match(files.get('src/app/app.routes.ts'), /path: 'login'/);
  assert.match(files.get('src/app/app.routes.ts'), /path: 'profile'/);
  assert.match(files.get('src/app/app.routes.ts'), /canActivate: \[authGuard\]/);
  assert.match(files.get('src/app/app.config.ts'), /provideAppInitializer/);
  assert.match(files.get('src/app/app.config.ts'), /withInterceptors\(\[authInterceptor\]\)/);
  assert.doesNotMatch(files.get('src/app/app.config.ts'), /provideAuth/);
  assert.doesNotMatch(files.get('package.json'), /angular-auth-oidc-client/);
  assert.match(files.get('src/environments/environment.ts'), /authMode: 'jwt'/);
});

test('renders session login with CSRF bootstrap and cookie interceptor', async () => {
  const files = await renderProject('session');

  assert.match(files.get('src/app/core/auth/auth.service.ts'), /ensureCsrfToken/);
  assert.match(files.get('src/app/core/auth/auth.service.ts'), /URLSearchParams/);
  assert.match(files.get('src/app/core/auth/auth.interceptor.ts'), /withCredentials/);
  assert.match(files.get('src/app/pages/auth/login/login.component.html'), /Username/);
  assert.match(files.get('src/app/pages/auth/login/login.component.html'), /APP_SECURITY_USERNAME/);
  assert.match(files.get('src/app/app.config.ts'), /withInterceptors\(\[authInterceptor\]\)/);
  assert.doesNotMatch(files.get('package.json'), /angular-auth-oidc-client/);
  assert.match(files.get('src/environments/environment.ts'), /authMode: 'session'/);
});

test('renders OIDC login for Keycloak, Auth0, and generic providers', async () => {
  for (const auth of OIDC_AUTH_MODES) {
    const files = await renderProject(auth);

    assert.match(files.get('src/app/core/auth/auth.service.ts'), /OidcSecurityService/);
    assert.match(files.get('src/app/core/auth/auth.service.ts'), /checkAuth/);
    assert.match(files.get('package.json'), /angular-auth-oidc-client/);
    assert.match(files.get('src/app/app.config.ts'), /provideAuth/);
    assert.match(files.get('src/app/app.config.ts'), /environment\.oidc\.issuer/);
    assert.match(files.get('src/app/app.config.ts'), /withInterceptors\(\[authInterceptor\(\)\]\)/);
    assert.match(files.get('src/app/pages/auth/login/login.component.html'), /Continue with/);
    assert.match(files.get('src/environments/environment.ts'), new RegExp(`authMode: '${auth}'`));
    assert.match(files.get('src/environments/environment.ts'), /oidc: \{/);
    assert.equal(files.has('src/app/core/auth/auth.interceptor.ts'), false);
  }
});

test('omits authentication files and providers when authentication is disabled', async () => {
  const files = await renderProject('none');

  assert.equal(files.has('src/app/core/auth/auth.service.ts'), false);
  assert.equal(files.has('src/app/core/auth/auth.guard.ts'), false);
  assert.equal(files.has('src/app/core/auth/auth.interceptor.ts'), false);
  assert.equal(files.has('src/app/pages/auth/login/login.component.ts'), false);
  assert.equal(files.has('src/app/pages/auth/profile/profile.component.ts'), false);
  assert.doesNotMatch(files.get('src/app/app.routes.ts'), /authGuard/);
  assert.doesNotMatch(
    files.get('src/app/app.config.ts'),
    /AuthService|provideAppInitializer|provideAuth/,
  );
  assert.doesNotMatch(files.get('package.json'), /angular-auth-oidc-client/);
  assert.match(files.get('src/environments/environment.ts'), /authMode: 'none'/);
});

test('every Angular template is referenced by the manifest', async () => {
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
