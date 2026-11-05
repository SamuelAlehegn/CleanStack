import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(repositoryRoot, 'dist', 'cli', 'index.js');
const e2eEnabled =
  process.env.CLEANSTACK_E2E === '1' || process.env.npm_lifecycle_event === 'test:e2e';

const entities = [
  {
    name: 'Category',
    contents: [
      'name: Category',
      'fields:',
      '  - name: title',
      '    type: String',
      '    required: true',
      '    maxLength: 80',
      '',
    ].join('\n'),
  },
  {
    name: 'Product',
    contents: [
      'name: Product',
      'fields:',
      '  - name: name',
      '    type: String',
      '    required: true',
      '    maxLength: 120',
      '  - name: price',
      '    type: BigDecimal',
      '    required: true',
      '    min: 0',
      'relations:',
      '  - type: ManyToOne',
      '    target: Category',
      '    field: category',
      '    required: true',
      '',
    ].join('\n'),
  },
  {
    name: 'Order',
    contents: [
      'name: Order',
      'fields:',
      '  - name: reference',
      '    type: String',
      '    required: true',
      '    maxLength: 40',
      '  - name: total',
      '    type: BigDecimal',
      '    required: true',
      '  - name: createdAt',
      '    type: Instant',
      '    generated: true',
      '',
    ].join('\n'),
  },
];

