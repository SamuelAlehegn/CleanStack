import type { EntityConfig, FieldConfig, RelationConfig } from './config.js';

export interface EntityFieldModel extends FieldConfig {
  /** Java type name used by backend generators. */
  javaType: string;
  /** TypeScript type name used by frontend generators. */
  typescriptType: string;
  /** Snake-case database column name. */
  columnName: string;
  /** Fully qualified Jakarta Bean Validation annotations. */
  validationAnnotations: string[];
}

export interface ResolvedRelationModel extends RelationConfig {
  className: string;
  variableName: string;
  targetEntity: {
    name: string;
    className: string;
    variableName: string;
    tableName: string;
  };
  collection: boolean;
  owningSide: boolean;
}

/** Normalized entity metadata shared by backend, persistence, and frontend generators. */
export interface EntityModel extends Omit<EntityConfig, 'tableName' | 'fields' | 'relations'> {
  className: string;
  variableName: string;
  pluralName: string;
  pluralClassName: string;
  pluralVariableName: string;
  routeName: string;
  tableName: string;
  fields: EntityFieldModel[];
  relations: ResolvedRelationModel[];
}

export function buildEntityModels(entities: EntityConfig[]): EntityModel[] {
  const normalized = new Map<string, Omit<EntityModel, 'relations'>>();

  for (const entity of entities) {
    const className = toPascalCase(entity.name);
    const pluralClassName = pluralize(className);
    const tableName = entity.tableName ?? toSnakeCase(pluralClassName);
    normalized.set(entity.name.toLowerCase(), {
      ...entity,
      className,
      variableName: toCamelCase(className),
      pluralName: pluralClassName,
      pluralClassName,
      pluralVariableName: toCamelCase(pluralClassName),
      routeName: toKebabCase(pluralClassName),
      tableName,
      fields: entity.fields.map((field) => normalizeField(field)),
    });
  }

  return entities.map((entity) => {
    const source = normalized.get(entity.name.toLowerCase())!;
    const relations = entity.relations.map((relation) => {
      const target = normalized.get(relation.target.toLowerCase());
      if (!target) {
        throw new Error(
          `Relation "${relation.field}" targets unknown entity "${relation.target}".`,
        );
      }
      const className = toPascalCase(relation.field);
      const collection = relation.type === 'one-to-many' || relation.type === 'many-to-many';
      return {
        ...relation,
        className,
        variableName: toCamelCase(relation.field),
        targetEntity: {
          name: target.name,
          className: target.className,
          variableName: target.variableName,
          tableName: target.tableName,
        },
        collection,
        owningSide: !relation.inverse && relation.type !== 'one-to-many',
      };
    });
    return { ...source, relations };
  });
}

function normalizeField(field: FieldConfig): EntityFieldModel {
  return {
    ...field,
    javaType: field.type,
    typescriptType: toTypeScriptType(field.type),
    columnName: toSnakeCase(field.name),
    validationAnnotations: buildValidationAnnotations(field),
  };
}

function toTypeScriptType(javaType: string): string {
  if (
    javaType === 'String' ||
    javaType === 'UUID' ||
    javaType === 'Instant' ||
    javaType.startsWith('Local') ||
    javaType === 'OffsetDateTime'
  ) {
    return 'string';
  }
  if (javaType === 'boolean' || javaType === 'Boolean') return 'boolean';
  if (javaType === 'BigDecimal' || javaType === 'BigInteger') return 'string';
  return 'number';
}

function buildValidationAnnotations(field: FieldConfig): string[] {
  const annotations = new Set<string>();
  if (field.required) annotations.add('@jakarta.validation.constraints.NotNull');
  for (const validation of field.validations) {
    annotations.add(`@jakarta.validation.constraints.${validation}`);
  }
  const lengthParts: string[] = [];
  if (field.minLength !== undefined) lengthParts.push(`min = ${field.minLength}`);
  if (field.maxLength !== undefined) lengthParts.push(`max = ${field.maxLength}`);
  if (lengthParts.length > 0) {
    annotations.add(`@jakarta.validation.constraints.Size(${lengthParts.join(', ')})`);
  }
  if (field.min !== undefined) {
    annotations.add(
      `@jakarta.validation.constraints.DecimalMin("${escapeJavaString(String(field.min))}")`,
    );
  }
  if (field.max !== undefined) {
    annotations.add(
      `@jakarta.validation.constraints.DecimalMax("${escapeJavaString(String(field.max))}")`,
    );
  }
  if (field.pattern !== undefined) {
    annotations.add(
      `@jakarta.validation.constraints.Pattern(regexp = "${escapeJavaString(field.pattern)}")`,
    );
  }
  return [...annotations];
}

function escapeJavaString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function toPascalCase(value: string): string {
  return words(value)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(value: string): string {
  const parts = words(value);
  return parts
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('');
}

function toSnakeCase(value: string): string {
  return words(value)
    .map((word) => word.toLowerCase())
    .join('_');
}

function toKebabCase(value: string): string {
  return words(value)
    .map((word) => word.toLowerCase())
    .join('-');
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function pluralize(value: string): string {
  const irregular: Record<string, string> = {
    child: 'children',
    foot: 'feet',
    mouse: 'mice',
    person: 'people',
  };
  const lower = value.toLowerCase();
  if (irregular[lower]) return preserveInitialCase(value, irregular[lower]!);
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/fe$/i.test(value)) return `${value.slice(0, -2)}ves`;
  if (/f$/i.test(value)) return `${value.slice(0, -1)}ves`;
  return `${value}s`;
}

function preserveInitialCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
