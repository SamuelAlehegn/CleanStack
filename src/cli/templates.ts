import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { CliOptionError } from '../core/config-loader.js';
import { readManifest } from '../templates/manifest.js';
import {
  BUILT_IN_TEMPLATE_ROOT,
  getUserHome,
  TemplateEngine,
  type TemplateOverrideLocation,
} from '../templates/template-engine.js';
import { FileExistsError, FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import { isMissingPath } from '../utils/path-safety.js';
import type { Logger } from '../utils/logger.js';

export interface TemplatesCommandOptions {
  cwd?: string;
  logger: Logger;
}

export const TEMPLATES_USAGE = `Usage: cleanstack templates <subcommand> [options]

Manage template overrides. Overrides live in .cleanstack/templates (project)
or ~/.cleanstack/templates (user) and take precedence over built-in templates.

Subcommands:
  list [pack]         List templates and where each one resolves from
  init                Copy built-in templates into .cleanstack/templates
  diff [pack]         Show differences between overrides and built-in
  reset <name>        Remove an override so its template falls back to built-in

Options:
  --force             init: overwrite existing override files
  --dry-run           init/reset: report what would change without writing
  -h, --help          Show this help`;

interface TemplatesCommandArguments {
  subcommand: 'list' | 'init' | 'diff' | 'reset';
  pack?: string;
  name?: string;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

export async function runTemplatesCommand(
  args: string[],
  options: TemplatesCommandOptions,
): Promise<void> {
  const parsed = parseTemplatesCommandArguments(args);
  if (parsed.help) {
    options.logger.info(TEMPLATES_USAGE);
    return;
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (parsed.subcommand === 'list') return listTemplates(parsed, cwd, options);
  if (parsed.subcommand === 'init') return initTemplates(parsed, cwd, options);
  if (parsed.subcommand === 'diff') return diffTemplates(parsed, cwd, options);
  return resetTemplate(parsed, cwd, options);
}

export function parseTemplatesCommandArguments(args: string[]): TemplatesCommandArguments {
  const result: TemplatesCommandArguments = {
    subcommand: 'list',
    force: false,
    dryRun: false,
    help: false,
  };
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

    const [flag, inlineValue] = splitOption(token);
    switch (flag) {
      case '--help':
      case '-h':
        rejectValue(flag, inlineValue);
        result.help = true;
        break;
      case '--verbose':
      case '-v':
      case '--quiet':
      case '-q':
        break;
      case '--force':
        result.force = parseBooleanFlag(flag, inlineValue, true);
        break;
      case '--dry-run':
        result.dryRun = parseBooleanFlag(flag, inlineValue, true);
        break;
      default:
        throw new CliOptionError(`Unknown option "${flag}" for "cleanstack templates".`);
    }
  }

  const first = positionals[0];
  if (first !== undefined && isSubcommand(first)) {
    result.subcommand = first;
  } else if (first !== undefined) {
    throw new CliOptionError(
      `Unknown templates subcommand "${first}". Use list, init, diff, or reset.`,
    );
  }

  const rest = positionals.slice(1);
  if (result.subcommand === 'reset') {
    if (rest.length === 0) {
      throw new CliOptionError('"cleanstack templates reset" requires a template name.');
    }
    result.name = rest[0]!;
    if (rest.length > 1) {
      throw new CliOptionError('"cleanstack templates reset" accepts a single template name.');
    }
    return result;
  }

  if (rest.length > 0) {
    result.pack = rest[0]!;
    if (rest.length > 1) {
      throw new CliOptionError('"cleanstack templates list/diff" accepts a single pack name.');
    }
  }
  return result;
}

function isSubcommand(value: string): value is TemplatesCommandArguments['subcommand'] {
  return value === 'list' || value === 'init' || value === 'diff' || value === 'reset';
}

/** Reports every template of every (or one) pack with its effective override location. */
async function listTemplates(
  parsed: TemplatesCommandArguments,
  cwd: string,
  options: TemplatesCommandOptions,
): Promise<void> {
  const logger = options.logger;
  const engine = new TemplateEngine({ projectRoot: cwd });
  const packs = await selectPacks(engine, parsed.pack);

  const rows: Array<{ pack: string; template: string; destination: string; source: string }> = [];
  const noopLogger: FileSystemLogger = { log: () => {} };
  const overrides = overrideRoots(cwd);

  for (const pack of packs) {
    const manifest = await readManifest(pack, noopLogger, engine);
    const known = new Set<string>();
    for (const entry of manifest.files) {
      const templateName = `${pack}/${entry.template}`;
      const { location } = await engine.resolve(templateName);
      known.add(entry.template);
      rows.push({
        pack,
        template: entry.template,
        destination: entry.destination,
        source: location,
      });
    }

    for (const [level, root] of overrides) {
      for (const relative of await listOverrideFiles(root, pack)) {
        if (!known.has(relative)) {
          rows.push({ pack, template: relative, destination: '-', source: level });
        }
      }
    }

    const manifestLocation = (await engine.resolve(`${pack}/manifest.json`)).location;
    if (manifestLocation !== 'built-in') {
      logger.warn(`${pack}: manifest.json is overridden at the ${manifestLocation} level.`);
    }
  }

  logger.table(
    [
      { key: 'pack', header: 'Pack' },
      { key: 'template', header: 'Template' },
      { key: 'destination', header: 'Destination' },
      { key: 'source', header: 'Source' },
    ],
    rows,
    { emptyMessage: 'No templates found.' },
  );
}

/** Copies every built-in template file into the project override directory. */
async function initTemplates(
  parsed: TemplatesCommandArguments,
  cwd: string,
  options: TemplatesCommandOptions,
): Promise<void> {
  const logger = options.logger;
  const engine = new TemplateEngine({ projectRoot: cwd });
  const packs = await selectPacks(engine, parsed.pack);

  const builtIns = new FileSystemService({
    rootDir: BUILT_IN_TEMPLATE_ROOT,
    logger: { log: () => {} },
  });
  const overrides = new FileSystemService({
    rootDir: path.join(cwd, '.cleanstack', 'templates'),
    logger: { log: () => {} },
    dryRun: parsed.dryRun,
  });
  await overrides.createDirectory('.');

  let copied = 0;
  let skipped = 0;
  for (const pack of packs) {
    for (const relative of await builtIns.listFiles(pack, { recursive: true })) {
      const destination = `${pack}/${relative}`;
      const verb = parsed.dryRun ? 'would copy' : 'copied';
      try {
        const contents = await builtIns.readFile(`${pack}/${relative}`);
        await overrides.createDirectory(path.dirname(`${pack}/${relative}`));
        await overrides.writeFile(destination, contents, { overwrite: parsed.force });
        logger.debug(`${verb} ${destination}`);
        copied += 1;
      } catch (error) {
        if (error instanceof FileExistsError && !parsed.force) {
          logger.debug(`kept existing override ${destination}`);
          skipped += 1;
          continue;
        }
        throw error;
      }
    }
  }

  const scope = packs.length === 1 ? `${packs[0]}` : `${packs.length} packs`;
  if (parsed.dryRun) {
    logger.info(
      `Dry-run: would copy ${copied} template file(s) from ${scope} into .cleanstack/templates.` +
        (skipped > 0
          ? ` ${skipped} existing override file(s) would be kept (use --force to overwrite).`
          : ''),
    );
    return;
  }
  logger.success(
    `Copied ${copied} template file(s) from ${scope} into .cleanstack/templates.` +
      (skipped > 0
        ? ` ${skipped} existing override file(s) were kept (use --force to overwrite).`
        : ''),
  );
}

/** Shows which override files differ from their built-in counterpart, and how. */
async function diffTemplates(
  parsed: TemplatesCommandArguments,
  cwd: string,
  options: TemplatesCommandOptions,
): Promise<void> {
  const logger = options.logger;
  const engine = new TemplateEngine({ projectRoot: cwd });
  const packs = await selectPacks(engine, parsed.pack);
  const overrides = overrideRoots(cwd);

  let changed = 0;
  for (const pack of packs) {
    const effective = new Map<string, TemplateOverrideLocation>();
    const builtInRelative = new Set<string>();
    const builtInReader = new FileSystemService({
      rootDir: BUILT_IN_TEMPLATE_ROOT,
      logger: { log: () => {} },
    });

    const builtInFiles = await listOverrideFiles(BUILT_IN_TEMPLATE_ROOT, pack);
    for (const relative of builtInFiles) builtInRelative.add(relative);

    for (const [level, root] of overrides) {
      for (const relative of await listOverrideFiles(root, pack)) {
        if (!effective.has(relative)) effective.set(relative, level);
      }
    }

    if (effective.size === 0) {
      logger.info(`${pack}: no overrides; every template comes from the built-in set.`);
      continue;
    }

    for (const [relative, level] of [...effective.entries()].sort()) {
      const builtInPath = `${pack}/${relative}`;
      const overridePath = `${pack}/${relative}`;
      const root = overrides.get(level)!;
      const reader = new FileSystemService({ rootDir: root, logger: { log: () => {} } });

      if (!builtInRelative.has(relative)) {
        changed += 1;
        logger.info(`added ${pack}/${relative} (override only, ${level})`);
        continue;
      }

      const builtIn = await builtInReader.readFile(builtInPath);
      const current = await reader.readFile(overridePath);
      if (builtIn === current) {
        logger.debug(`unchanged ${pack}/${relative} (${level})`);
        continue;
      }

      changed += 1;
      logger.info(`modified ${pack}/${relative} (${level})`);
      const ops = diffLines(builtIn, current);
      for (const op of renderDiff(ops)) {
        if (op.kind === 'ctx') logger.debug(`  ${op.text}`);
        else logger.info(`  ${op.kind === 'del' ? '-' : '+'} ${op.text}`);
      }
    }
  }

  if (changed === 0) {
    logger.success('Overrides are identical to the built-in templates.');
  } else {
    logger.info(`${changed} override file(s) differ from the built-in templates.`);
  }
}

/** Removes an override file so its template falls back to the built-in version. */
async function resetTemplate(
  parsed: TemplatesCommandArguments,
  cwd: string,
  options: TemplatesCommandOptions,
): Promise<void> {
  const logger = options.logger;
  const engine = new TemplateEngine({ projectRoot: cwd });
  const name = parsed.name!;
  const relative = normalizeOverrideName(name);
  // A bare name such as "spring-boot/root/README.md" can refer to the .hbs
  // template that renders it, so both spellings are tried.
  const candidates = relative.endsWith('.hbs') ? [relative] : [relative, `${relative}.hbs`];

  for (const [level, root] of overrideRoots(cwd)) {
    const fs = new FileSystemService({ rootDir: root, dryRun: parsed.dryRun });
    for (const candidate of candidates) {
      if (!(await fs.exists(candidate))) continue;
      await fs.delete(candidate, { force: true });
      logger.success(
        `${parsed.dryRun ? 'Would remove' : 'Removed'} ${level} override "${candidate}".` +
          ` "cleanstack templates list" now falls back to the built-in template.`,
      );
      return;
    }
  }

  for (const candidate of candidates) {
    const resolved = await engine.resolve(candidate).catch(() => undefined);
    if (resolved === undefined) continue;
    throw new CliOptionError(
      resolved.location === 'built-in'
        ? `"${name}" uses the built-in template. Nothing to reset; create an override first with "cleanstack templates init".`
        : `"${name}" resolves to a ${resolved.location} override that could not be located on disk.`,
    );
  }

  throw new CliOptionError(
    `No template named "${name}" exists. Run "cleanstack templates list" to see available templates.`,
  );
}

// --- helpers ---

function overrideRoots(cwd: string): Map<TemplateOverrideLocation, string> {
  return new Map<TemplateOverrideLocation, string>([
    ['project', path.join(cwd, '.cleanstack', 'templates')],
    ['user', path.join(getUserHome(), '.cleanstack', 'templates')],
  ]);
}

/** Restricts operations to known packs, or validates a requested pack name. */
async function selectPacks(engine: TemplateEngine, requested?: string): Promise<string[]> {
  const packs = await listPacks(BUILT_IN_TEMPLATE_ROOT);
  if (requested === undefined) return packs;
  if (!packs.includes(requested)) {
    throw new CliOptionError(
      `Unknown template pack "${requested}". Available packs: ${packs.join(', ')}.`,
    );
  }
  return [requested];
}

async function listPacks(builtInRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(builtInRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Recursively lists override files of one pack relative to the pack root. */
async function listOverrideFiles(root: string, pack: string): Promise<string[]> {
  const packRoot = path.join(root, pack);
  const files = await walkFiles(packRoot);
  // Pack-relative names always use forward slashes, matching manifests and
  // template lookups on every platform.
  return files.map((absolute) => path.relative(packRoot, absolute).split(path.sep).join('/'));
}

async function walkFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(entryPath);
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
}

/** Accepts names with or without the template extension and no traversal. */
function normalizeOverrideName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//u, '');
  if (!normalized || normalized.split('/').includes('..') || path.posix.isAbsolute(normalized)) {
    throw new CliOptionError(`Template name must be a relative path: "${name}".`);
  }
  return path.extname(normalized) ? normalized : `${normalized}.hbs`;
}

/**
 * Computes a line-based diff using longest-common-subsequence counts. Template
 * files are small, so the quadratic table is acceptable.
 */
function diffLines(
  builtIn: string,
  current: string,
): Array<{ kind: 'ctx' | 'del' | 'add'; text: string }> {
  const a = builtIn.split('\n');
  const b = current.split('\n');
  const m = a.length;
  const n = b.length;

  // lcs[i][j] = length of the LCS of a.slice(i) and b.slice(j).
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'ctx', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'del', text: a[i++]! });
    } else {
      ops.push({ kind: 'add', text: b[j++]! });
    }
  }
  while (i < m) ops.push({ kind: 'del', text: a[i++]! });
  while (j < n) ops.push({ kind: 'add', text: b[j++]! });
  return ops;
}

