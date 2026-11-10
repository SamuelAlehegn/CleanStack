import { FIELD_TYPES } from '../config.js';
import type { SqlDatabase } from '../sql-types.js';
import { CleanStackError } from '../../utils/errors.js';
import {
  type ExtensionRegistry,
  type FieldTypeDefinition,
  type FieldKind,
  type FieldSqlContext,
  type FrontendFrameworkDefinition,
  type ResolvedFieldType,
} from './types.js';

const FIELD_TYPE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const FRAMEWORK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const BUILT_IN_FRAMEWORK_NAMES: readonly string[] = ['angular'];
const DEFAULT_SQL_TYPE = 'VARCHAR(255)';

/** Raised when an extension registers an invalid or duplicate capability. */
export class ExtensionRegistryError extends CleanStackError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, { suggestions });
    this.name = 'ExtensionRegistryError';
  }
}

interface Owned<T> {
  definition: T;
  owner: string;
}

/** Collects the capabilities contributed by extensions. */
export class ExtensionRegistrySet implements ExtensionRegistry {
  private readonly fieldTypes = new Map<string, Owned<FieldTypeDefinition>>();
  private readonly frameworks = new Map<string, Owned<FrontendFrameworkDefinition>>();
  private owner = 'unknown';

  /** Names the extension whose registrations are added next; shown in error messages. */
  setOwner(extensionName: string): void {
    this.owner = extensionName;
  }

  registerFieldType(definition: FieldTypeDefinition): void {
    assertFieldType(definition?.name);
    this.assertNew(definition.name, 'Field type');
    this.fieldTypes.set(definition.name, { definition, owner: this.owner });
  }

  registerFrontendFramework(definition: FrontendFrameworkDefinition): void {
    assertFramework(definition?.name);
    this.assertNew(definition.name, 'Frontend framework');
    this.frameworks.set(definition.name, { definition, owner: this.owner });
  }

  getFieldType(name: string): FieldTypeDefinition | undefined {
    return this.fieldTypes.get(name)?.definition;
  }

  getFrontendFramework(name: string): FrontendFrameworkDefinition | undefined {
    return this.frameworks.get(name)?.definition;
  }

  /** Descriptor names of the registered field types, in registration order. */
  fieldTypeNames(): string[] {
    return [...this.fieldTypes.keys()];
  }

  /** Registered frontend frameworks, in registration order. */
  frontendFrameworks(): FrontendFrameworkDefinition[] {
    return [...this.frameworks.values()].map((entry) => entry.definition);
  }

  /** Fills a definition's defaults. Undefined for built-ins and unknown names. */
  resolveFieldType(name: string): ResolvedFieldType | undefined {
    const entry = this.fieldTypes.get(name);
    if (entry === undefined) return undefined;
    const { definition, owner } = entry;
    const kind: FieldKind = definition.kind ?? 'other';
    const typescriptType = definition.typescriptType ?? defaultTypescriptType(kind);
    const typescriptDefault =
      definition.typescriptDefault ?? defaultTypescriptDefault(typescriptType);
    return {
      name,
      javaType: definition.javaType ?? name,
      javaImports: definition.javaImports ?? [],
      typescriptType,
      typescriptDefault,
      kind,
      sqlTypeFor: (field: FieldSqlContext, database: SqlDatabase): string =>
        resolveSqlType(definition.sqlType, owner, field, database),
    };
  }

  private assertNew(name: string, label: string): void {
    const existing = this.fieldTypes.get(name) ?? this.frameworks.get(name);
    if (existing !== undefined) {
      throw new ExtensionRegistryError(
        `${label} "${name}" was already registered by "${existing.owner}".`,
        ['Give your extension a distinct name instead of replacing the existing definition.'],
      );
    }
  }
}

/** Registry returned before extensions were loaded; registers nothing, resolves nothing. */
class EmptyRegistry implements ExtensionRegistry {
  registerFieldType(): void {
    throw new ExtensionRegistryError(
      'Field types are only registered while extensions are loaded, not during generation.',
      ['Write the extension file first and declare it in the configuration "extensions" list.'],
    );
  }

  registerFrontendFramework(): void {
    throw new ExtensionRegistryError(
      'Frontend frameworks are only registered while extensions are loaded, not during generation.',
      ['Write the extension file first and declare it in the configuration "extensions" list.'],
    );
  }

  getFieldType(): FieldTypeDefinition | undefined {
    return undefined;
  }

