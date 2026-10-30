#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageMetadata {
  version: string;
}

const packageUrl = new URL('../../package.json', import.meta.url);
const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(packageUrl), 'utf8'),
) as PackageMetadata;

const [command] = process.argv.slice(2);

if (command === 'hello') {
  console.log(`CleanStack Generator v${packageMetadata.version}`);
  console.log('Welcome to CleanStack!');
} else {
  console.log('CleanStack Generator');
  console.log('Usage: cleanstack hello');
}
