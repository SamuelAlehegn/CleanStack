import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EntityConfig, GenerationOptions, ProjectConfig } from './config.js';
import {
  buildEntityModels,
  type EntityFieldModel,
  type EntityModel,
  type ResolvedRelationModel,
} from './entity-model.js';
import { writeGeneratedFile, type GeneratedFileResult } from './generated-file.js';
import {
  type SqlDatabase,
  withSqlMetadata,
  sqlMetadataForField,
  sqlStringLiteral,
  sqlTypeForField,
  xmlEscape,
} from './sql-types.js';
import type { ManifestEntry } from '../templates/manifest.js';
import { templateAliases } from '../templates/manifest.js';
import type { TemplateEngine } from '../templates/template-engine.js';
import type { FileSystemService } from '../utils/file-system.js';

export type MigrationTool = GenerationOptions['migrationTool'];

export const FLYWAY_MIGRATION_DIRECTORY = 'src/main/resources/db/migration';
export const LIQUIBASE_CHANGELOG_DIRECTORY = 'src/main/resources/db/changelog';
export const LIQUIBASE_CHANGES_DIRECTORY = `${LIQUIBASE_CHANGELOG_DIRECTORY}/changes`;

export type MigrationAction = 'create' | 'update' | 'seed';

export interface MigrationChange {
  kind: string;
  /** Short filename-friendly label, for example `add_sku`. */
  label: string;
  /** Human-readable summary used in migration comments. */
  description: string;
  /** Flyway SQL statements for the configured database. */
  statements: string[];
  /** Native Liquibase changes, already rendered as XML and indented for a changeSet. */
  liquibase: string;
}

export interface SeedColumnModel {
  name: string;
  /** SQL literal or expression used by Flyway. */
  sql: string;
  /** Liquibase `<column>` attributes, for example `value="Demo"`. */
  attribute: string;
}

export interface SeedRowModel {
  columns: SeedColumnModel[];
  sql: string;
  liquibase: string;
}

export interface MigrationModel {
  action: MigrationAction;
  version: number;
  description: string;
  fileName: string;
  changesetId: string;
  author: string;
  changes: MigrationChange[];
  seedStatements: string[];
  liquibaseSeed: string;
  seedRows: SeedRowModel[];
  /** False when a requested seed could not be generated safely. */
  hasSeedData: boolean;
}

export interface GenerateEntityMigrationsOptions {
  fileSystem: FileSystemService;
  engine: TemplateEngine;
  project: ProjectConfig;
  entity: EntityModel;
  /** Entity as it was stored before the descriptor changed. */
  previousEntity?: EntityModel | undefined;
  /**
   * Overrides the seed decision for this invocation. `--seed` forces sample
   * data and `--no-seed` suppresses it even when the descriptor opts in.
   */
  seed?: boolean | undefined;
  logger?: { warn(message: string): void };
}

/**
 * Returns the directory that stores migrations for a tool, relative to the
 * backend project root.
 */
export function migrationDirectory(tool: MigrationTool): string {
  return tool === 'liquibase' ? LIQUIBASE_CHANGES_DIRECTORY : FLYWAY_MIGRATION_DIRECTORY;
}

/** True for manifest entries that are render-managed by the migration planner. */
export function isGeneratedEntityMigrationEntry(entry: ManifestEntry): boolean {
  return (
    entry.forEach === 'entities' &&
    (entry.destination.includes('/db/migration/') ||
      entry.destination.includes('/db/changelog/changes/'))
  );
}

/** Orders entities so referenced tables exist before foreign keys are added. */
export function orderEntitiesForMigrations(entities: EntityConfig[]): EntityModel[] {
  const models = buildEntityModels(entities);
  const byKey = new Map(models.map((entity) => [entity.name.toLowerCase(), entity]));
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

  for (const entity of models) visit(entity);
  return ordered;
}

/** Returns the highest integer version currently on disk for a tool. */
export async function highestMigrationVersion(
  fileSystem: FileSystemService,
  tool: MigrationTool,
): Promise<number> {
  const directory = migrationDirectory(tool);
  if (!(await fileSystem.exists(directory))) return 1;

  const files = await fileSystem.listFiles(directory, { recursive: false });
  let maximum = 1;
  for (const file of files) {
    const match = /^V([0-9][0-9._]*)__/.exec(path.posix.basename(file));
    if (!match) continue;
    maximum = Math.max(maximum, migrationVersionNumber(match[1]!));
  }
  return maximum;
}

/** Allocates the next sequential migration version, starting after V1. */
export async function nextMigrationVersion(
  fileSystem: FileSystemService,
  tool: MigrationTool,
): Promise<number> {
  return (await highestMigrationVersion(fileSystem, tool)) + 1;
}

