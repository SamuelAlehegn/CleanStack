import path from 'node:path';
import { loadExtensions } from '../core/extensions/loader.js';
import { activeFrontendFrameworks } from '../core/extensions/registry.js';
import { locateGeneratedProject } from '../core/project.js';
import { CleanStackError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

export interface ExtensionsCommandOptions {
  cwd?: string;
  logger: Logger;
}

export const EXTENSIONS_USAGE = `Usage: cleanstack extensions list [options]

List the extensions loaded for this directory and what they contribute.

Extensions are discovered from:
  - the "extensions" list in cleanstack.config.* / .cleanstackrc*
  - .cleanstack/extensions/* in this directory or the generated project
  - extension files or packages named by callers

Subcommands:
  list                List extensions, field types, and frontend frameworks

Options:
  -h, --help          Show this help`;

interface ExtensionsCommandArguments {
  subcommand: 'list';
  help: boolean;
}

export async function runExtensionsCommand(
  args: string[],
  options: ExtensionsCommandOptions,
): Promise<void> {
  const parsed = parseExtensionsCommandArguments(args);
  if (parsed.help) {
    options.logger.info(EXTENSIONS_USAGE);
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRoot = await optionalProjectRoot(cwd);
  const { extensions } = await loadExtensions({
    cwd,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });

  if (extensions.length === 0) {
    options.logger.info('No extensions loaded.');
    options.logger.info(
      'Add extension modules to the "extensions" list in cleanstack.config.ts, ' +
        'or place extension files in .cleanstack/extensions/. See docs/EXTENSIONS.md.',
    );
    return;
  }

  options.logger.table(
    [
      { key: 'name', header: 'Extension' },
      { key: 'source', header: 'Source' },
      { key: 'fieldTypes', header: 'Field types' },
      { key: 'frameworks', header: 'Frameworks' },
    ],
    extensions.map((extension) => ({
      name: extension.name,
      source: extension.source,
      fieldTypes: extension.fieldTypes.join(', ') || '-',
      frameworks: extension.frontendFrameworks.join(', ') || '-',
    })),
    { emptyMessage: 'No extensions loaded.' },
  );

  const frameworks = activeFrontendFrameworks();
  options.logger.info(
    `Frontend frameworks available for generation: ${['angular', ...frameworks.map((framework) => framework.name)].join(', ')}.`,
  );
}

export function parseExtensionsCommandArguments(args: string[]): ExtensionsCommandArguments {
  let help = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (token === '--help' || token === '-h' || token === '--verbose' || token === '-v') {
      help = token === '--help' || token === '-h';
      continue;
    }
    throw new CleanStackError(`Unknown option "${token}" for the extensions command.`, {
      suggestions: ['Run "cleanstack extensions --help" to see the available options.'],
    });
  }

  const unsupported = positionals.filter((positional) => positional !== 'list');
  if (unsupported.length > 0) {
    throw new CleanStackError(`Unknown extensions subcommand "${unsupported[0]}".`, {
      suggestions: ['Run "cleanstack extensions --help" to see the available subcommands.'],
    });
  }

  return { subcommand: 'list', help };
}

/**
 * Loads extensions before a command parses descriptors. Silent when nothing is
 * found, so projects without extensions behave exactly as before.
 */
export async function loadCommandExtensions(options: {
  cwd: string;
  projectRoot?: string;
  logger: Logger;
}): Promise<void> {
  const { extensions } = await loadExtensions({
    cwd: options.cwd,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
  });
  for (const extension of extensions) {
    const contributions = [
      ...(extension.fieldTypes.length > 0
        ? [`field types: ${extension.fieldTypes.join(', ')}`]
        : []),
      ...(extension.frontendFrameworks.length > 0
        ? [`frontend frameworks: ${extension.frontendFrameworks.join(', ')}`]
        : []),
    ];
    options.logger.debug(
      `Loaded extension ${extension.name} (${extension.source})` +
        (contributions.length > 0 ? `: ${contributions.join('; ')}` : ''),
    );
  }
}

async function optionalProjectRoot(cwd: string): Promise<string | undefined> {
  try {
    const project = await locateGeneratedProject({ cwd });
    return project.rootDir;
  } catch {
    return undefined;
  }
}
