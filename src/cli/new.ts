import { execFileSync } from 'node:child_process';
import { confirm, input as inputPrompt, select } from '@inquirer/prompts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigLoader, CliOptionError, parseCommandLineOptions } from '../core/config-loader.js';
import type { ProjectConfig } from '../core/config.js';
import { TemplateEngine } from '../templates/template-engine.js';
import { FileExistsError, FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import type { Logger } from '../utils/logger.js';

interface ManifestEntry {
  template: string;
  destination: string;
  when?: Record<string, unknown>;
}

interface TemplateManifest {
  files: ManifestEntry[];
}

interface NewCommandOptions {
  cwd?: string;
  logger: Logger;
}

const defaults = {
  packageName: 'com.example',
  database: 'postgresql',
  auth: 'jwt',
  buildTool: 'maven',
  frontend: true,
  docker: false,
} as const;
const JAVA_PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export async function runNewCommand(args: string[], options: NewCommandOptions): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const { interactive, yes, initializeGit, configArgs } = extractControlFlags(args);
  let cliOptions = mapFrontendOption(parseCommandLineOptions(configArgs));
  if (!yes && (interactive || hasMissingSettings(cliOptions))) {
    cliOptions = await collectInteractiveOptions(cliOptions);
  }
  validateProjectName(cliOptions.name);
  const project = await new ConfigLoader().load({ cwd, cliOptions });
  const targetRelative = path.posix.join(project.options.outputDir, project.name);
  const filesystemLogger: FileSystemLogger = {
    log: (action) =>
      options.logger.debug(`[filesystem] ${action.operation} ${action.path}: ${action.status}`),
  };
  const targetFs = new FileSystemService({ rootDir: cwd, logger: filesystemLogger });
  if (await targetFs.exists(targetRelative)) throw new FileExistsError(targetRelative);

  await targetFs.createDirectory(targetRelative);
  const projectRootFs = new FileSystemService({
    rootDir: path.resolve(cwd, targetRelative),
    logger: filesystemLogger,
  });
  const engine = new TemplateEngine();
  const backendProject = withProjectSuffix(project, 'backend');
  const backendDirectory = `${kebabCase(project.name)}-backend`;
  await projectRootFs.createDirectory(backendDirectory);
  const backendFs = new FileSystemService({
    rootDir: path.join(projectRootFs.rootDir, backendDirectory),
    logger: filesystemLogger,
  });
  await renderManifest(
    'spring-boot',
    backendProject,
    templateContext(backendProject),
    engine,
    backendFs,
    filesystemLogger,
  );

  const uiDirectory = `${kebabCase(project.name)}-ui`;
  if (project.options.frontend) {
    await projectRootFs.createDirectory(uiDirectory);
    const uiProject = withProjectSuffix(project, 'ui');
    await renderManifest(
      'angular',
      uiProject,
      templateContext(uiProject),
      engine,
      new FileSystemService({
        rootDir: path.join(projectRootFs.rootDir, uiDirectory),
        logger: filesystemLogger,
      }),
      filesystemLogger,
    );
  }

  if (initializeGit) {
    execFileSync('git', ['init'], { cwd: projectRootFs.rootDir, stdio: 'ignore' });
    options.logger.success('Initialized git repository.');
  }
  options.logger.success(`Created ${project.name} in ${path.resolve(cwd, targetRelative)}.`);
  const nextSteps = [
    `cd ${targetRelative}`,
    ...(project.options.frontend ? [`(cd ${uiDirectory} && npm install && npm start)`] : []),
    ...(project.options.docker
      ? [`(cd ${backendDirectory} && docker compose up --build)`]
      : [
          project.options.buildTool === 'maven'
            ? `(cd ${backendDirectory} && mvn spring-boot:run -Dspring-boot.run.profiles=dev)`
            : `(cd ${backendDirectory} && gradle bootRun --args='--spring.profiles.active=dev')`,
        ]),
  ];
  options.logger.info(`Next steps:\n  ${nextSteps.join('\n  ')}`);
}

function withProjectSuffix(project: ProjectConfig, suffix: 'backend' | 'ui'): ProjectConfig {
  return { ...project, name: `${kebabCase(project.name)}-${suffix}` };
}

function templateContext(project: ProjectConfig): Record<string, unknown> {
  return { project, ...project, ...templateAliases(project) } as unknown as Record<string, unknown>;
}

function templateAliases(project: ProjectConfig): Record<string, unknown> {
  const words = project.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const applicationName = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('');
  return { ApplicationName: applicationName };
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .toLowerCase();
}

async function renderManifest(
  templateSet: string,
  project: ProjectConfig,
  context: Record<string, unknown>,
  engine: TemplateEngine,
  output: FileSystemService,
  filesystemLogger: FileSystemLogger,
): Promise<void> {
  const manifestText = await outputManifestReader(templateSet, filesystemLogger);
  const manifest = JSON.parse(manifestText) as TemplateManifest;
  for (const entry of manifest.files) {
    if (
      entry.when &&
      !Object.entries(entry.when).every(([key, value]) => getCondition(project, key) === value)
    )
      continue;
    const contents = await engine.render(`${templateSet}/${entry.template}`, context);
    const destination = entry.destination
      .replaceAll('{{package}}', project.packageName.replaceAll('.', '/'))
      .replaceAll('{{ApplicationName}}', String(context.ApplicationName));
    const parent = path.posix.dirname(destination);
    if (parent !== '.') await output.createDirectory(parent);
    await output.writeFile(destination, contents);
  }
}

