import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ZodError } from 'zod';
import { CliOptionError, ConfigLoader, resolveConfigFile } from '../core/config-loader.js';
import { formatZodError } from '../core/entity-parser.js';
import { locateGeneratedProject } from '../core/project.js';
import { BUILT_IN_TEMPLATE_ROOT } from '../templates/template-engine.js';
import type { Logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const MIN_NODE_MAJOR = 22;
const MIN_JAVA_MAJOR = 21;

export const DOCTOR_USAGE = `Usage: cleanstack doctor

Check the environment for problems that prevent generated projects from
building or running.

Checks:
  Node.js, Java, Maven or Gradle, Git, configuration, and built-in templates

Options:
  -h, --help Show this help`;

export type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
  suggestions?: string[];
}

export interface DoctorReport {
  checks: DoctorCheck[];
  passed: number;
  warnings: number;
  failures: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Runs an external command. Injected in tests so the doctor never depends on the host. */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface DoctorCheckOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  commandRunner?: CommandRunner;
  nodeVersion?: string;
  templateRoot?: string;
}

export interface DoctorCommandOptions extends DoctorCheckOptions {
  logger: Logger;
  /** Overridden in tests; defaults to setting process.exitCode. */
  setExitCode?: (code: number) => void;
}

const defaultRunner: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

export async function runDoctorCommand(
  args: string[],
  options: DoctorCommandOptions,
): Promise<void> {
  const parsed = parseDoctorArguments(args);
  if (parsed.help) {
    options.logger.info(DOCTOR_USAGE);
    return;
  }

  const report = await collectDoctorReport(options);
  printReport(options.logger, report);

  if (report.failures > 0) {
    const setExitCode =
      options.setExitCode ??
      ((code: number) => {
        process.exitCode = code;
      });
    setExitCode(1);
  }
}

/** Collects every environment check without writing output. */
export async function collectDoctorReport(options: DoctorCheckOptions = {}): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.commandRunner ?? defaultRunner;

  const checks = await Promise.all([
    checkNode(options.nodeVersion ?? process.versions.node),
    checkJava(runner),
    checkBuildTool(cwd, runner),
    checkGit(runner),
    checkConfiguration(cwd, env),
    checkTemplates(options.templateRoot ?? BUILT_IN_TEMPLATE_ROOT),
  ]);

  return {
    checks,
    passed: checks.filter((check) => check.status === 'ok').length,
    warnings: checks.filter((check) => check.status === 'warn').length,
    failures: checks.filter((check) => check.status === 'fail').length,
  };
}

/**
 * Accepts only help flags. Doctor takes no inputs, so unknown options get a
 * targeted hint instead of being silently ignored.
 */
export function parseDoctorArguments(args: string[]): { help: boolean } {
  let help = false;
  for (const token of args) {
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--verbose' || token === '-v' || token === '--quiet' || token === '-q') {
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliOptionError(`Unknown option "${token}" for "cleanstack doctor".`, [
        'Run "cleanstack doctor --help" to see what this command checks.',
      ]);
    }
    throw new CliOptionError(
      `"cleanstack doctor" does not accept arguments (received "${token}").`,
      ['Run "cleanstack doctor" without arguments.'],
    );
  }
  return { help };
}

function checkNode(version: string): DoctorCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major)) {
    return {
      name: 'Node.js',
      status: 'warn',
      detail: `Node.js version "${version}" could not be parsed.`,
      suggestions: ['Run "node --version" and check that Node.js is on PATH.'],
    };
  }
  if (major >= MIN_NODE_MAJOR) {
    return { name: 'Node.js', status: 'ok', detail: `Node.js ${version}` };
  }
  return {
    name: 'Node.js',
    status: 'fail',
    detail: `Node.js ${version} is too old; CleanStack requires ${MIN_NODE_MAJOR}+.`,
    suggestions: [
      `Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org.`,
      'With nvm: "nvm install 22 && nvm use 22".',
    ],
  };
}

