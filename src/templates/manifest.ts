import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildEntityModels, type EntityModel } from '../core/entity-model.js';
import type { ProjectConfig } from '../core/config.js';
import {
  writeGeneratedFile,
  type GeneratedFileResult,
} from '../core/generated-file.js';
import { FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import { stripBom } from '../utils/text.js';
import type { TemplateEngine } from './template-engine.js';

export interface ManifestEntry {
  template: string;
  destination: string;
  when?: Record<string, unknown>;
  forEach?: 'entities';
  /** Marks the generated file as executable on platforms that support it. */
  executable?: boolean;
  /**
   * Templates rendered by a dedicated generator (for example the migration
   * planner) rather than by the manifest itself.
   */
  internal?: boolean;
}

export interface TemplateManifest {
  name?: string;
  description?: string;
  pathVariables?: Record<string, string>;
  files: ManifestEntry[];
}

export interface RenderManifestOptions {
  /** Only render entries accepted by this predicate. */
  filter?: (entry: ManifestEntry) => boolean;
  /** Replace existing files completely, including protected regions. */
  force?: boolean;
  /** Called once per planned file with the merge outcome, in manifest order. */
  onFile?: (result: GeneratedFileResult) => void;
  /**
   * Maximum number of files rendered and written at the same time.
   * Defaults to 8; set to 1 to force sequential writes.
   */
  concurrency?: number;
}

export interface ManifestPlanItem {
  entry: ManifestEntry;
  destination: string;
  context: Record<string, unknown>;
}

/** Converts a project or entity name to kebab-case. */
export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .toLowerCase();
}

/** Appends a backend or ui suffix to a project name. */
export function withProjectSuffix(project: ProjectConfig, suffix: 'backend' | 'ui'): ProjectConfig {
  return { ...project, name: `${kebabCase(project.name)}-${suffix}` };
}

/** Extra names used by project-level templates. */
export function templateAliases(project: ProjectConfig): Record<string, unknown> {
  const words = project.name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const applicationName = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join('');
  return { ApplicationName: applicationName };
}

/** Builds the Handlebars context shared by project and entity templates. */
export function templateContext(
  project: ProjectConfig,
  migrationVersionOverrides?: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const models = buildEntityModels(project.entities);
  const versions = migrationVersions(models);
  const entities = models.map((entity) => ({
    ...entity,
    migrationVersion:
      migrationVersionOverrides?.get(entity.tableName.toLowerCase()) ??
      migrationVersionOverrides?.get(entity.name.toLowerCase()) ??
      versions.get(entity.name.toLowerCase()) ??
      2,
  }));
  return {
    project: { ...project, entities },
    ...project,
    entities,
    ...templateAliases(project),
  } as unknown as Record<string, unknown>;
}

/**
 * Assigns migration numbers so related tables exist before foreign keys and join
 * tables that reference them. Entity order itself is left untouched.
 */
