#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Logger } from '../utils/logger.js';

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

const command = args.find((argument) => !argument.startsWith('-'));

const usage = `Usage: cleanstack <command> [options]

Commands:
  hello            Print a welcome message

Options:
  -v, --verbose    Show debug output
  -q, --quiet      Suppress non-error output
  -h, --help       Show this help
  -V, --version    Show the version`;

if (flags.has('--help') || flags.has('-h')) {
  logger.info(usage);
} else if (flags.has('--version') || flags.has('-V')) {
  logger.info(packageMetadata.version);
} else if (command === 'hello') {
  logger.info(`CleanStack Generator v${packageMetadata.version}`);
  logger.success('Welcome to CleanStack!');
  logger.debug(`Running on Node.js ${process.version} (${process.platform})`);
} else if (command === undefined) {
  logger.info(usage);
} else {
  logger.error(`Unknown command "${command}".`);
  logger.info(usage);
  process.exitCode = 1;
}
