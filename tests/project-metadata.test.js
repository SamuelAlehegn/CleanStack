import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inferProjectConfig } from '../dist/core/project-metadata.js';

async function createProject({ applicationYml = '', securityConfig } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-metadata-'));
  const backendDirectory = path.join(rootDir, 'demo-backend');
  const resources = path.join(backendDirectory, 'src', 'main', 'resources');
  const javaRoot = path.join(backendDirectory, 'src', 'main', 'java', 'com', 'acme', 'shop');

  await mkdir(resources, { recursive: true });
  await mkdir(path.join(javaRoot, 'security'), { recursive: true });
  await writeFile(
    path.join(resources, 'application.yml'),
    `spring:\n  datasource:\n    url: "jdbc:h2:mem:demo"\n${applicationYml}`,
  );
  if (securityConfig !== undefined) {
    await writeFile(path.join(javaRoot, 'security', 'SecurityConfig.java'), securityConfig);
  }

  return {
    rootDir,
    project: {
      rootDir,
      relativeRootDir: '.',
      workspaceRoot: rootDir,
      backend: {
        directory: backendDirectory,
        relativeDirectory: 'demo-backend',
        packageName: 'com.acme.shop',
        buildTool: 'maven',
      },
      frontend: {
        directory: path.join(rootDir, 'demo-ui'),
        relativeDirectory: 'demo-ui',
      },
    },
  };
}

test('infers the authentication mode from generated security configuration', async () => {
  const cases = [
    [
      'session',
      {
        securityConfig: 'void configure(HttpSecurity http) { http.formLogin(); }',
      },
    ],
    [
      'auth0',
      {
        applicationYml:
          '      jwt:\n        issuer-uri: ${AUTH0_ISSUER_URI:https://example.auth0.com}\n',
        securityConfig: 'class SecurityConfig {}',
      },
    ],
    [
      'oidc',
      {
        applicationYml:
          '      jwt:\n        issuer-uri: ${OIDC_ISSUER_URI:https://issuer.example.com}\n',
        securityConfig: 'class SecurityConfig {}',
      },
    ],
    [
      'keycloak',
      {
        applicationYml:
          '      jwt:\n        issuer-uri: ${KEYCLOAK_ISSUER_URI:http://localhost:8081/realms/demo}\n',
        securityConfig: 'class SecurityConfig {}',
      },
    ],
    [
      'jwt',
      {
        applicationYml: '      jwt:\n        issuer-uri: ${JWT_ISSUER_URI:http://localhost:9000}\n',
        securityConfig: 'class SecurityConfig {}',
      },
    ],
  ];

  for (const [auth, files] of cases) {
    const { rootDir, project } = await createProject(files);
    try {
      const config = await inferProjectConfig(project);
      assert.equal(config.options.auth, auth);
      assert.equal(config.options.database, 'h2');
      assert.equal(config.options.backend, true);
      assert.equal(config.options.frontend, true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('infers no authentication when the security configuration is absent', async () => {
  const { rootDir, project } = await createProject();
  try {
    const config = await inferProjectConfig(project);
    assert.equal(config.options.auth, 'none');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