async function outputManifestReader(
  templateSet: string,
  filesystemLogger: FileSystemLogger,
): Promise<string> {
  const fs = new FileSystemService({
    rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates'),
    logger: filesystemLogger,
  });
  return fs.readFile(`${templateSet}/manifest.json`);
}

function getCondition(project: ProjectConfig, key: string): unknown {
  return key in project.options
    ? project.options[key as keyof ProjectConfig['options']]
    : (project as unknown as Record<string, unknown>)[key];
}

function mapFrontendOption(input: Record<string, unknown>): Record<string, unknown> {
  const options = input.options as Record<string, unknown> | undefined;
  if (options && typeof options.frontend === 'string') {
    if (options.frontend !== 'angular' && options.frontend !== 'none') {
      throw new CliOptionError('Option "--frontend" must be "angular" or "none".');
    }
    options.frontend = options.frontend === 'angular';
  }
  return input;
}

function extractControlFlags(args: string[]): {
  interactive: boolean;
  yes: boolean;
  initializeGit: boolean;
  configArgs: string[];
} {
  let interactive = false;
  let yes = false;
  let initializeGit = false;
  const configArgs: string[] = [];
  for (const arg of args) {
    if (arg === '--interactive') interactive = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--git') initializeGit = true;
    else if (arg.startsWith('--frontend=')) {
      const value = arg.slice('--frontend='.length);
      if (value !== 'angular' && value !== 'none')
        throw new CliOptionError('Option "--frontend" must be "angular" or "none".');
      configArgs.push(`--frontend=${value === 'angular'}`);
    } else if (arg === '--frontend') {
      configArgs.push(arg);
    } else configArgs.push(arg);
  }
  const frontIndex = configArgs.indexOf('--frontend');
  if (frontIndex !== -1) {
    const value = configArgs[frontIndex + 1];
    if (value === 'angular' || value === 'none')
      configArgs[frontIndex + 1] = String(value === 'angular');
  }
  return { interactive, yes, initializeGit, configArgs };
}

function hasMissingSettings(input: Record<string, unknown>): boolean {
  const options = (input.options as Record<string, unknown> | undefined) ?? {};
  return (
    input.name === undefined ||
    input.packageName === undefined ||
    options.database === undefined ||
    options.auth === undefined ||
    options.buildTool === undefined ||
    options.frontend === undefined ||
    options.docker === undefined
  );
}

function validateProjectName(value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliOptionError(
      'A project name is required. Usage: cleanstack new <project-name> [options]',
    );
  }
  const projectName = value.trim();
  if (projectName === '.' || projectName === '..' || /[\\/]/.test(projectName)) {
    throw new CliOptionError(
      'Project name must be a single directory name without path separators.',
    );
  }
}

async function collectInteractiveOptions(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name =
    input.name ??
    (await inputPrompt({
      message: 'What should we call your project?',
      default: 'my-cleanstack-app',
      validate: (value) => {
        try {
          validateProjectName(value);
          return true;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    }));
  const packageName =
    input.packageName ??
    (await inputPrompt({
      message: 'Java package name',
      default: defaults.packageName,
      validate: (value) =>
        JAVA_PACKAGE_PATTERN.test(value.trim()) ||
        'Enter a valid Java package, such as com.example.app.',
    }));
  const partial = (input.options as Record<string, unknown> | undefined) ?? {};
  const options = { ...partial };
  options.database ??= await select({
    message: 'Which database should the backend use?',
    default: defaults.database,
    choices: [
      { name: 'PostgreSQL', value: 'postgresql' },
      { name: 'H2 (in-memory)', value: 'h2' },
      { name: 'MySQL', value: 'mysql' },
    ],
  });
  options.auth ??= await select({
    message: 'How should authentication be handled?',
    default: defaults.auth,
    choices: [
      { name: 'JWT resource server', value: 'jwt' },
      { name: 'No authentication', value: 'none' },
      { name: 'Keycloak', value: 'keycloak' },
    ],
  });
  options.buildTool ??= await select({
    message: 'Choose a Java build tool',
    default: defaults.buildTool,
    choices: [
      { name: 'Maven', value: 'maven' },
      { name: 'Gradle', value: 'gradle' },
    ],
  });
  options.frontend ??= await select({
    message: 'Include a frontend?',
    default: defaults.frontend,
    choices: [
      { name: 'Angular', value: true },
      { name: 'No frontend', value: false },
    ],
  });
  options.docker ??= await confirm({ message: 'Include Docker files?', default: defaults.docker });
  return { ...input, name, packageName, options };
}
