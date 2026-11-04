import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectDoctorReport, parseDoctorArguments, runDoctorCommand } from '../dist/cli/doctor.js';

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
    table() {},
  };
}

/** Builds a fake command runner from command name to output. Missing commands throw. */
function runnerFrom(outputs) {
  return async (command) => {
    const output = outputs[command];
    if (output === undefined) {
      throw Object.assign(new Error(`${command} was not found`), { code: 'ENOENT' });
    }
    return command === 'java' ? { stdout: '', stderr: output } : { stdout: output, stderr: '' };
  };
}

const healthyOutputs = {
  java: 'openjdk version "21.0.2" 2024-01-16',
  mvn: 'Apache Maven 3.9.6 (848b6a8)',
  git: 'git version 2.43.0',
};

async function createWorkspace(config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-doctor-'));
  await writeFile(
    path.join(root, '.cleanstackrc.yml'),
    config ?? 'name: demo\noptions:\n  database: h2\n',
  );
  return root;
}

/** Creates the minimum files project detection needs for an Angular frontend. */
async function createFrontend(root, name = 'demo-ui') {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, 'src', 'app'), { recursive: true });
  await writeFile(path.join(directory, 'angular.json'), '{}\n');
  return directory;
}

async function createTemplateRoot(manifests) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleanstack-templates-'));
  for (const [pack, manifest] of Object.entries(manifests)) {
    const packRoot = path.join(root, pack);
    await mkdir(packRoot, { recursive: true });
    await writeFile(path.join(packRoot, 'manifest.json'), manifest);
  }
  return root;
}

function check(report, name) {
  const found = report.checks.find((entry) => entry.name === name);
  assert.ok(found, `expected a ${name} check`);
  return found;
}

test('parses doctor arguments and rejects unknown input with guidance', () => {
  assert.deepEqual(parseDoctorArguments([]), { help: false });
  assert.deepEqual(parseDoctorArguments(['--help']), { help: true });
  assert.throws(
    () => parseDoctorArguments(['--fix']),
    (error) => /Unknown option/.test(error.message) && error.suggestions.length > 0,
  );
  assert.throws(() => parseDoctorArguments(['now']), /does not accept arguments/);
});