async function checkJava(runner: CommandRunner): Promise<DoctorCheck> {
  try {
    const result = await runner('java', ['-version']);
    const output = `${result.stderr}\n${result.stdout}`.trim();
    const major = parseJavaMajor(output);
    if (major === undefined) {
      return {
        name: 'Java',
        status: 'warn',
        detail: 'Java is installed, but its version could not be parsed.',
        suggestions: ['Run "java -version" manually and check that Java is on PATH.'],
      };
    }
    if (major >= MIN_JAVA_MAJOR) {
      return { name: 'Java', status: 'ok', detail: `Java ${major}` };
    }
    return {
      name: 'Java',
      status: major < 17 ? 'fail' : 'warn',
      detail: `Java ${major} found; generated projects target Java ${MIN_JAVA_MAJOR}+.`,
      suggestions: [
        `Install JDK ${MIN_JAVA_MAJOR} or newer (for example Eclipse Temurin or Microsoft OpenJDK).`,
        'Set JAVA_HOME to the JDK installation and add its bin directory to PATH.',
        'Run "java -version" to verify the active JDK.',
      ],
    };
  } catch {
    return {
      name: 'Java',
      status: 'warn',
      detail: 'Java was not found on PATH.',
      suggestions: [
        `Install JDK ${MIN_JAVA_MAJOR} or newer to build the generated backend.`,
        'Set JAVA_HOME and add its bin directory to PATH, then open a new terminal.',
      ],
    };
  }
}

async function checkBuildTool(cwd: string, runner: CommandRunner): Promise<DoctorCheck> {
  const expected = await expectedBuildTool(cwd);
  const tools: Array<'maven' | 'gradle'> = expected ? [expected] : ['maven', 'gradle'];

  for (const tool of tools) {
    const probe = await probeBuildTool(tool, runner);
    if (probe.available) {
      const version = probe.version === undefined ? '' : ` ${probe.version}`;
      return { name: 'Build tool', status: 'ok', detail: `${labelFor(tool)}${version}` };
    }
  }

  if (expected !== undefined) {
    return {
      name: 'Build tool',
      status: 'warn',
      detail: `${labelFor(expected)} was not found, but this project uses ${expected}.`,
      suggestions: [
        `Install ${labelFor(expected)} or use a machine that has it.`,
        `Alternatively regenerate with --build ${expected === 'maven' ? 'gradle' : 'maven'}.`,
      ],
    };
  }

  return {
    name: 'Build tool',
    status: 'warn',
    detail: 'Neither Maven nor Gradle was found on PATH.',
    suggestions: [
      'Install Maven 3.9+ or Gradle 8+, depending on the project you generate.',
      'Pass --build maven or --build gradle to "cleanstack new" to choose explicitly.',
    ],
  };
}

async function probeBuildTool(
  tool: 'maven' | 'gradle',
  runner: CommandRunner,
): Promise<{ available: boolean; version?: string }> {
  try {
    const result =
      tool === 'maven' ? await runner('mvn', ['-version']) : await runner('gradle', ['--version']);
    const output = `${result.stdout}\n${result.stderr}`;
    const version =
      tool === 'maven'
        ? /Apache Maven\s+([^\s]+)/.exec(output)?.[1]
        : /Gradle\s+([^\s]+)/.exec(output)?.[1];
    return version === undefined ? { available: true } : { available: true, version };
  } catch {
    return { available: false };
  }
}

async function checkGit(runner: CommandRunner): Promise<DoctorCheck> {
  try {
    const result = await runner('git', ['--version']);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = /git version\s+([^\s]+)/i.exec(output)?.[1];
    return {
      name: 'Git',
      status: 'ok',
      detail: version === undefined ? 'Git is installed' : `Git ${version}`,
    };
  } catch {
    return {
      name: 'Git',
      status: 'warn',
      detail: 'Git was not found on PATH.',
      suggestions: [
        'Install Git from https://git-scm.com.',
        'Generation still works; only "cleanstack new --git" needs Git.',
      ],
    };
  }
}