/**
 * Renders diff operations with a bordered context of two unchanged lines
 * around each change, collapsing longer unchanged stretches behind a "...",
 * so template diffs stay readable.
 */
function renderDiff(
  ops: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>,
): Array<{ kind: 'ctx' | 'del' | 'add'; text: string }> {
  const CONTEXT = 2;
  const keep = new Set<number>();
  ops.forEach((op, index) => {
    if (op.kind === 'ctx') return;
    for (let offset = -CONTEXT; offset <= CONTEXT; offset += 1) {
      const neighbor = index + offset;
      if (neighbor >= 0 && neighbor < ops.length) keep.add(neighbor);
    }
  });
  if (keep.size === 0) return [];

  const output: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }> = [];
  let collapsed = false;
  for (const [index, op] of ops.entries()) {
    if (keep.has(index)) {
      output.push(op);
      collapsed = false;
    } else if (!collapsed) {
      output.push({ kind: 'ctx', text: '...' });
      collapsed = true;
    }
  }
  return output;
}

function splitOption(token: string): [string, string | undefined] {
  const separator = token.indexOf('=');
  if (separator === -1) return [token, undefined];
  return [token.slice(0, separator), token.slice(separator + 1)];
}

function parseBooleanFlag(flag: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliOptionError(`Option "${flag}" expects "true" or "false", received "${value}".`);
}

function rejectValue(flag: string, value: string | undefined): void {
  if (value !== undefined) {
    throw new CliOptionError(`Option "${flag}" does not accept a value.`);
  }
}
