/**
 * Public contract for CleanStack extensions.
 *
 * An extension is a small module that registers optional capabilities with the
 * generator. The core never imports extension code, and extensions never fork
 * the core: they only add names that join the same lookup tables the generator
 * already consults.
 */
import type { FieldKind } from '../config.js';
import type { SqlDatabase } from '../sql-types.js';

/** Structural category of a field type; decides which descriptor options apply. */
export type { FieldKind };

/** A field type added by an extension, for example `Money` or `PhoneNumber`. */
export interface FieldTypeDefinition {
  /** Name used in entity descriptors, exactly as it is spelled there. */
  name: string;
  /** Java type emitted in entities and DTOs. Defaults to the field type name. */
  javaType?: string;
  /** Fully qualified Java types imported when a field uses this type. */
  javaImports?: readonly string[];
  /** TypeScript type emitted in frontend models. Defaults by {@link FieldTypeDefinition.kind}. */
  typescriptType?: string;
  /** TypeScript literal used as the initial form value. Defaults by {@link FieldTypeDefinition.typescriptType}. */
  typescriptDefault?: string;
  /**
   * Structural category: `string` allows minLength/maxLength/pattern in
   * descriptors, `numeric` allows min/max, and other kinds allow neither until
   * the type teaches the generators about them. Defaults to `other`.
   */
  kind?: FieldKind;
  /**
   * SQL column type used by Flyway and Liquibase migrations: a constant, a
   * record keyed by database, or a function for field-dependent types such as
   * `VARCHAR(120)`. Defaults to `VARCHAR(255)`.
   */
  sqlType?:
    | string
    | Partial<Record<SqlDatabase, string>>
    | ((field: FieldSqlContext, database: SqlDatabase) => string);
}

/** Descriptor metadata available when an extension computes a field's SQL type. */
export type FieldSqlContext = {
  /** Descriptor field type name. */
  type: string;
  /** Declared max length, used by types such as `VARCHAR(120)`. */
  maxLength?: number | undefined;
};

/** A frontend framework added by an extension, for example `react`. */
export interface FrontendFrameworkDefinition {
  /** Lower-case identifier used in templates and future CLI options. */
  name: string;
  /** Human-readable label shown by `cleanstack extensions list`. */
  label?: string;
  /**
   * Built-in template root this framework renders from. CleanStack ships one
   * framework built-in (`angular`); new frameworks join by registering here and
   * providing a template pack through the ordinary template override system.
   */
  templateRoot?: string;
}

/**
 * The object an extension passes to {@link CleanStackExtension.register}.
 *
 * The registry is intentionally tiny: two registration points cover the
 * extension points the generator currently defines.
 */
export interface ExtensionRegistry {
  /** Adds a field type. Duplicate and built-in names are rejected. */
  registerFieldType(definition: FieldTypeDefinition): void;
  /** Adds a frontend framework. Duplicate and built-in names are rejected. */
  registerFrontendFramework(definition: FrontendFrameworkDefinition): void;
  /** Returns a registered extension field type by its descriptor name. */
  getFieldType(name: string): FieldTypeDefinition | undefined;
  /** Returns a registered frontend framework by its identifier. */
  getFrontendFramework(name: string): FrontendFrameworkDefinition | undefined;
  /** Lists every registered extension field type name. */
  fieldTypeNames(): string[];
  /** Lists every registered frontend framework definition. */
  frontendFrameworks(): FrontendFrameworkDefinition[];
}

/** A field type after filling definition defaults. */
export interface ResolvedFieldType {
  name: string;
  javaType: string;
  javaImports: readonly string[];
  typescriptType: string;
  typescriptDefault: string;
  kind: FieldKind;
  /** SQL column type for a field of this type and database. */
  sqlTypeFor(field: FieldSqlContext, database: SqlDatabase): string;
}

/** The callable shape a compatible module exports. */
export interface CleanStackExtension {
  /** Shown by `cleanstack extensions list`. */
  name: string;
  /** Called once when the extension is loaded, before descriptor parsing. */
  register(registry: ExtensionRegistry): void;
}

/** What `extensions` entries may specify: an npm package name or a file path. */
export type ExtensionSpecifier = string;
