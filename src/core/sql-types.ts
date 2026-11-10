import type { FieldConfig, GenerationOptions } from './config.js';
import type { EntityFieldModel, EntityModel } from './entity-model.js';
import { resolveActiveFieldType } from './extensions/registry.js';

export type SqlDatabase = GenerationOptions['database'];

export interface SqlFieldMetadata {
  /** Database-specific SQL column type, for example `VARCHAR(120)` or `TIMESTAMP WITH TIME ZONE`. */
  sqlType: string;
  /** SQL literal used in a `DEFAULT` clause, when the field declares a default. */
  defaultSql?: string;
  /** Liquibase `<column>` default attributes, for example `defaultValueNumeric="1"`. */
  liquibaseDefault?: string;
}

export type SqlEntityField = EntityFieldModel & SqlFieldMetadata;

/**
 * Maps a descriptor field to the SQL type used by Flyway migrations and
 * Liquibase changelogs. The output intentionally stays close to the types the
 * templates emitted before the mapping moved into TypeScript; keeping it in one
 * place means create, update, and seed migrations can never disagree.
 */
export function sqlTypeForField(
  field: Pick<FieldConfig, 'type' | 'maxLength'>,
  database: SqlDatabase,
): string {
  const custom = resolveActiveFieldType(field.type);
  if (custom) return custom.sqlTypeFor(field, database);

  switch (field.type) {
    case 'String':
      return `VARCHAR(${field.maxLength ?? 255})`;
    case 'UUID':
      return database === 'mysql' ? 'CHAR(36)' : 'UUID';
    case 'BigDecimal':
    case 'BigInteger':
      return 'NUMERIC';
    case 'Instant':
    case 'OffsetDateTime':
      return database === 'mysql' ? 'TIMESTAMP' : 'TIMESTAMP WITH TIME ZONE';
    case 'LocalDateTime':
      return 'TIMESTAMP';
    case 'LocalDate':
      return 'DATE';
    case 'LocalTime':
      return 'TIME';
    case 'boolean':
    case 'Boolean':
      return 'BOOLEAN';
    case 'byte':
    case 'Byte':
    case 'short':
    case 'Short':
      return 'SMALLINT';
    case 'int':
    case 'Integer':
      return 'INTEGER';
    case 'long':
    case 'Long':
      return 'BIGINT';
    case 'float':
    case 'Float':
      return 'REAL';
    case 'double':
    case 'Double':
      return 'DOUBLE PRECISION';
    default:
      return 'VARCHAR(255)';
  }
}

export interface SqlEntityModel extends EntityModel {
  /** SQL type of the generated UUID primary key (`UUID` or `CHAR(36)` on MySQL). */
  idSqlType: string;
}

/** Adds the SQL metadata that migration templates rely on to an entity model. */
export function withSqlMetadata(entity: EntityModel, database: SqlDatabase): SqlEntityModel {
  return {
    ...entity,
    idSqlType: sqlTypeForField({ type: 'UUID' }, database),
    fields: entity.fields.map((field) => ({
      ...field,
      ...sqlMetadataForField(field, database),
    })),
  };
}

/** Metadata for one field; exported for update migrations that need a previous field's type. */
export function sqlMetadataForField(field: FieldConfig, database: SqlDatabase): SqlFieldMetadata {
  const metadata: SqlFieldMetadata = { sqlType: sqlTypeForField(field, database) };
  const defaultLiteral = sqlDefaultLiteral(field);
  if (defaultLiteral !== undefined) {
    metadata.defaultSql = defaultLiteral.sql;
    metadata.liquibaseDefault = defaultLiteral.liquibase;
  }
  return metadata;
}

export interface SqlDefaultLiteral {
  /** SQL literal used by Flyway, for example `'pending'`, `true`, or `0`. */
  sql: string;
  /** Liquibase column attribute, for example `defaultValue="pending"`. */
  liquibase: string;
}

/** Converts a descriptor default to SQL and Liquibase representations. */
export function sqlDefaultLiteral(field: FieldConfig): SqlDefaultLiteral | undefined {
  if (field.default === undefined || field.default === null) return undefined;

  if (typeof field.default === 'boolean') {
    return {
      sql: field.default ? 'TRUE' : 'FALSE',
      liquibase: `defaultValueBoolean="${field.default}"`,
    };
  }
  if (typeof field.default === 'number') {
    return {
      sql: String(field.default),
      liquibase: `defaultValueNumeric="${field.default}"`,
    };
  }
  if (typeof field.default === 'string') {
    return {
      sql: sqlStringLiteral(field.default),
      liquibase: `defaultValue="${xmlEscape(field.default)}"`,
    };
  }

  // Arrays and objects have no portable SQL literal; callers can still add one
  // through a custom migration when they need a database-specific expression.
  return undefined;
}

/** Escapes a string as a single-quoted SQL literal. */
export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Escapes XML attribute values. */
export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