async function checkConfiguration(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<DoctorCheck> {
  let configPath: string | undefined;
  try {
    configPath = await resolveConfigFile(cwd, env.CLEANSTACK_CONFIG);
  } catch (error) {
    return {
      name: 'Configuration',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      suggestions: ['Check the path in CLEANSTACK_CONFIG.'],
    };
  }

  if (configPath === undefined) {
    return {
      name: 'Configuration',
      status: 'info',
      detail: 'No configuration file found; built-in defaults will be used.',
      suggestions: ['Create .cleanstackrc.yml in this directory to share defaults with your team.'],
    };
  }

  try {
    await new ConfigLoader().loadDefaults({ cwd, configPath, env });
    return { name: 'Configuration', status: 'ok', detail: configPath };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        name: 'Configuration',
        status: 'fail',
        detail: `Invalid configuration in ${configPath}:\n${formatZodError(error)}`,
        suggestions: [
          'Run "cleanstack config validate" for the same report.',
          'Fix the highlighted fields and run doctor again.',
        ],
      };
    }
    return {
      name: 'Configuration',
      status: 'fail',
      detail: `Could not read configuration: ${configPath}\n${
        error instanceof Error ? error.message : String(error)
      }`,
      suggestions: ['Check that the file is valid YAML, JSON, or TypeScript.'],
    };
  }
}

async function checkTemplates(templateRoot: string): Promise<DoctorCheck> {
  try {
    if (!(await stat(templateRoot)).isDirectory()) {
      throw new Error('template root is not a directory');
    }
    for (const pack of ['spring-boot', 'angular']) {
      const manifest = path.join(templateRoot, pack, 'manifest.json');
      if (!(await stat(manifest)).isFile()) {
        throw new Error(`missing ${pack}/manifest.json`);
      }
    }
    return {
      name: 'Templates',
      status: 'ok',
      detail: `Built-in templates: ${templateRoot}`,
    };
  } catch {
    return {
      name: 'Templates',
      status: 'fail',
      detail: `Built-in templates are missing or incomplete: ${templateRoot}`,
      suggestions: [
        'Reinstall CleanStack (for example "npm install -g cleanstack-generator").',
        'If running from source, run "npm run build" and try again.',
      ],
    };
  }
}

async function expectedBuildTool(cwd: string): Promise<'maven' | 'gradle' | undefined> {
  try {
    const project = await locateGeneratedProject({ cwd });
    return project.backend?.buildTool;
  } catch {
    return undefined;
  }
}

function parseJavaMajor(output: string): number | undefined {
  const main = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (main === null) return undefined;
  const major = Number(main[1]);
  if (major === 1 && main[2] !== undefined) {
    // Legacy version strings such as "1.8.0_402".
    return Number(main[2]);
  }
  return major;
}

function labelFor(tool: 'maven' | 'gradle'): string {
  return tool === 'maven' ? 'Maven' : 'Gradle';
}

function printReport(logger: Logger, report: DoctorReport): void {
  logger.info('CleanStack doctor');
  logger.info('');
  for (const check of report.checks) {
    const [first, ...rest] = check.detail.split('\n');
    logger.info(`${iconFor(check.status)} ${check.name}: ${first ?? ''}`);
    for (const line of rest) logger.info(`   ${line}`);
    for (const suggestion of check.suggestions ?? []) {
      logger.info(`   Hint: ${suggestion}`);
    }
  }

  logger.info('');
  const summary = [`${report.passed} passed`];
  if (report.warnings > 0) {
    summary.push(`${report.warnings} warning${report.warnings === 1 ? '' : 's'}`);
  }
  if (report.failures > 0) {
    summary.push(`${report.failures} failed`);
  }
  logger.info(`${summary.join(', ')}.`);

  if (report.failures > 0) {
    logger.info('Fix the failed checks, then run "cleanstack doctor" again.');
  } else if (report.warnings > 0) {
    logger.info(
      'Warnings do not block generation, but may prevent the generated project from building.',
    );
  } else {
    logger.info('Everything looks good.');
  }
}

function iconFor(status: DoctorCheckStatus): string {
  switch (status) {
    case 'ok':
      return '✔';
    case 'warn':
      return '⚠';
    case 'fail':
      return '✖';
    case 'info':
      return 'ℹ';
  }
}
