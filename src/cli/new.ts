import { execFileSync } from 'node:child_process';
import { confirm, input as inputPrompt, select } from '@inquirer/prompts';
import path from 'node:path';
import { ConfigLoader, CliOptionError, parseCommandLineOptions } from '../core/config-loader.js';
import { JAVA_PACKAGE_PATTERN, type ProjectConfig } from '../core/config.js';
import { EntityParser } from '../core/entity-parser.js';
import { writeProjectMetadata } from '../core/project-metadata.js';
import {
  kebabCase,
  renderManifest,
  templateContext,
  withProjectSuffix,
} from '../templates/manifest.js';
import { TemplateEngine } from '../templates/template-engine.js';
import { FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import { isMissingPath } from '../utils/path-safety.js';
import type { Logger } from '../utils/logger.js';
import { conflictingFiles, reportGeneratedFiles } from './file-report.js';
import type { GeneratedFileResult } from '../core/generated-file.js';

interface NewCommandOptions {
  cwd?: string;
  logger: Logger;
}

export const NEW_USAGE = `Usage: cleanstack new <name> [options]

Create a new project skeleton.

Options:
  --package <name>             Java package, for example com.example
  --db <postgresql|h2|mysql>   Database (default: postgresql)
  --auth <jwt|none|keycloak>   Authentication (default: jwt)
  --build <maven|gradle>       Build tool (default: maven)
  --frontend <angular|none>    Frontend (default: angular)
  --docker                     Emit Docker files
  --entities                   Generate entities from the project configuration
  --no-entities                Skip configured entities
  --interactive                Prompt for any missing settings
  -y, --yes                    Skip prompts and use defaults for missing settings
  --git                        Initialize a git repository in the generated project
  --force                      Overwrite generated files completely, including protected regions
  --dry-run                    Show what would change without writing files
  -h, --help                   Show this help`;

const defaults = {
  packageName: 'com.example',
  database: 'postgresql',
  auth: 'jwt',
  buildTool: 'maven',
  frontend: true,
  docker: false,
} as const;
export async function runNewCommand(args: string[], options: NewCommandOptions): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const { interactive, yes, initializeGit, includeEntities, force, dryRun, help, configArgs } =
    extractControlFlags(args);
  if (help) {
    options.logger.info(NEW_USAGE);
    return;
  }
  let cliOptions = mapFrontendOption(parseCommandLineOptions(configArgs));
  const loader = new ConfigLoader();
  // File and environment defaults count as provided values, so `new` only
  // prompts for settings that are still missing.
  let provided = await loader.resolve({ cwd, cliOptions });
  if (!yes && (interactive || hasMissingSettings(provided))) {
    cliOptions = await collectInteractiveOptions(provided);
    provided = await loader.resolve({ cwd, cliOptions });
  }
  validateProjectName(provided.name);
  const project = await loader.load({ cwd, cliOptions });
  const inputFs = new FileSystemService({ rootDir: cwd, logger: { log: () => {} } });
  let entityDescriptorFiles: string[] = [];
  if (await inputFs.exists('entities')) {
    try {
      entityDescriptorFiles = (await inputFs.listFiles('entities')).filter((file) =>
        /\.(yaml|yml|json)$/i.test(file),
      );
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
  const hasEntityDefinitions = project.entities.length > 0 || entityDescriptorFiles.length > 0;
  const shouldIncludeEntities =
    includeEntities ??
    (yes
      ? hasEntityDefinitions
      : await confirm({
          message: 'Include entities from the project configuration or entities/ directory?',
          default: hasEntityDefinitions,
        }));
  let generationProject = { ...project, entities: [] as ProjectConfig['entities'] };
  if (shouldIncludeEntities) {
    const entities =
      project.entities.length > 0
        ? project.entities
        : entityDescriptorFiles.length > 0
          ? await new EntityParser({ rootDir: cwd }).parseDirectoryConfigs('entities')
          : [];
    if (entities.length === 0) {
      options.logger.warn(
        'No entity definitions found. Add entities to the project configuration or place YAML/JSON descriptors in entities/.',
      );
    }
    generationProject = { ...project, entities };
  }
  const targetRelative = path.posix.join(project.options.outputDir, project.name);
  const filesystemLogger: FileSystemLogger = {
    log: (action) =>
      options.logger.debug(`[filesystem] ${action.operation} ${action.path}: ${action.status}`),
  };
  const targetFs = new FileSystemService({
    rootDir: cwd,
    logger: filesystemLogger,
    dryRun,
  });
  await targetFs.createDirectory(targetRelative);
  const projectRootFs = new FileSystemService({
    rootDir: path.resolve(cwd, targetRelative),
    logger: filesystemLogger,
    dryRun,
  });
  // Project-level template overrides resolve from the directory the command runs in.
  const engine = new TemplateEngine({ projectRoot: cwd });
  const generatedFiles: GeneratedFileResult[] = [];
  const collect =
    (prefix: string) =>
    (result: GeneratedFileResult): void => {
      generatedFiles.push({ ...result, path: `${prefix}/${result.path}` });
    };

  const backendProject = withProjectSuffix(generationProject, 'backend');
  const backendDirectory = `${kebabCase(project.name)}-backend`;
  await projectRootFs.createDirectory(backendDirectory);
  const backendFs = new FileSystemService({
    rootDir: path.join(projectRootFs.rootDir, backendDirectory),
    logger: filesystemLogger,
    dryRun,
  });
  await renderManifest(
    'spring-boot',
    backendProject,
    templateContext(backendProject),
    engine,
    backendFs,
    filesystemLogger,
    { force, onFile: collect(backendDirectory) },
  );

  const uiDirectory = `${kebabCase(project.name)}-ui`;
  if (project.options.frontend) {
    await projectRootFs.createDirectory(uiDirectory);
    const uiProject = withProjectSuffix(generationProject, 'ui');
    await renderManifest(
      'angular',
      uiProject,
      templateContext(uiProject),
      engine,
      new FileSystemService({
        rootDir: path.join(projectRootFs.rootDir, uiDirectory),
        logger: filesystemLogger,
        dryRun,
      }),
      filesystemLogger,
      { force, onFile: collect(uiDirectory) },
    );
  }

  reportGeneratedFiles(options.logger, generatedFiles, { dryRun, force });
  if (conflictingFiles(generatedFiles).length > 0) {
    throw new CliOptionError(
      `Regeneration stopped because ${conflictingFiles(generatedFiles).length} file(s) contain protected region conflicts. Resolve them and run the command again, or use --force to replace the files completely.`,
    );
  }

  await writeProjectMetadata(projectRootFs, generationProject);

  if (initializeGit && !dryRun) {
    execFileSync('git', ['init'], { cwd: projectRootFs.rootDir, stdio: 'ignore' });
    options.logger.success('Initialized git repository.');
  }
  if (dryRun) {
    options.logger.info(
      `Dry run: ${project.name} was not written to ${path.resolve(cwd, targetRelative)}.`,
    );
    return;
  }

  options.logger.success(`Generated ${project.name} in ${path.resolve(cwd, targetRelative)}.`);
  const nextSteps = [
    `cd ${targetRelative}`,
    ...(project.options.frontend ? [`(cd ${uiDirectory} && npm install && npm start)`] : []),
    ...(project.options.docker
      ? [`(cd ${backendDirectory} && docker compose up --build)`]
      : [
          project.options.buildTool === 'maven'
            ? `(cd ${backendDirectory} && mvn org.springframework.boot:spring-boot-maven-plugin:4.1.2:run -Dspring-boot.run.profiles=dev)`
            : `(cd ${backendDirectory} && gradle bootRun --args='--spring.profiles.active=dev')`,
        ]),
  ];
  options.logger.info(`Next steps:\n  ${nextSteps.join('\n  ')}`);
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
  includeEntities: boolean | undefined;
  force: boolean;
  dryRun: boolean;
  help: boolean;
  configArgs: string[];
} {
  let interactive = false;
  let yes = false;
  let initializeGit = false;
  let includeEntities: boolean | undefined;
  let force = false;
  let dryRun = false;
  let help = false;
  const configArgs: string[] = [];
  for (const arg of args) {
    if (arg === '--interactive') interactive = true;
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--git') initializeGit = true;
    else if (arg === '--entities') includeEntities = true;
    else if (arg === '--no-entities') includeEntities = false;
    else if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') help = true;
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
  return { interactive, yes, initializeGit, includeEntities, force, dryRun, help, configArgs };
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