test(
  'a generated full-stack project passes its tests and starts',
  {
    skip: e2eEnabled
      ? false
      : 'End-to-end test is opt-in. Run "npm run test:e2e" or set CLEANSTACK_E2E=1.',
    timeout: 10 * 60 * 1000,
  },
  async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-e2e-'));
    let application;

    try {
      await runCli(workspace, [
        'new',
        'shop',
        '--package',
        'com.acme.shop',
        '--db',
        'h2',
        '--auth',
        'none',
        '--build',
        'maven',
        '--frontend',
        'angular',
        '--yes',
        '--no-entities',
      ]);

      const projectRoot = path.join(workspace, 'shop');
      const entitiesDirectory = path.join(projectRoot, 'entities');
      await mkdir(entitiesDirectory, { recursive: true });
      for (const entity of entities) {
        await writeFile(path.join(entitiesDirectory, `${entity.name}.yaml`), entity.contents);
        await runCli(projectRoot, ['entity', entity.name]);
      }

      await assertGeneratedProject(projectRoot);

      const backendRoot = path.join(projectRoot, 'shop-backend');
      const wrapperPath = path.join(
        backendRoot,
        process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw',
      );
      await access(wrapperPath);
      if (process.platform !== 'win32') {
        const mode = (await stat(wrapperPath)).mode;
        assert.ok((mode & 0o111) !== 0, 'The generated Maven wrapper must be executable.');
      }

      const javaHome = await resolveJavaHome();
      assert.ok(
        javaHome !== undefined,
        'Java 21 or later is required to run the generated project. Set JAVA_HOME and retry.',
      );
      const environment = { ...process.env, JAVA_HOME: javaHome };

      const testRun = await runWrapper(backendRoot, ['test', '-B'], environment);
      assert.match(testRun.stdout, /Tests run: 1, Failures: 0, Errors: 0, Skipped: 0/);
      assert.match(testRun.stdout, /BUILD SUCCESS/);

      const port = await freePort();
      application = startApplication(backendRoot, environment, port);
      const health = await waitForHealth(application, port, 2 * 60 * 1000);
      assert.equal(health.status, 'UP');

      const greeting = await getJson(`http://127.0.0.1:${port}/api/greetings?name=CleanStack`);
      assert.match(greeting.message, /^Hello, CleanStack!/);
    } finally {
      await stopApplication(application);
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

async function runCli(cwd, args) {
  try {
    return await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd,
      timeout: 2 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = String(error.stdout ?? '').trim();
    const stderr = String(error.stderr ?? '').trim();
    throw new Error(`cleanstack ${args.join(' ')} failed.\n${stdout}\n${stderr}`.trim(), {
      cause: error,
    });
  }
}

async function assertGeneratedProject(projectRoot) {
  const backend = path.join(projectRoot, 'shop-backend');
  const frontend = path.join(projectRoot, 'shop-ui');

  for (const entity of entities) {
    await access(
      path.join(
        backend,
        'src',
        'main',
        'java',
        'com',
        'acme',
        'shop',
        'domain',
        `${entity.name}.java`,
      ),
    );
    await access(
      path.join(
        backend,
        'src',
        'main',
        'java',
        'com',
        'acme',
        'shop',
        'controller',
        `${entity.name}Controller.java`,
      ),
    );
    await access(path.join(frontend, 'src', 'app', 'models', `${kebabCase(entity.name)}.ts`));
  }

  const product = await readFile(
    path.join(backend, 'src/main/java/com/acme/shop/domain/Product.java'),
    'utf8',
  );
  assert.match(product, /@ManyToOne/);

  const migrations = path.join(backend, 'src', 'main', 'resources', 'db', 'migration');
  for (const [index, table] of ['categories', 'products', 'orders'].entries()) {
    const migration = await readFile(
      path.join(migrations, `V${index + 2}__create_${table}_table.sql`),
      'utf8',
    );
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }

  const routes = await readFile(path.join(frontend, 'src', 'app', 'app.routes.ts'), 'utf8');
  for (const route of ['categories', 'products', 'orders']) {
    assert.equal(
      routes.match(new RegExp(`path: '${route}'`, 'g'))?.length,
      1,
      `Expected exactly one "${route}" route.`,
    );
  }
}

async function resolveJavaHome() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  try {
    const { stdout } = await execFileAsync('mvn', ['-v'], { timeout: 30 * 1000 });
    const match = /(?:Java home|runtime):\s*(.+)/i.exec(stdout);
    if (match?.[1]) candidates.push(match[1].trim().replace(/,$/, ''));
  } catch {
    // Maven is optional because the generated project includes its own wrapper.
  }

  for (const candidate of new Set(candidates)) {
    if (await isJava21OrNewer(candidate)) return candidate;
  }
  if (await isJava21OrNewer(undefined)) return process.env.JAVA_HOME ?? '';
  return undefined;
}

async function isJava21OrNewer(javaHome) {
  const java = javaHome
    ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';

  try {
    const result = await execFileAsync(java, ['-version'], { timeout: 15 * 1000 });
    return versionAtLeast(`${result.stdout}\n${result.stderr}`, 21);
  } catch (error) {
    return versionAtLeast(`${error.stdout ?? ''}\n${error.stderr ?? ''}`, 21);
  }
}

function versionAtLeast(output, minimum) {
  const match = /version "(\d+)/.exec(output);
  return match !== null && Number(match[1]) >= minimum;
}

async function runWrapper(cwd, args, environment) {
  try {
    return await execFileAsync(wrapperCommand(), args, {
      cwd,
      env: environment,
      timeout: 5 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    throw new Error(
      `Generated project command failed: ${wrapperCommand()} ${args.join(' ')}\n${tail(
        `${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      )}`,
      { cause: error },
    );
  }
}

function wrapperCommand() {
  return process.platform === 'win32' ? 'mvnw.cmd' : './mvnw';
}

function startApplication(cwd, environment, port) {
  const logs = [];
  const child = spawn(wrapperCommand(), ['-B', 'spring-boot:run'], {
    cwd,
    env: { ...environment, SERVER_PORT: String(port) },
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  return { child, logs };
}

async function waitForHealth(application, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (application.child.exitCode !== null) {
      throw new Error(
        `The generated application exited before becoming healthy.\n${tail(application.logs.join(''))}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/actuator/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'UP') return health;
      }
    } catch {
      // The server is still starting.
    }
    await delay(1000);
  }

  throw new Error(
    `The generated application did not become healthy within ${timeoutMs / 1000} seconds.\n${tail(
      application.logs.join(''),
    )}`,
  );
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `Expected ${url} to return HTTP 200.`);
  return response.json();
}

async function stopApplication(application) {
  if (application === undefined || application.child.exitCode !== null) return;

  const { child } = application;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitForExit(child, 10 * 1000)) return;

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The process exited while the timeout was being handled.
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function kebabCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function tail(output) {
  return output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .slice(-40)
    .join('\n');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