function migrationVersionNumber(raw: string): number {
  const [whole] = raw.split('.');
  const parsed = Number.parseInt(whole ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

interface ExistingMigration {
  fileName: string;
  version: number;
}

/** Finds the migration that created a table, regardless of the current file name. */
export async function findCreateMigration(
  fileSystem: FileSystemService,
  tool: MigrationTool,
  tableName: string,
): Promise<ExistingMigration | undefined> {
  const direct = await findNamedMigration(fileSystem, tool, 'create', tableName);
  if (direct !== undefined) return direct;

  // A renamed table no longer matches its original file name. Trace renames
  // back to the table name used when it was created so repeated runs do not
  // emit a second create migration.
  const original = await resolveRenamedTable(fileSystem, tool, tableName);
  return original === undefined
    ? undefined
    : findNamedMigration(fileSystem, tool, 'create', original);
}

/** Finds an existing seed migration for a table. */
export async function findSeedMigration(
  fileSystem: FileSystemService,
  tool: MigrationTool,
  tableName: string,
): Promise<ExistingMigration | undefined> {
  const direct = await findNamedMigration(fileSystem, tool, 'seed', tableName);
  if (direct !== undefined) return direct;
  const original = await resolveRenamedTable(fileSystem, tool, tableName);
  return original === undefined
    ? undefined
    : findNamedMigration(fileSystem, tool, 'seed', original);
}

async function findNamedMigration(
  fileSystem: FileSystemService,
  tool: MigrationTool,
  action: 'create' | 'seed',
  tableName: string,
): Promise<ExistingMigration | undefined> {
  const directory = migrationDirectory(tool);
  if (!(await fileSystem.exists(directory))) return undefined;
  const extension = tool === 'liquibase' ? 'xml' : 'sql';
  const suffix = action === 'create' ? '(?:_table)?' : '';
  const pattern = new RegExp(
    `^V([0-9][0-9._]*)__${action}_${escapeRegExp(tableName)}${suffix}\\.${extension}$`,
  );

  const files = await fileSystem.listFiles(directory, { recursive: false });
  for (const file of files) {
    const fileName = path.posix.basename(file);
    const match = pattern.exec(fileName);
    if (match) return { fileName, version: migrationVersionNumber(match[1]!) };
  }
  return undefined;
}

/**
 * Resolves the name a table had before any generated rename migrations.
 * Renames are read from update migrations, not file names, so user-edited
 * migration names cannot break the lookup.
 */
async function resolveRenamedTable(
  fileSystem: FileSystemService,
  tool: MigrationTool,
  tableName: string,
): Promise<string | undefined> {
  const directory = migrationDirectory(tool);
  if (!(await fileSystem.exists(directory))) return undefined;
  const extension = tool === 'liquibase' ? 'xml' : 'sql';
  const updatePattern = new RegExp(`^V[0-9][0-9._]*__update_.+\\.${extension}$`);
  const files = (await fileSystem.listFiles(directory, { recursive: false })).filter((file) =>
    updatePattern.test(path.posix.basename(file)),
  );
  if (files.length === 0) return undefined;

  const renames = new Map<string, string>();
  for (const file of files) {
    const contents = await fileSystem.readFile(path.posix.join(directory, file));
    for (const [previousName, nextName] of renamePairs(contents, tool)) {
      renames.set(nextName.toLowerCase(), previousName);
    }
  }

  let current = tableName;
  const visited = new Set<string>();
  while (!visited.has(current.toLowerCase())) {
    visited.add(current.toLowerCase());
    const previous = renames.get(current.toLowerCase());
    if (previous === undefined) break;
    current = previous;
  }
  return current === tableName ? undefined : current;
}

function renamePairs(contents: string, tool: MigrationTool): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const pattern =
    tool === 'liquibase'
      ? /<renameTable\b[^>]*\boldTableName="([^"]+)"[^>]*\bnewTableName="([^"]+)"/g
      : /ALTER\s+TABLE\s+([^\s;]+)\s+RENAME\s+TO\s+([^\s;]+)\s*;/gi;
  for (const match of contents.matchAll(pattern)) {
    pairs.push([match[1]!, match[2]!]);
  }
  return pairs;
}

/** Builds the stored version of an entity so descriptor changes can be diffed. */
export function findPreviousEntityModel(
  entities: EntityConfig[],
  next: EntityModel,
): EntityModel | undefined {
  const previous = entities.find((entity) => entity.name.toLowerCase() === next.name.toLowerCase());
  if (previous === undefined) return undefined;

  const byName = new Map(entities.map((entity) => [entity.name.toLowerCase(), entity]));
  byName.set(previous.name.toLowerCase(), previous);

  // Relations can point at entities that are not stored yet. Add lightweight
  // placeholders so the previous model can still be resolved for diffing.
  const targetTables = new Map(
    next.relations.map((relation) => [
      relation.targetEntity.name.toLowerCase(),
      relation.targetEntity.tableName,
    ]),
  );
  for (const relation of previous.relations) {
    const key = relation.target.toLowerCase();
    if (byName.has(key)) continue;
    const tableName = targetTables.get(key);
    byName.set(key, {
      name: relation.target,
      fields: [],
      relations: [],
      seed: false,
      seedData: [],
      ...(tableName === undefined ? {} : { tableName }),
    });
  }

  try {
    return buildEntityModels([...byName.values()]).find(
      (entity) => entity.name.toLowerCase() === next.name.toLowerCase(),
    );
  } catch {
    return undefined;
  }
}

/** Builds and writes any create, update, and seed migrations for one entity. */
export async function generateEntityMigrations(
  options: GenerateEntityMigrationsOptions,
): Promise<GeneratedFileResult[]> {
  const { fileSystem, engine, project, entity } = options;
  const tool = project.options.migrationTool;
  const database = project.options.database;
  const directory = migrationDirectory(tool);
  if (!(await fileSystem.exists(directory)) && !fileSystem.dryRun) {
    await fileSystem.createDirectory(directory);
  }

  let nextVersion = await nextMigrationVersion(fileSystem, tool);
  const allocateVersion = (): number => {
    const version = nextVersion;
    nextVersion += 1;
    return version;
  };

  const results: GeneratedFileResult[] = [];
  const create =
    (await findCreateMigration(fileSystem, tool, entity.tableName)) ??
    (options.previousEntity === undefined
      ? undefined
      : await findCreateMigration(fileSystem, tool, options.previousEntity.tableName));

  if (create === undefined) {
    const version = allocateVersion();
    results.push(
      await writeEntityMigration({
        action: 'create',
        version,
        project,
        entity,
        changes: [],
        engine,
        fileSystem,
      }),
    );
  } else if (options.previousEntity !== undefined) {
    const changes = diffEntityModels(options.previousEntity, entity, database);
    if (changes.length > 0) {
      const version = allocateVersion();
      results.push(
        await writeEntityMigration({
          action: 'update',
          version,
          project,
          entity,
          changes,
          engine,
          fileSystem,
        }),
      );
    }
  }

  const seedRequested =
    options.seed ?? (entity.seed || entity.seedData.length > 0 || project.options.seed);
  const existingSeed = await findSeedMigration(fileSystem, tool, entity.tableName);
  if (seedRequested && existingSeed === undefined) {
    const seedRows = buildSeedRows(entity, project.options.seed, options.logger).filter(
      (row) => row.columns.length > 0,
    );
    if (seedRows.length > 0) {
      const version = allocateVersion();
      results.push(
        await writeEntityMigration({
          action: 'seed',
          version,
          project,
          entity,
          changes: [],
          seedRows,
          engine,
          fileSystem,
        }),
      );
    }
  }

  return results;
}

interface WriteEntityMigrationOptions {
  action: MigrationAction;
  version: number;
  project: ProjectConfig;
  entity: EntityModel;
  changes: MigrationChange[];
  seedRows?: SeedRowModel[] | undefined;
  engine: TemplateEngine;
  fileSystem: FileSystemService;
}

async function writeEntityMigration(
  options: WriteEntityMigrationOptions,
): Promise<GeneratedFileResult> {
  const { action, version, project, entity, changes, engine, fileSystem } = options;
  const seedRows = options.seedRows ?? [];
  const description = migrationDescription(action, entity, changes);
  const fileName = migrationFileName(
    action,
    version,
    entity,
    changes,
    project.options.migrationTool,
  );
  const relativePath = path.posix.join(migrationDirectory(project.options.migrationTool), fileName);
  const migration: MigrationModel = {
    action,
    version,
    description,
    fileName,
    changesetId: changesetId(action, version, entity),
    author: 'cleanstack',
    changes,
    seedStatements: seedRows.map((row) => row.sql),
    liquibaseSeed: seedRows.map((row) => row.liquibase).join('\n'),
    seedRows,
    hasSeedData: seedRows.length > 0,
  };
  const sqlEntity = withSqlMetadata(entity, project.options.database);
  const context = {
    project: { ...project, entities: [sqlEntity] },
    ...project,
    entities: [sqlEntity],
    entity: sqlEntity,
    ...templateAliases(project),
    migration,
  } as unknown as Record<string, unknown>;
  const template =
    project.options.migrationTool === 'liquibase'
      ? `resources/db/changelog/changes/${migrationTemplateName(action)}.xml.hbs`
      : `resources/db/migration/${migrationTemplateName(action)}.sql.hbs`;
  const contents = await engine.render(`spring-boot/${template}`, context);
  return writeGeneratedFile(fileSystem, relativePath, contents, {
    dryRun: fileSystem.dryRun,
  });
}

function migrationTemplateName(action: MigrationAction): string {
  switch (action) {
    case 'create':
      return 'CreateTable';
    case 'update':
      return 'UpdateTable';
    case 'seed':
      return 'SeedData';
  }
}

function migrationFileName(
  action: MigrationAction,
  version: number,
  entity: EntityModel,
  changes: MigrationChange[],
  tool: MigrationTool,
): string {
  const extension = tool === 'liquibase' ? 'xml' : 'sql';
  const description =
    action === 'create'
      ? `create_${entity.tableName}_table`
      : action === 'update'
        ? `update_${entity.tableName}_${describeChangeSlug(changes)}`
        : `seed_${entity.tableName}`;
  return `V${version}__${description}.${extension}`;
}

function migrationDescription(
  action: MigrationAction,
  entity: EntityModel,
  changes: MigrationChange[],
): string {
  if (action === 'create') return `Create table ${entity.tableName} for ${entity.className}.`;
  if (action === 'seed') return `Seed data for ${entity.tableName}.`;
  return `Update table ${entity.tableName}: ${changes.map((change) => change.description).join('; ')}.`;
}

function changesetId(action: MigrationAction, version: number, entity: EntityModel): string {
  return `${version}-${action}-${entity.tableName.replaceAll('_', '-')}`;
}

function describeChangeSlug(changes: MigrationChange[]): string {
  const labels = [...new Set(changes.map((change) => change.label))].filter(Boolean);
  const joined = labels.join('_');
  if (joined.length <= 80) return joined;
  const shortened = joined.slice(0, 72).replace(/_+$/, '');
  return `${shortened}_more`;
}

/** Compares two normalized entity models and turns schema differences into migrations. */
export function diffEntityModels(
  previous: EntityModel,
  next: EntityModel,
  database: SqlDatabase,
): MigrationChange[] {
  const changes: MigrationChange[] = [];
  if (previous.tableName !== next.tableName) {
    changes.push(renameTableChange(previous.tableName, next.tableName));
  }

  const previousFields = new Map(previous.fields.map((field) => [field.name, field]));
  const nextFields = new Map(next.fields.map((field) => [field.name, field]));
  for (const field of next.fields) {
    const before = previousFields.get(field.name);
    if (before === undefined) {
      changes.push(addColumnChange(next.tableName, field, database));
      continue;
    }
    const change = modifyColumnChange(next.tableName, before, field, database);
    if (change !== undefined) changes.push(change);
  }
  for (const field of previous.fields) {
    if (!nextFields.has(field.name)) {
      changes.push(dropColumnChange(next.tableName, field));
    }
  }

  const previousSingles = new Map(
    previous.owningRelations
      .filter((relation) => !relation.collection)
      .map((relation) => [relation.field, relation]),
  );
  const nextSingles = new Map(
    next.owningRelations
      .filter((relation) => !relation.collection)
      .map((relation) => [relation.field, relation]),
  );
  for (const relation of next.owningRelations) {
    if (relation.collection) continue;
    const before = previousSingles.get(relation.field);
    if (before === undefined) {
      changes.push(addForeignKeyChange(next.tableName, relation, database));
      continue;
    }
    const change = modifyRelationColumnChange(next.tableName, before, relation, database);
    if (change !== undefined) changes.push(change);
  }
  for (const relation of previous.owningRelations) {
    if (relation.collection) continue;
    if (!nextSingles.has(relation.field)) {
      changes.push(dropForeignKeyChange(next.tableName, relation, database));
    }
  }

  const previousJoinTables = new Map(
    previous.owningRelations
      .filter((relation) => relation.type === 'many-to-many')
      .map((relation) => [relation.joinTableName, relation]),
  );
  const nextJoinTables = new Map(
    next.owningRelations
      .filter((relation) => relation.type === 'many-to-many')
      .map((relation) => [relation.joinTableName, relation]),
  );
  for (const relation of next.owningRelations) {
    if (relation.type !== 'many-to-many') continue;
    if (!previousJoinTables.has(relation.joinTableName)) {
      changes.push(createJoinTableChange(next.tableName, relation, database));
    }
  }
  for (const relation of previous.owningRelations) {
    if (relation.type !== 'many-to-many') continue;
    if (!nextJoinTables.has(relation.joinTableName)) {
      changes.push(dropJoinTableChange(next.tableName, relation));
    }
  }

  return changes;
}

function renameTableChange(previousName: string, tableName: string): MigrationChange {
  return {
    kind: 'rename-table',
    label: `rename_${previousName}_to_${tableName}`,
    description: `Rename table ${previousName} to ${tableName}`,
    statements: [`ALTER TABLE ${previousName} RENAME TO ${tableName};`],
    liquibase: `        <renameTable oldTableName="${xmlEscape(previousName)}" newTableName="${xmlEscape(tableName)}"/>`,
  };
}

function addColumnChange(
  tableName: string,
  field: EntityFieldModel,
  database: SqlDatabase,
): MigrationChange {
  const metadata = sqlMetadataForField(field, database);
  const definition = columnDefinition(metadata.sqlType, metadata.defaultSql, field.required, false);
  const statements = [`ALTER TABLE ${tableName} ADD COLUMN ${field.columnName} ${definition};`];
  if (field.unique) {
    statements.push(
      `ALTER TABLE ${tableName} ADD CONSTRAINT ${uniqueConstraintName(tableName, field.columnName)} UNIQUE (${field.columnName});`,
    );
  }
  return {
    kind: 'add-column',
    label: `add_${field.columnName}`,
    description: `Add column ${field.columnName}`,
    statements,
    liquibase: liquibaseAddColumn(
      tableName,
      field.columnName,
      metadata.sqlType,
      metadata.liquibaseDefault,
      field.required,
      field.unique,
    ),
  };
}

function dropColumnChange(tableName: string, field: EntityFieldModel): MigrationChange {
  return {
    kind: 'drop-column',
    label: `drop_${field.columnName}`,
    description: `Drop column ${field.columnName}`,
    statements: [`ALTER TABLE ${tableName} DROP COLUMN ${field.columnName};`],
    liquibase: `        <dropColumn tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(field.columnName)}"/>`,
  };
}

function modifyColumnChange(
  tableName: string,
  previous: EntityFieldModel,
  next: EntityFieldModel,
  database: SqlDatabase,
): MigrationChange | undefined {
  const previousMetadata = sqlMetadataForField(previous, database);
  const nextMetadata = sqlMetadataForField(next, database);
  const changes: string[] = [];
  const statements: string[] = [];
  const liquibase: string[] = [];

  const typeChanged = previousMetadata.sqlType !== nextMetadata.sqlType;
  const requiredChanged = previous.required !== next.required;
  const uniqueChanged = previous.unique !== next.unique;
  const defaultChanged = JSON.stringify(previous.default) !== JSON.stringify(next.default);
  if (typeChanged) changes.push('type');
  if (requiredChanged) changes.push('nullability');
  if (uniqueChanged) changes.push('unique');
  if (defaultChanged) changes.push('default');
  if (changes.length === 0) return undefined;

  if (database === 'mysql') {
    if (typeChanged || requiredChanged || defaultChanged) {
      statements.push(
        `ALTER TABLE ${tableName} MODIFY COLUMN ${next.columnName} ${columnDefinition(
          nextMetadata.sqlType,
          nextMetadata.defaultSql,
          next.required,
          false,
        )};`,
      );
    }
    if (uniqueChanged) {
      if (next.unique) {
        statements.push(
          `ALTER TABLE ${tableName} ADD CONSTRAINT ${uniqueConstraintName(tableName, next.columnName)} UNIQUE (${next.columnName});`,
        );
      } else {
        statements.push(
          `ALTER TABLE ${tableName} DROP INDEX ${uniqueConstraintName(tableName, next.columnName)};`,
        );
      }
    }
  } else {
    if (typeChanged) {
      statements.push(
        database === 'h2'
          ? `ALTER TABLE ${tableName} ALTER COLUMN ${next.columnName} SET DATA TYPE ${nextMetadata.sqlType};`
          : `ALTER TABLE ${tableName} ALTER COLUMN ${next.columnName} TYPE ${nextMetadata.sqlType};`,
      );
    }
    if (requiredChanged) {
      statements.push(
        `ALTER TABLE ${tableName} ALTER COLUMN ${next.columnName} ${next.required ? 'SET NOT NULL' : 'DROP NOT NULL'};`,
      );
    }
    if (defaultChanged) {
      statements.push(
        nextMetadata.defaultSql === undefined
          ? `ALTER TABLE ${tableName} ALTER COLUMN ${next.columnName} DROP DEFAULT;`
          : `ALTER TABLE ${tableName} ALTER COLUMN ${next.columnName} SET DEFAULT ${nextMetadata.defaultSql};`,
      );
    }
    if (uniqueChanged) {
      if (next.unique) {
        statements.push(
          `ALTER TABLE ${tableName} ADD CONSTRAINT ${uniqueConstraintName(tableName, next.columnName)} UNIQUE (${next.columnName});`,
        );
      } else {
        statements.push(
          `ALTER TABLE ${tableName} DROP CONSTRAINT ${uniqueConstraintName(tableName, next.columnName)};`,
        );
      }
    }
  }

  if (typeChanged) {
    liquibase.push(
      `        <modifyDataType tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.columnName)}" newDataType="${xmlEscape(nextMetadata.sqlType)}"/>`,
    );
  }
  if (requiredChanged) {
    liquibase.push(
      next.required
        ? `        <addNotNullConstraint tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.columnName)}" columnDataType="${xmlEscape(nextMetadata.sqlType)}"/>`
        : `        <dropNotNullConstraint tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.columnName)}" columnDataType="${xmlEscape(nextMetadata.sqlType)}"/>`,
    );
  }
  if (uniqueChanged) {
    liquibase.push(
      next.unique
        ? `        <addUniqueConstraint tableName="${xmlEscape(tableName)}" columnNames="${xmlEscape(next.columnName)}" constraintName="${xmlEscape(uniqueConstraintName(tableName, next.columnName))}"/>`
        : `        <dropUniqueConstraint tableName="${xmlEscape(tableName)}" constraintName="${xmlEscape(uniqueConstraintName(tableName, next.columnName))}"/>`,
    );
  }
  if (defaultChanged) {
    liquibase.push(
      nextMetadata.defaultSql === undefined
        ? `        <dropDefaultValue tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.columnName)}" columnDataType="${xmlEscape(nextMetadata.sqlType)}"/>`
        : `        <addDefaultValue tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.columnName)}" columnDataType="${xmlEscape(nextMetadata.sqlType)}" ${nextMetadata.liquibaseDefault ?? `defaultValue="${xmlEscape(String(next.default))}"`}/>`,
    );
  }

  return {
    kind: 'modify-column',
    label: `alter_${next.columnName}`,
    description: `Alter column ${next.columnName} (${changes.join(', ')})`,
    statements,
    liquibase: liquibase.join('\n'),
  };
}

function addForeignKeyChange(
  tableName: string,
  relation: ResolvedRelationModel,
  database: SqlDatabase,
): MigrationChange {
  const uuidType = sqlTypeForField({ type: 'UUID' }, database);
  const definition = columnDefinition(uuidType, undefined, relation.required, false);
  const statements = [
    `ALTER TABLE ${tableName} ADD COLUMN ${relation.joinColumnName} ${definition};`,
    `ALTER TABLE ${tableName} ADD CONSTRAINT ${foreignKeyConstraintName(tableName, relation.joinColumnName)} FOREIGN KEY (${relation.joinColumnName}) REFERENCES ${relation.targetEntity.tableName} (id);`,
  ];
  if (relation.type === 'one-to-one') {
    statements.splice(
      1,
      0,
      `ALTER TABLE ${tableName} ADD CONSTRAINT ${uniqueConstraintName(tableName, relation.joinColumnName)} UNIQUE (${relation.joinColumnName});`,
    );
  }
  return {
    kind: 'add-foreign-key',
    label: `add_fk_${relation.joinColumnName}`,
    description: `Add relation ${relation.field} (${relation.joinColumnName})`,
    statements,
    liquibase: [
      liquibaseAddColumn(
        tableName,
        relation.joinColumnName,
        uuidType,
        undefined,
        relation.required,
        relation.type === 'one-to-one',
      ),
      `        <addForeignKeyConstraint baseTableName="${xmlEscape(tableName)}" baseColumnNames="${xmlEscape(relation.joinColumnName)}" constraintName="${xmlEscape(foreignKeyConstraintName(tableName, relation.joinColumnName))}" referencedTableName="${xmlEscape(relation.targetEntity.tableName)}" referencedColumnNames="id"/>`,
    ].join('\n'),
  };
}

function dropForeignKeyChange(
  tableName: string,
  relation: ResolvedRelationModel,
  database: SqlDatabase,
): MigrationChange {
  return {
    kind: 'drop-foreign-key',
    label: `drop_fk_${relation.joinColumnName}`,
    description: `Drop relation ${relation.field} (${relation.joinColumnName})`,
    statements: [
      dropForeignKeyStatement(tableName, relation.joinColumnName, database),
      `ALTER TABLE ${tableName} DROP COLUMN ${relation.joinColumnName};`,
    ],
    liquibase: [
      `        <dropForeignKeyConstraint baseTableName="${xmlEscape(tableName)}" constraintName="${xmlEscape(foreignKeyConstraintName(tableName, relation.joinColumnName))}"/>`,
      `        <dropColumn tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(relation.joinColumnName)}"/>`,
    ].join('\n'),
  };
}

function modifyRelationColumnChange(
  tableName: string,
  previous: ResolvedRelationModel,
  next: ResolvedRelationModel,
  database: SqlDatabase,
): MigrationChange | undefined {
  const changes: string[] = [];
  const statements: string[] = [];
  const liquibase: string[] = [];

  if (previous.targetEntity.tableName !== next.targetEntity.tableName) {
    changes.push('target');
    statements.push(
      dropForeignKeyStatement(tableName, next.joinColumnName, database),
      `ALTER TABLE ${tableName} ADD CONSTRAINT ${foreignKeyConstraintName(tableName, next.joinColumnName)} FOREIGN KEY (${next.joinColumnName}) REFERENCES ${next.targetEntity.tableName} (id);`,
    );
    liquibase.push(
      `        <dropForeignKeyConstraint baseTableName="${xmlEscape(tableName)}" constraintName="${xmlEscape(foreignKeyConstraintName(tableName, next.joinColumnName))}"/>`,
      `        <addForeignKeyConstraint baseTableName="${xmlEscape(tableName)}" baseColumnNames="${xmlEscape(next.joinColumnName)}" constraintName="${xmlEscape(foreignKeyConstraintName(tableName, next.joinColumnName))}" referencedTableName="${xmlEscape(next.targetEntity.tableName)}" referencedColumnNames="id"/>`,
    );
  }

  const previousUnique = previous.type === 'one-to-one';
  const nextUnique = next.type === 'one-to-one';
  const requiredChanged = previous.required !== next.required;
  const uniqueChanged = previousUnique !== nextUnique;
  if (requiredChanged || uniqueChanged) {
    const nextMetadata = {
      sqlType: sqlTypeForField({ type: 'UUID' }, database),
    };
    if (database === 'mysql') {
      statements.push(
        `ALTER TABLE ${tableName} MODIFY COLUMN ${next.joinColumnName} ${columnDefinition(
          nextMetadata.sqlType,
          undefined,
          next.required,
          false,
        )};`,
      );
    } else {
      if (requiredChanged) {
        statements.push(
          `ALTER TABLE ${tableName} ALTER COLUMN ${next.joinColumnName} ${next.required ? 'SET NOT NULL' : 'DROP NOT NULL'};`,
        );
      }
    }
    if (uniqueChanged) {
      if (nextUnique) {
        statements.push(
          `ALTER TABLE ${tableName} ADD CONSTRAINT ${uniqueConstraintName(tableName, next.joinColumnName)} UNIQUE (${next.joinColumnName});`,
        );
      } else {
        statements.push(
          database === 'mysql'
            ? `ALTER TABLE ${tableName} DROP INDEX ${uniqueConstraintName(tableName, next.joinColumnName)};`
            : `ALTER TABLE ${tableName} DROP CONSTRAINT ${uniqueConstraintName(tableName, next.joinColumnName)};`,
        );
      }
    }
    if (requiredChanged) {
      liquibase.push(
        next.required
          ? `        <addNotNullConstraint tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.joinColumnName)}" columnDataType="${xmlEscape(nextMetadata.sqlType)}"/>`
          : `        <dropNotNullConstraint tableName="${xmlEscape(tableName)}" columnName="${xmlEscape(next.joinColumnName)}" columnDataType="${xmlEscape(nextMetadata.sqlType)}"/>`,
      );
    }
    if (uniqueChanged) {
      liquibase.push(
        nextUnique
          ? `        <addUniqueConstraint tableName="${xmlEscape(tableName)}" columnNames="${xmlEscape(next.joinColumnName)}" constraintName="${xmlEscape(uniqueConstraintName(tableName, next.joinColumnName))}"/>`
          : `        <dropUniqueConstraint tableName="${xmlEscape(tableName)}" constraintName="${xmlEscape(uniqueConstraintName(tableName, next.joinColumnName))}"/>`,
      );
    }
  }

  if (changes.length === 0 && statements.length === 0) return undefined;
  if (changes.length === 0) changes.push('nullability');
  return {
    kind: 'modify-relation',
    label: `alter_fk_${next.joinColumnName}`,
    description: `Alter relation ${next.field} (${changes.join(', ')})`,
    statements,
    liquibase: liquibase.join('\n'),
  };
}

function createJoinTableChange(
  tableName: string,
  relation: ResolvedRelationModel,
  database: SqlDatabase,
): MigrationChange {
  const uuidType = sqlTypeForField({ type: 'UUID' }, database);
  return {
    kind: 'create-join-table',
    label: `add_join_${relation.joinTableName}`,
    description: `Add join table ${relation.joinTableName}`,
    statements: joinTableStatements(
      relation.joinTableName,
      relation.joinTableJoinColumn,
      relation.joinTableInverseColumn,
      tableName,
      relation.targetEntity.tableName,
      uuidType,
    ),
    liquibase: liquibaseJoinTable(
      relation.joinTableName,
      relation.joinTableJoinColumn,
      relation.joinTableInverseColumn,
      tableName,
      relation.targetEntity.tableName,
      uuidType,
    ),
  };
}

function dropJoinTableChange(tableName: string, relation: ResolvedRelationModel): MigrationChange {
  return {
    kind: 'drop-join-table',
    label: `drop_join_${relation.joinTableName}`,
    description: `Drop join table ${relation.joinTableName}`,
    statements: [`DROP TABLE ${relation.joinTableName};`],
    liquibase: `        <dropTable tableName="${xmlEscape(relation.joinTableName)}"/>`,
  };
}

function columnDefinition(
  sqlType: string,
  defaultSql: string | undefined,
  required: boolean,
  unique: boolean,
): string {
  return `${sqlType}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}${
    required ? ' NOT NULL' : ''
  }${unique ? ' UNIQUE' : ''}`;
}

function uniqueConstraintName(tableName: string, columnName: string): string {
  return `uq_${tableName}_${columnName}`;
}

function foreignKeyConstraintName(tableName: string, columnName: string): string {
  return `fk_${tableName}_${columnName}`;
}

function dropForeignKeyStatement(
  tableName: string,
  columnName: string,
  database: SqlDatabase,
): string {
  const constraintName = foreignKeyConstraintName(tableName, columnName);
  return database === 'mysql'
    ? `ALTER TABLE ${tableName} DROP FOREIGN KEY ${constraintName};`
    : `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName};`;
}

function joinTableStatements(
  joinTable: string,
  joinColumn: string,
  inverseColumn: string,
  ownerTable: string,
  targetTable: string,
  uuidType: string,
): string[] {
  return [
    `CREATE TABLE ${joinTable} (\n    ${joinColumn} ${uuidType} NOT NULL,\n    ${inverseColumn} ${uuidType} NOT NULL,\n    CONSTRAINT pk_${joinTable} PRIMARY KEY (${joinColumn}, ${inverseColumn}),\n    CONSTRAINT fk_${joinTable}_owner FOREIGN KEY (${joinColumn}) REFERENCES ${ownerTable} (id) ON DELETE CASCADE,\n    CONSTRAINT fk_${joinTable}_target FOREIGN KEY (${inverseColumn}) REFERENCES ${targetTable} (id) ON DELETE CASCADE\n);`,
  ];
}

function liquibaseAddColumn(
  tableName: string,
  columnName: string,
  sqlType: string,
  defaultAttribute: string | undefined,
  required: boolean,
  unique: boolean,
): string {
  const constraints: string[] = [];
  if (required) constraints.push('nullable="false"');
  if (unique) {
    constraints.push('unique="true"');
    constraints.push(
      `uniqueConstraintName="${xmlEscape(uniqueConstraintName(tableName, columnName))}"`,
    );
  }
  const constraint =
    constraints.length === 0
      ? ''
      : `\n                    <constraints ${constraints.join(' ')}/>\n                `;
  const defaultPart = defaultAttribute === undefined ? '' : ` ${defaultAttribute}`;
  return `        <addColumn tableName="${xmlEscape(tableName)}">\n            <column name="${xmlEscape(columnName)}" type="${xmlEscape(sqlType)}"${defaultPart}>${constraint}</column>\n        </addColumn>`;
}

function liquibaseJoinTable(
  joinTable: string,
  joinColumn: string,
  inverseColumn: string,
  ownerTable: string,
  targetTable: string,
  uuidType: string,
): string {
  return [
    `        <createTable tableName="${xmlEscape(joinTable)}">`,
    `            <column name="${xmlEscape(joinColumn)}" type="${xmlEscape(uuidType)}"><constraints nullable="false"/></column>`,
    `            <column name="${xmlEscape(inverseColumn)}" type="${xmlEscape(uuidType)}"><constraints nullable="false"/></column>`,
    '        </createTable>',
    `        <addPrimaryKey tableName="${xmlEscape(joinTable)}" columnNames="${xmlEscape(joinColumn)}, ${xmlEscape(inverseColumn)}" constraintName="pk_${xmlEscape(joinTable)}"/>`,
    `        <addForeignKeyConstraint baseTableName="${xmlEscape(joinTable)}" baseColumnNames="${xmlEscape(joinColumn)}" constraintName="fk_${xmlEscape(joinTable)}_owner" referencedTableName="${xmlEscape(ownerTable)}" referencedColumnNames="id" onDelete="CASCADE"/>`,
    `        <addForeignKeyConstraint baseTableName="${xmlEscape(joinTable)}" baseColumnNames="${xmlEscape(inverseColumn)}" constraintName="fk_${xmlEscape(joinTable)}_target" referencedTableName="${xmlEscape(targetTable)}" referencedColumnNames="id" onDelete="CASCADE"/>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

function buildSeedRows(
  entity: EntityModel,
  projectSeed: boolean,
  logger?: { warn(message: string): void },
): SeedRowModel[] {
  if (entity.seedData.length > 0) {
    return entity.seedData.map((row, index) => buildSeedRow(entity, row, index, logger));
  }
  if (!entity.seed && !projectSeed) return [];
  return [buildSeedRow(entity, {}, 0, logger)];
}

function buildSeedRow(
  entity: EntityModel,
  explicit: Record<string, unknown>,
  index: number,
  logger?: { warn(message: string): void },
): SeedRowModel {
  const columns: SeedColumnModel[] = [];
  const explicitValues = new Map<string, unknown>();
  for (const [key, value] of Object.entries(explicit)) {
    if (key === 'id') {
      explicitValues.set('id', value);
      continue;
    }
    const field = entity.fields.find(
      (candidate) => candidate.name === key || candidate.columnName === key,
    );
    if (field !== undefined) {
      explicitValues.set(field.name, value);
      continue;
    }
    const relation = entity.owningRelations.find(
      (candidate) =>
        `${candidate.field}Id` === key ||
        candidate.joinColumnName === key ||
        (candidate.collection && `${candidate.field}Ids` === key),
    );
    if (relation !== undefined) {
      explicitValues.set(`${relation.field}.id`, value);
      continue;
    }
    logger?.warn(
      `Ignoring unknown seed column "${key}" for ${entity.className}. Use field names or <relation>Id.`,
    );
  }

  const idValue = explicitValues.get('id');
  columns.push({
    name: 'id',
    sql: seedSqlValue(idValue ?? deterministicUuid(entity.tableName, String(index)), 'UUID'),
    attribute:
      idValue === undefined
        ? `value="${deterministicUuid(entity.tableName, String(index))}"`
        : seedLiquibaseAttribute(idValue, 'UUID'),
  });

  for (const field of entity.fields) {
    const explicitValue = explicitValues.get(field.name);
    const value =
      explicitValue === undefined ? sampleFieldValue(entity, field, index) : explicitValue;
    const seed = seedValue(value, field);
    columns.push({ name: field.columnName, sql: seed.sql, attribute: seed.attribute });
  }

  for (const relation of entity.owningRelations) {
    if (relation.collection) continue;
    const explicitValue = explicitValues.get(`${relation.field}.id`);
    if (explicitValue === undefined) {
      if (relation.required) {
        logger?.warn(
          `Skipping seed data for ${entity.className}: required relation "${relation.field}" needs an explicit "${relation.field}Id" value.`,
        );
        return { columns: [], sql: '', liquibase: '' };
      }
      columns.push({
        name: relation.joinColumnName,
        sql: 'NULL',
        attribute: 'valueComputed="NULL"',
      });
      continue;
    }
    columns.push({
      name: relation.joinColumnName,
      sql: seedSqlValue(explicitValue, 'UUID'),
      attribute: seedLiquibaseAttribute(explicitValue, 'UUID'),
    });
  }

  if (columns.length === 0) return { columns: [], sql: '', liquibase: '' };
  const names = columns.map((column) => column.name).join(', ');
  const values = columns.map((column) => column.sql).join(', ');
  return {
    columns,
    sql: `INSERT INTO ${entity.tableName} (${names}) VALUES (${values});`,
    liquibase: [
      `        <insert tableName="${xmlEscape(entity.tableName)}">`,
      ...columns.map(
        (column) => `            <column name="${xmlEscape(column.name)}" ${column.attribute}/>`,
      ),
      '        </insert>',
    ].join('\n'),
  };
}

interface SeedValue {
  sql: string;
  attribute: string;
}

function seedValue(value: unknown, field: EntityFieldModel): SeedValue {
  const type = field.javaType;
  if (value === null || value === undefined) {
    return { sql: 'NULL', attribute: 'valueComputed="NULL"' };
  }
  if (type === 'boolean' || type === 'Boolean') {
    const booleanValue = value === true || value === 'true';
    return {
      sql: booleanValue ? 'TRUE' : 'FALSE',
      attribute: `valueBoolean="${booleanValue}"`,
    };
  }
  if (isNumericSqlType(type)) {
    const numeric = typeof value === 'number' ? value : Number(value);
    return {
      sql: Number.isFinite(numeric) ? String(numeric) : 'NULL',
      attribute: `valueNumeric="${Number.isFinite(numeric) ? numeric : 0}"`,
    };
  }
  return {
    sql: seedSqlValue(value, type),
    attribute: seedLiquibaseAttribute(value, type),
  };
}

function sampleFieldValue(entity: EntityModel, field: EntityFieldModel, index: number): unknown {
  if (field.default !== undefined) return field.default;
  const suffix = index === 0 ? '' : ` ${index + 1}`;
  const lowerName = field.name.toLowerCase();
  switch (field.javaType) {
    case 'boolean':
    case 'Boolean':
      return true;
    case 'byte':
    case 'Byte':
    case 'short':
    case 'Short':
    case 'int':
    case 'Integer':
    case 'long':
    case 'Long':
    case 'BigInteger':
      return index + 1;
    case 'float':
    case 'Float':
    case 'double':
    case 'Double':
    case 'BigDecimal':
      return /\b(price|amount|cost|total|salary)\b/.test(lowerName) ? 9.99 : index + 1;
    case 'UUID':
      return deterministicUuid(entity.tableName, field.name, String(index));
    case 'LocalDate':
      return { __computed: 'CURRENT_DATE' };
    case 'LocalTime':
      return { __computed: 'CURRENT_TIME' };
    case 'LocalDateTime':
    case 'Instant':
    case 'OffsetDateTime':
      return { __computed: 'CURRENT_TIMESTAMP' };
    default:
      break;
  }

  if (lowerName.includes('email')) return `sample${suffix.replace(' ', '')}@example.com`;
  if (lowerName.includes('url') || lowerName.includes('website')) return 'https://example.com';
  if (lowerName.includes('phone')) return '+10000000000';
  if (lowerName.includes('code') || lowerName.includes('slug')) {
    return `${entity.routeName}${suffix.replace(' ', '-') || ''}`;
  }
  if (lowerName.includes('description') || lowerName.includes('notes')) {
    return `Generated seed data for ${entity.className}.`;
  }
  if (
    lowerName === 'name' ||
    lowerName === 'title' ||
    lowerName === 'label' ||
    lowerName.endsWith('name')
  ) {
    return `Sample ${entity.className}${suffix}`;
  }
  return `${field.name} ${index + 1}`;
}

function seedSqlValue(value: unknown, type: string): string {
  if (isComputed(value)) return value.__computed;
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  if (isNumericSqlType(type)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(numeric) : 'NULL';
  }
  if (isTemporalType(type) && typeof value === 'string' && /^(CURRENT_|NOW\(\))/i.test(value)) {
    return value;
  }
  return sqlStringLiteral(String(value));
}

function seedLiquibaseAttribute(value: unknown, type: string): string {
  if (isComputed(value)) return `valueComputed="${xmlEscape(value.__computed)}"`;
  if (value === null || value === undefined) return 'valueComputed="NULL"';
  if (typeof value === 'boolean') return `valueBoolean="${value}"`;
  if (typeof value === 'number') return `valueNumeric="${value}"`;
  if (isNumericSqlType(type)) {
    const numeric = Number(value);
    return `valueNumeric="${Number.isFinite(numeric) ? numeric : 0}"`;
  }
  if (isTemporalType(type) && typeof value === 'string' && /^(CURRENT_|NOW\(\))/i.test(value)) {
    return `valueComputed="${xmlEscape(value)}"`;
  }
  return `value="${xmlEscape(String(value))}"`;
}

function isComputed(value: unknown): value is { __computed: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__computed' in value &&
    typeof (value as { __computed: unknown }).__computed === 'string'
  );
}

function isNumericSqlType(type: string): boolean {
  return [
    'byte',
    'Byte',
    'short',
    'Short',
    'int',
    'Integer',
    'long',
    'Long',
    'BigInteger',
    'float',
    'Float',
    'double',
    'Double',
    'BigDecimal',
  ].includes(type);
}

function isTemporalType(type: string): boolean {
  return ['Instant', 'LocalDate', 'LocalTime', 'LocalDateTime', 'OffsetDateTime'].includes(type);
}

/** Deterministic UUID so repeated seed generation produces stable snapshots. */
function deterministicUuid(...parts: string[]): string {
  const hash = createHash('sha256').update(parts.join(':')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