test('reports a healthy environment', async () => {
  const root = await createWorkspace();
  try {
    const report = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot: path.resolve('templates'),
    });

    assert.equal(report.failures, 0);
    assert.equal(report.warnings, 0);
    assert.equal(check(report, 'Node.js').status, 'ok');
    assert.equal(check(report, 'Java').status, 'ok');
    assert.match(check(report, 'Java').detail, /Java 21/);
    assert.equal(check(report, 'Build tool').status, 'ok');
    assert.match(check(report, 'Build tool').detail, /Maven 3\.9\.6/);
    assert.equal(check(report, 'Git').status, 'ok');
    assert.equal(check(report, 'Configuration').status, 'ok');
    assert.equal(check(report, 'Templates').status, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('detects old Node.js and Java versions with upgrade suggestions', async () => {
  const root = await createWorkspace();
  try {
    const report = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '18.19.0',
      commandRunner: runnerFrom({
        ...healthyOutputs,
        java: 'openjdk version "11.0.22" 2024-01-16',
      }),
      templateRoot: path.resolve('templates'),
    });

    const node = check(report, 'Node.js');
    assert.equal(node.status, 'fail');
    assert.match(node.detail, /requires 22\+/);
    assert.ok(node.suggestions.some((suggestion) => /nvm install 22/.test(suggestion)));

    const java = check(report, 'Java');
    assert.equal(java.status, 'fail');
    assert.match(java.detail, /target Java 21\+/);
    assert.ok(java.suggestions.some((suggestion) => /JDK 21/.test(suggestion)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('warns when Java, Git, and build tools are missing without blocking', async () => {
  const root = await createWorkspace();
  try {
    const report = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom({}),
      templateRoot: path.resolve('templates'),
    });

    assert.equal(report.failures, 0);
    assert.equal(check(report, 'Java').status, 'warn');
    assert.equal(check(report, 'Git').status, 'warn');
    assert.equal(check(report, 'Build tool').status, 'warn');
    assert.ok(report.warnings >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('warns when Angular CLI is missing for a generated frontend and accepts a local install', async () => {
  const root = await createWorkspace();
  try {
    const frontend = await createFrontend(root);
    const missing = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot: path.resolve('templates'),
      freeDiskBytes: 10 * 1024 ** 3,
    });

    const angular = check(missing, 'Angular CLI');
    assert.equal(angular.status, 'warn');
    assert.match(angular.detail, /demo-ui/);
    assert.ok(angular.suggestions.some((suggestion) => /npm install/.test(suggestion)));

    await mkdir(path.join(frontend, 'node_modules', '@angular', 'cli'), { recursive: true });
    const local = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot: path.resolve('templates'),
      freeDiskBytes: 10 * 1024 ** 3,
    });

    assert.equal(check(local, 'Angular CLI').status, 'ok');
    assert.match(check(local, 'Angular CLI').detail, /installed locally in demo-ui/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails on critically low disk space and warns when space is limited', async () => {
  const root = await createWorkspace();
  try {
    const collect = (freeDiskBytes) =>
      collectDoctorReport({
        cwd: root,
        env: {},
        nodeVersion: '22.5.1',
        commandRunner: runnerFrom(healthyOutputs),
        templateRoot: path.resolve('templates'),
        freeDiskBytes,
      });

    const critical = check(await collect(100 * 1024 * 1024), 'Disk space');
    assert.equal(critical.status, 'fail');
    assert.match(critical.detail, /100 MB free/);
    assert.ok(critical.suggestions.some((suggestion) => /Free disk space/.test(suggestion)));

    const limited = check(await collect(500 * 1024 * 1024), 'Disk space');
    assert.equal(limited.status, 'warn');
    assert.match(limited.detail, /500 MB free/);

    const healthy = check(await collect(10 * 1024 ** 3), 'Disk space');
    assert.equal(healthy.status, 'ok');
    assert.match(healthy.detail, /10 GB free/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports broken template manifests and missing template files', async () => {
  const root = await createWorkspace();
  const templateRoot = await createTemplateRoot({
    'spring-boot': JSON.stringify({
      files: [{ template: 'present.hbs', destination: 'present.txt' }],
    }),
    angular: JSON.stringify({
      files: [{ template: 'missing.hbs', destination: 'missing.txt' }],
    }),
  });
  try {
    await writeFile(path.join(templateRoot, 'spring-boot', 'present.hbs'), 'content\n');

    const report = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot,
      freeDiskBytes: 10 * 1024 ** 3,
    });

    const templates = check(report, 'Templates');
    assert.equal(templates.status, 'fail');
    assert.match(templates.detail, /angular\/missing\.hbs/);
    assert.ok(templates.suggestions.some((suggestion) => /Reinstall CleanStack/.test(suggestion)));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(templateRoot, { recursive: true, force: true });
  }
});

test('reports invalid template manifest JSON', async () => {
  const root = await createWorkspace();
  const templateRoot = await createTemplateRoot({
    'spring-boot': '{ not json',
    angular: JSON.stringify({ files: [] }),
  });
  try {
    const report = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot,
      freeDiskBytes: 10 * 1024 ** 3,
    });

    const templates = check(report, 'Templates');
    assert.equal(templates.status, 'fail');
    assert.match(templates.detail, /spring-boot: manifest\.json is not valid JSON/);
    assert.match(templates.detail, /angular: manifest declares no files/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(templateRoot, { recursive: true, force: true });
  }
});

test('reports invalid configuration with pretty validation errors', async () => {
  const root = await createWorkspace('name: demo\noptions:\n  database: oracle\n');
  try {
    const report = await collectDoctorReport({
      cwd: root,
      env: {},
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot: path.resolve('templates'),
    });

    const config = check(report, 'Configuration');
    assert.equal(config.status, 'fail');
    assert.match(config.detail, /options\.database/);
    assert.match(config.detail, /Expected one of: "postgresql", "mysql", "h2"/);
    assert.ok(config.suggestions.some((suggestion) => /config validate/.test(suggestion)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prints a report and sets a failing exit code when a check fails', async () => {
  const root = await createWorkspace('name: demo\noptions:\n  database: oracle\n');
  try {
    const logger = recordingLogger();
    let exitCode;
    await runDoctorCommand([], {
      cwd: root,
      env: {},
      logger,
      nodeVersion: '22.5.1',
      commandRunner: runnerFrom(healthyOutputs),
      templateRoot: path.resolve('templates'),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    const output = logger.messages.join('\n');
    assert.match(output, /CleanStack doctor/);
    assert.match(output, /✖ Configuration/);
    assert.match(output, /Fix the failed checks/);
    assert.equal(exitCode, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor --help prints usage without running checks', async () => {
  const logger = recordingLogger();
  await runDoctorCommand(['--help'], { logger, setExitCode: () => assert.fail('no exit code') });
  const output = logger.messages.join('\n');
  assert.match(output, /Usage: cleanstack doctor/);
  assert.match(output, /Node\.js, Java, Maven or Gradle/);
});