export function migrationVersions(entities: EntityModel[]): Map<string, number> {
  const byKey = new Map(entities.map((entity) => [entity.name.toLowerCase(), entity]));
  const ordered: EntityModel[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (entity: EntityModel): void => {
    const key = entity.name.toLowerCase();
    if (visited.has(key) || visiting.has(key)) return;
    visiting.add(key);
    for (const relation of entity.relations) {
      if (!relation.owningSide || relation.type === 'one-to-many') continue;
      const target = byKey.get(relation.targetEntity.name.toLowerCase());
      if (target && target !== entity) visit(target);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(entity);
  };

  for (const entity of entities) visit(entity);

  return new Map(ordered.map((entity, index) => [entity.name.toLowerCase(), index + 2]));
}

/**
 * Reads a template manifest through the override chain: the project root,
 * the user template directory, and finally the built-in templates. A project
 * or user pack can therefore replace the file list of one template set without
 * copying every built-in template.
 */
export async function readManifest(
  templateSet: string,
  filesystemLogger: FileSystemLogger,
  engine?: TemplateEngine,
): Promise<TemplateManifest> {
  if (engine !== undefined) {
    const { filePath, location } = await engine.resolve(`${templateSet}/manifest.json`);
    const contents = await readFile(filePath, 'utf8');
    return parseTemplateManifest(contents, `${location}: ${filePath}`);
  }

  const fs = new FileSystemService({
    rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates'),
    logger: filesystemLogger,
  });
  const contents = await fs.readFile(`${templateSet}/manifest.json`);
  return parseTemplateManifest(contents, 'built-in manifest');
}

/** Validates the emitted manifest entry list and fails with its source on bad shapes. */
function parseTemplateManifest(contents: string, source: string): TemplateManifest {
  const parsed = JSON.parse(stripBom(contents)) as { files?: unknown };
  if (!Array.isArray(parsed.files)) {
    throw new Error(
      `Template manifest (${source}) must declare a "files" array; received ${typeof parsed.files}.`,
    );
  }
  return parsed as unknown as TemplateManifest;
}

/** Resolves every destination a manifest would write without rendering any templates. */
export async function planManifest(
  templateSet: string,
  project: ProjectConfig,
  context: Record<string, unknown>,
  filesystemLogger: FileSystemLogger,
  filter?: (entry: ManifestEntry) => boolean,
  engine?: TemplateEngine,
): Promise<ManifestPlanItem[]> {
  const manifest = await readManifest(templateSet, filesystemLogger, engine);
  const plan: ManifestPlanItem[] = [];

  for (const entry of manifest.files) {
    if (filter && !filter(entry)) continue;
    if (entry.internal === true) continue;
    if (entry.when && !matchesConditions(project, entry.when)) {
      continue;
    }

    const items = entry.forEach === 'entities' ? (context.entities as unknown[]) : [undefined];
    for (const item of items) {
      const entryContext = item === undefined ? context : { ...context, entity: item };
      plan.push({
        entry,
        destination: resolveDestination(entry.destination, project, context, item),
        context: entryContext,
      });
    }
  }

  return plan;
}

/** Renders a manifest into an output directory and returns the written paths. */
export async function renderManifest(
  templateSet: string,
  project: ProjectConfig,
  context: Record<string, unknown>,
  engine: TemplateEngine,
  output: FileSystemService,
  filesystemLogger: FileSystemLogger,
  options: RenderManifestOptions = {},
): Promise<string[]> {
  const plan = await planManifest(templateSet, project, context, filesystemLogger, options.filter, engine);
  const concurrency = normalizeConcurrency(options.concurrency);
  const written: string[] = [];

  // Create each parent once. mkdir is recursive, so parallel calls are safe.
  if (!output.dryRun) {
    const parents = [
      ...new Set(
        plan
          .map((item) => path.posix.dirname(item.destination))
          .filter((parent) => parent !== '.'),
      ),
    ];
    await forEachConcurrent(parents, concurrency, (parent) => output.createDirectory(parent));
  }

  // Files with distinct destinations are independent. Entries that resolve to
  // the same destination stay ordered and run one at a time, so the last entry
  // still wins exactly as it did with sequential rendering.
  const destinationGroups = new Map<string, Array<{ item: ManifestPlanItem; index: number }>>();
  plan.forEach((item, index) => {
    const existing = destinationGroups.get(item.destination);
    const entry = { item, index };
    if (existing) existing.push(entry);
    else destinationGroups.set(item.destination, [entry]);
  });

  const results: Array<GeneratedFileResult | undefined> = new Array(plan.length);
  await forEachConcurrent(
    [...destinationGroups.values()],
    concurrency,
    async (entries) => {
      for (const { item, index } of entries) {
        const contents = await engine.render(`${templateSet}/${item.entry.template}`, item.context);
        const result = await writeGeneratedFile(output, item.destination, contents, {
          force: options.force ?? false,
          dryRun: output.dryRun,
        });
        results[index] = result;

        if (
          result.status !== 'conflict' &&
          result.status !== 'preserved' &&
          item.entry.executable &&
          !output.dryRun &&
          process.platform !== 'win32'
        ) {
          await output.chmod(item.destination, 0o755);
        }
      }
    },
  );

  // Report in manifest order regardless of completion order so CLI output and
  // the returned file list stay deterministic.
  for (const [index, item] of plan.entries()) {
    const result = results[index];
    if (result === undefined) {
      throw new Error(`No generation result was recorded for "${item.destination}".`);
    }
    options.onFile?.(result);
    if (result.status !== 'conflict' && result.status !== 'preserved') {
      written.push(item.destination);
    }
  }

  return written;
}

const DEFAULT_WRITE_CONCURRENCY = 8;

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WRITE_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}

/**
 * Runs `worker` over `items` with a bounded number of concurrent tasks.
 * Workers stop taking new items after the first failure, then the error is
 * re-thrown once the in-flight tasks settle.
 */
async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failure: unknown;
  const run = async (): Promise<void> => {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]!);
      } catch (error) {
        failure = error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => run()),
  );
  if (failure !== undefined) throw failure;
}

function resolveDestination(
  destination: string,
  project: ProjectConfig,
  context: Record<string, unknown>,
  item: unknown,
): string {
  return destination
    .replaceAll('{{package}}', project.packageName.replaceAll('.', '/'))
    .replaceAll('{{ApplicationName}}', String(context.ApplicationName))
    .replace(/{{entity\.([A-Za-z][A-Za-z0-9]*)}}/g, (_match, key: string) => {
      const entity = item as Record<string, unknown>;
      return String(entity[key] ?? '');
    });
}

function matchesConditions(project: ProjectConfig, when: Record<string, unknown>): boolean {
  return Object.entries(when).every(([key, expected]) => {
    const actual = getCondition(project, key);
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function getCondition(project: ProjectConfig, key: string): unknown {
  return key in project.options
    ? project.options[key as keyof ProjectConfig['options']]
    : (project as unknown as Record<string, unknown>)[key];
}
