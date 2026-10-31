import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
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

const defaults = { database: 'postgresql', auth: 'jwt', buildTool: 'maven', frontend: true, docker: false } as const;

export async function runNewCommand(args: string[], options: NewCommandOptions): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const { interactive, initializeGit, configArgs } = extractControlFlags(args);
  let cliOptions = mapFrontendOption(parseCommandLineOptions(configArgs));
  if (!cliOptions.name && interactive) cliOptions.name = await ask('Project name');

  if (!cliOptions.name) throw new CliOptionError('A project name is required. Usage: cleanstack new <project-name> [options]');
  const projectName = String(cliOptions.name).trim();
  if (!projectName || projectName === '.' || projectName === '..' || /[\\/]/.test(projectName)) {
    throw new CliOptionError('Project name must be a single directory name without path separators.');
  }
  cliOptions.name = projectName;

  if (interactive) {
    cliOptions = await collectInteractiveOptions(cliOptions);
  }
  const project = await new ConfigLoader().load({ cwd, cliOptions });
  const targetRelative = path.posix.join(project.options.outputDir, project.name);
  const filesystemLogger: FileSystemLogger = { log: (action) => options.logger.debug(`[filesystem] ${action.operation} ${action.path}: ${action.status}`) };
  const targetFs = new FileSystemService({ rootDir: cwd, logger: filesystemLogger });
  if (await targetFs.exists(targetRelative)) throw new FileExistsError(targetRelative);

  await targetFs.createDirectory(targetRelative);
  const outputFs = new FileSystemService({ rootDir: path.resolve(cwd, targetRelative), logger: filesystemLogger });
  const engine = new TemplateEngine();
  const context = { project, ...project, ...templateAliases(project) } as unknown as Record<string, unknown>;
  await renderManifest('spring-boot', project, context, engine, outputFs, filesystemLogger);
  if (project.options.frontend) {
    await outputFs.createDirectory('web');
    await renderManifest(
      'angular',
      project,
      context,
      engine,
      new FileSystemService({ rootDir: path.join(outputFs.rootDir, 'web'), logger: filesystemLogger }),
      filesystemLogger,
    );
  }

  if (initializeGit) {
    execFileSync('git', ['init'], { cwd: outputFs.rootDir, stdio: 'ignore' });
    options.logger.success('Initialized git repository.');
  }
  options.logger.success(`Created ${project.name} in ${path.resolve(cwd, targetRelative)}.`);
  const nextSteps = [
    `cd ${targetRelative}`,
    ...(project.options.frontend ? ['(cd web && npm install)'] : []),
    ...(project.options.docker ? ['docker compose up --build'] : [project.options.buildTool === 'maven' ? './mvnw spring-boot:run' : './gradlew bootRun']),
  ];
  options.logger.info(`Next steps:\n  ${nextSteps.join('\n  ')}`);
}

function templateAliases(project: ProjectConfig): Record<string, unknown> {
  const words = project.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const applicationName = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('');
  return { ApplicationName: applicationName };
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
    if (entry.when && !Object.entries(entry.when).every(([key, value]) => getCondition(project, key) === value)) continue;
    const contents = await engine.render(`${templateSet}/${entry.template}`, context);
    const destination = entry.destination
      .replaceAll('{{package}}', project.packageName.replaceAll('.', '/'))
      .replaceAll('{{ApplicationName}}', String(context.ApplicationName));
    const parent = path.posix.dirname(destination);
    if (parent !== '.') await output.createDirectory(parent);
    await output.writeFile(destination, contents);
  }
}

async function outputManifestReader(templateSet: string, filesystemLogger: FileSystemLogger): Promise<string> {
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

function extractControlFlags(args: string[]): { interactive: boolean; initializeGit: boolean; configArgs: string[] } {
  let interactive = false;
  let initializeGit = false;
  const configArgs: string[] = [];
  for (const arg of args) {
    if (arg === '--interactive') interactive = true;
    else if (arg === '--git') initializeGit = true;
    else if (arg.startsWith('--frontend=')) {
      const value = arg.slice('--frontend='.length);
      if (value !== 'angular' && value !== 'none') throw new CliOptionError('Option "--frontend" must be "angular" or "none".');
      configArgs.push(`--frontend=${value === 'angular'}`);
    } else if (arg === '--frontend') {
      configArgs.push(arg);
    } else configArgs.push(arg);
  }
  const frontIndex = configArgs.indexOf('--frontend');
  if (frontIndex !== -1) {
    const value = configArgs[frontIndex + 1];
    if (value === 'angular' || value === 'none') configArgs[frontIndex + 1] = String(value === 'angular');
  }
  return { interactive, initializeGit, configArgs };
}

async function collectInteractiveOptions(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const partial = (input.options as Record<string, unknown> | undefined) ?? {};
  const options = { ...partial };
  options.database = options.database ?? ((await ask(`Database (${defaults.database})`)) || defaults.database);
  options.auth = options.auth ?? ((await ask(`Authentication (${defaults.auth})`)) || defaults.auth);
  options.buildTool = options.buildTool ?? ((await ask(`Build tool (${defaults.buildTool})`)) || defaults.buildTool);
  const frontendAnswer = options.frontend === undefined ? await ask('Frontend (angular/none, default angular)') : undefined;
  if (frontendAnswer !== undefined) options.frontend = frontendAnswer.trim() === '' || frontendAnswer === 'angular';
  if (typeof options.frontend === 'string') options.frontend = options.frontend === 'angular';
  options.docker = options.docker ?? (await ask('Include Docker? (y/N)')).toLowerCase() === 'y';
  return { ...input, options };
}

async function ask(question: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try { return (await terminal.question(`${question}: `)).trim(); }
  finally { terminal.close(); }
}