  getFrontendFramework(): FrontendFrameworkDefinition | undefined {
    return undefined;
  }

  fieldTypeNames(): string[] {
    return [];
  }

  frontendFrameworks(): FrontendFrameworkDefinition[] {
    return [];
  }
}

function assertFieldType(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '') {
    throw new ExtensionRegistryError(
      'An extension tried to register a field type without a name.',
      ['Set the "name" property on the field type definition.'],
    );
  }
  if (!FIELD_TYPE_NAME_PATTERN.test(name)) {
    throw new ExtensionRegistryError(`Invalid field type name "${name}".`, [
      'A field type name must be a valid identifier, for example "Money" or "PhoneNumber".',
    ]);
  }
  if (FIELD_TYPES.includes(name as (typeof FIELD_TYPES)[number])) {
    throw new ExtensionRegistryError(`Field type "${name}" is already built into CleanStack.`, [
      'Extensions add new field types; built-in types cannot be replaced.',
    ]);
  }
}

function assertFramework(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '') {
    throw new ExtensionRegistryError(
      'An extension tried to register a frontend framework without a name.',
      ['Set the "name" property on the frontend framework definition.'],
    );
  }
  if (!FRAMEWORK_NAME_PATTERN.test(name)) {
    throw new ExtensionRegistryError(`Invalid frontend framework name "${name}".`, [
      'Use a lower-case name with letters, digits, and dashes, for example "react".',
    ]);
  }
  if (BUILT_IN_FRAMEWORK_NAMES.includes(name)) {
    throw new ExtensionRegistryError(
      `Frontend framework "${name}" is already built into CleanStack.`,
      ['Extensions add new frameworks; built-in frameworks cannot be replaced.'],
    );
  }
}

function resolveSqlType(
  sqlType: FieldTypeDefinition['sqlType'],
  owner: string,
  field: FieldSqlContext,
  database: SqlDatabase,
): string {
  if (sqlType === undefined) return DEFAULT_SQL_TYPE;
  if (typeof sqlType === 'string') return sqlType;
  if (typeof sqlType === 'function') {
    try {
      return sqlType(field, database);
    } catch (error) {
      throw new ExtensionRegistryError(
        `Extension "${owner}" failed to compute the SQL type for "${field.type}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const forDatabase = sqlType[database];
  return typeof forDatabase === 'string' ? forDatabase : DEFAULT_SQL_TYPE;
}

function defaultTypescriptType(kind: FieldKind): string {
  if (kind === 'numeric') return 'number';
  if (kind === 'boolean') return 'boolean';
  return 'string';
}

function defaultTypescriptDefault(typescriptType: string): string {
  if (typescriptType === 'boolean') return 'false';
  if (typescriptType === 'number') return '0';
  return "''";
}

/**
 * Registry consulted by generation. Empty until the loader activates one that
 * has registered extension capabilities.
 */
let active: ExtensionRegistry = new EmptyRegistry();

/** Registry that generation currently consults; empty unless extensions were loaded. */
export function getActiveRegistry(): ExtensionRegistry {
  return active;
}

/** Replaces the active registry after extensions have been registered. */
export function setActiveRegistry(registry: ExtensionRegistry): void {
  active = registry;
}

/** Restores the empty registry. Used by tests to isolate cases. */
export function resetActiveRegistry(): void {
  active = new EmptyRegistry();
}

/** Resolves a field type in the active registry; undefined for built-ins and unknown names. */
export function resolveActiveFieldType(name: string): ResolvedFieldType | undefined {
  return active instanceof ExtensionRegistrySet ? active.resolveFieldType(name) : undefined;
}

/** Field type names contributed by extensions, in registration order. */
export function activeFieldTypeNames(): string[] {
  return active.fieldTypeNames();
}

/** Frontend frameworks contributed by extensions. */
export function activeFrontendFrameworks(): FrontendFrameworkDefinition[] {
  return active.frontendFrameworks();
}

/**
 * Schema options for `createConfigSchemas`: the field types contributed by
 * extensions plus a kind lookup for classifying them in descriptor validation.
 */
export function activeSchemaInput(): {
  fieldTypes: string[];
  fieldKind: (fieldType: string) => FieldKind | undefined;
} {
  const fieldTypes = activeFieldTypeNames();
  return {
    fieldTypes,
    fieldKind: (fieldType: string): FieldKind | undefined =>
      active instanceof ExtensionRegistrySet ? active.getFieldType(fieldType)?.kind : undefined,
  };
}
