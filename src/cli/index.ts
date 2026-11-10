#!/usr/bin/env node

import { CommanderError } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger } from '../utils/logger.js';
import { createProgram, extractGlobalFlags } from './program.js';

interface PackageMetadata {
  version: string;
}

const packageUrl = new URL('../../package.json', import.meta.url);
const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(packageUrl), 'utf8'),
) as PackageMetadata;

// Global flags configure the logger before Commander parses the command, and
// are accepted before or after the command name.
const { args, verbose, quiet } = extractGlobalFlags(process.argv.slice(2));
const logger = new Logger({ verbose, quiet });

const program = createProgram({
  version: packageMetadata.version,
  logger,
  exitOverride: true,
});

if (args.length === 0) {
  // No command (including when only global flags were passed): show help.
  program.outputHelp();
} else {
  program.parseAsync(args, { from: 'user' }).catch(async (error: unknown) => {
    // Commander has already printed help, version, or the parse error itself.
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    // Loaded on failure only; zod-backed formatting is not needed for --help.
    const { formatError } = await import('../utils/errors.js');
    logger.error(formatError(error), error);
    process.exitCode = 1;
  });
}
