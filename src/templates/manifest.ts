import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEntityModels, type EntityModel } from '../core/entity-model.js';
import type { ProjectConfig } from '../core/config.js';
import {
  writeGeneratedFile,
  type GeneratedFileResult,
} from '../core/generated-file.js';
import { FileSystemService, type FileSystemLogger } from '../utils/file-system.js';
import type { TemplateEngine } from './template-engine.js';

export interface ManifestEntry {
  template: string;
  destination: string;
  when?: Record<string, unknown>;
  forEach?: 'entities';
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
  /** Called once per planned file with the merge outcome. */
  onFile?: (result: GeneratedFileResult) => void;
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
export function templateContext(project: ProjectConfig): Record<string, unknown> {
  const models = buildEntityModels(project.entities);
  const versions = migrationVersions(models);
  const entities = models.map((entity) => ({
    ...entity,
    migrationVersion: versions.get(entity.name.toLowerCase()) ?? 2,
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

/** Reads a built-in template manifest. */
export async function readManifest(
  templateSet: string,
  filesystemLogger: FileSystemLogger,
): Promise<TemplateManifest> {
  const fs = new FileSystemService({
    rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates'),
    logger: filesystemLogger,
  });
  const contents = await fs.readFile(`${templateSet}/manifest.json`);
  return JSON.parse(contents) as TemplateManifest;
}

/** Resolves every destination a manifest would write without rendering any templates. */
export async function planManifest(
  templateSet: string,
  project: ProjectConfig,
  context: Record<string, unknown>,
  filesystemLogger: FileSystemLogger,
  filter?: (entry: ManifestEntry) => boolean,
): Promise<ManifestPlanItem[]> {
  const manifest = await readManifest(templateSet, filesystemLogger);
  const plan: ManifestPlanItem[] = [];

  for (const entry of manifest.files) {
    if (filter && !filter(entry)) continue;
    if (
      entry.when &&
      !Object.entries(entry.when).every(([key, value]) => getCondition(project, key) === value)
    ) {
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
  const plan = await planManifest(templateSet, project, context, filesystemLogger, options.filter);
  const written: string[] = [];

  for (const item of plan) {
    const contents = await engine.render(`${templateSet}/${item.entry.template}`, item.context);
    const parent = path.posix.dirname(item.destination);
    if (!output.dryRun && parent !== '.') await output.createDirectory(parent);
    const result = await writeGeneratedFile(output, item.destination, contents, {
      force: options.force ?? false,
      dryRun: output.dryRun,
    });
    options.onFile?.(result);
    if (result.status !== 'conflict' && result.status !== 'preserved') {
      written.push(item.destination);
    }
  }

  return written;
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

function getCondition(project: ProjectConfig, key: string): unknown {
  return key in project.options
    ? project.options[key as keyof ProjectConfig['options']]
    : (project as unknown as Record<string, unknown>)[key];
}
