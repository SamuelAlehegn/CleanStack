#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger } from '../utils/logger.js';
import { resolveCommand } from './command-router.js';
import { ENTITY_USAGE, runEntityCommand } from './entity.js';
import { runNewCommand } from './new.js';
import { REGENERATE_USAGE, runRegenerateCommand } from './regenerate.js';

interface PackageMetadata {
  version: string;
}

const packageUrl = new URL('../../package.json', import.meta.url);
const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(packageUrl), 'utf8'),
) as PackageMetadata;

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith('-')));
const logger = new Logger({
  verbose: flags.has('--verbose') || flags.has('-v'),
  quiet: flags.has('--quiet') || flags.has('-q'),
});

const usage = `Usage: cleanstack <command> [options]

Commands:
  new <name>               Create a new project skeleton
  entity <name>            Generate an entity in an existing project
  generate entity <name>   Alias for "entity"
  g e <name>               Alias for "entity"
  regenerate               Re-generate the project skeleton (preserving protected regions)
  regenerate entity <name> Re-generate a single entity
  regenerate --all         Re-generate the skeleton and all known entities
  r                        Alias for "regenerate"
  hello                    Print a welcome message

New options:
  --package <name> --db <postgresql|h2|mysql> --auth <jwt|none|keycloak>
  --build <maven|gradle> --frontend <angular|none> --docker
  --entities          Generate entities from the project configuration
  --no-entities       Skip configured entities
  --interactive       Prompt for any missing settings
  -y, --yes           Skip prompts and use defaults for missing settings
  --git               Initialize a git repository in the generated project
  --force             Overwrite generated files completely, including protected regions
  --dry-run           Show what would change without writing files

Entity options:
  -d, --descriptor <path>   Use a specific entity descriptor
  --field <spec>            Inline field: name:type[:required][:maxLength=100]
  --table <name>            Table name for an inline entity
  --package <name>          Override the detected Java package
  --backend / --no-backend  Generate or skip backend artifacts
  --frontend / --no-frontend Generate or skip frontend artifacts
  --force                   Overwrite generated files completely, including protected regions
  --dry-run                 Show what would change without writing files

Regenerate options:
  entity <name>             Target a single entity
  --all                     Regenerate project skeleton and all known entities
  --backend / --no-backend  Regenerate or skip backend artifacts
  --frontend / --no-frontend Regenerate or skip frontend artifacts
  --force                   Overwrite generated files completely, including protected regions
  --dry-run                 Show what would change without writing files

Options:
  -v, --verbose    Show debug output
  -q, --quiet      Suppress non-error output
  -h, --help       Show this help
  -V, --version    Show the version`;

const resolved = resolveCommand(args);
const wantsHelp = flags.has('--help') || flags.has('-h');
const wantsVersion = flags.has('--version') || flags.has('-V');

if (wantsHelp) {
  if (resolved.name === 'entity') {
    logger.info(ENTITY_USAGE);
  } else if (resolved.name === 'regenerate') {
    logger.info(REGENERATE_USAGE);
  } else {
    logger.info(usage);
  }
} else if (wantsVersion) {
  logger.info(packageMetadata.version);
} else if (resolved.name === 'hello') {
  logger.info(`CleanStack Generator v${packageMetadata.version}`);
  logger.success('Welcome to CleanStack!');
  logger.debug(`Running on Node.js ${process.version} (${process.platform})`);
} else if (resolved.name === 'new') {
  runNewCommand(resolved.args, { logger }).catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (resolved.name === 'entity') {
  runEntityCommand(resolved.args, { logger }).catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (resolved.name === 'regenerate') {
  runRegenerateCommand(resolved.args, { logger }).catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
} else if (resolved.name === 'help') {
  logger.info(usage);
} else {
  logger.error(resolved.error ?? `Unknown command "${resolved.unknownCommand ?? ''}".`);
  logger.info(usage);
  process.exitCode = 1;
}
