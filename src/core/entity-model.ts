import type { EntityConfig, FieldConfig, RelationConfig } from './config.js';
import { resolveActiveFieldType } from './extensions/registry.js';

const PRIMITIVE_JAVA_TYPES = new Set([
  'boolean',
  'byte',
  'short',
  'int',
  'long',
  'float',
  'double',
]);

export interface EntityFieldModel extends FieldConfig {
  /** Java type name used by backend generators. */
  javaType: string;
  /** TypeScript type name used by frontend generators. */
  typescriptType: string;
  /** TypeScript literal used when an optional value is absent, for example `''` or `false`. */
  typescriptDefault: string;
  /** Snake-case database column name. */
  columnName: string;
  /** JavaBean getter, using `isX` for primitive booleans and `getX` otherwise. */
  javaGetter: string;
  /** Jakarta Bean Validation annotations using simple names, for example `@NotNull`. */
  validationAnnotations: string[];
  /** Expression that initializes a server-generated field, when the type is known. */
  generatedExpression: string | undefined;
  /** True when the generated value is refreshed before every update. */
  generatedOnUpdate: boolean;
}

/** A request DTO record component, already rendered with validation annotations. */
export interface RequestParameterModel {
  name: string;
  declaration: string;
}

/** Normalized metadata for the entity on the other side of a relation. */
export interface RelationTargetModel {
  name: string;
  className: string;
  variableName: string;
  pluralName: string;
  pluralVariableName: string;
  routeName: string;
  tableName: string;
  /** Field used for human-readable labels in DTOs and Angular selects, if any. */
  labelField: string | undefined;
  /** Java getter for the label field, for example `getName`. */
  labelGetter: string | undefined;
}

export interface ResolvedRelationModel extends RelationConfig {
  className: string;
  variableName: string;
  targetEntity: RelationTargetModel;
  collection: boolean;
  owningSide: boolean;
  /** Value emitted as `mappedBy` on the inverse side of a bidirectional relation. */
  mappedByField: string | undefined;
  /** Java type, for example `Category` or `List<Tag>`. */
  javaType: string;
  /** Singular camel-case name used for generated id and label properties. */
  singularVariableName: string;
  /** DTO and Angular form property holding the related id, for example `categoryId`. */
  idField: string;
  /** DTO and Angular property holding the related label, for example `categoryLabel`. */
  labelField: string;
  /** Foreign key column on the owning entity, for example `category_id`. */
  joinColumnName: string;
  /** Join table for the owning side of a many-to-many relation. */
  joinTableName: string;
  joinTableJoinColumn: string;
  joinTableInverseColumn: string;
  /** Angular signal holding select options for this relation. */
  optionsSignalName: string;
}

export interface RelationColumnModel {
  columnName: string;
  constraintName: string;
  targetTable: string;
  required: boolean;
  unique: boolean;
}

export interface JoinTableModel {
  name: string;
  joinColumn: string;
  inverseColumn: string;
  ownerTable: string;
  targetTable: string;
}

export interface MapperRepositoryModel {
  className: string;
  variableName: string;
}

export interface FormOptionSourceModel {
  className: string;
  variableName: string;
  pluralName: string;
  serviceName: string;
  optionsSignalName: string;
  labelField: string | undefined;
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
  /** Fields accepted from HTTP requests; server-generated fields are excluded. */
  inputFields: EntityFieldModel[];
  /** Server-generated fields, populated by the entity lifecycle callbacks. */
  generatedFields: EntityFieldModel[];
  /** Request DTO components in declaration order. */
  requestParameters: RequestParameterModel[];
  hasGeneratedLifecycle: boolean;
  hasGeneratedUpdates: boolean;
  relations: ResolvedRelationModel[];
  owningRelations: ResolvedRelationModel[];
  displayField: EntityFieldModel | undefined;
  hasRelations: boolean;
  hasCollections: boolean;
  hasOwningCollections: boolean;
  hasOwningSingles: boolean;
  /** Jakarta Persistence and collection imports required by the entity's relations. */
  persistenceImports: string[];
  /** Sorted imports for the JPA entity. */
  domainImports: string[];
  /** Sorted imports for the request DTO. */
  requestImports: string[];
  /** Sorted imports for the response DTO. */
  responseImports: string[];
  relationColumns: RelationColumnModel[];
  joinTables: JoinTableModel[];
  mapperRepositories: MapperRepositoryModel[];
  formOptionSources: FormOptionSourceModel[];
}

interface EntityBase extends Omit<EntityModel, 'relations' | 'owningRelations'> {
  relations: never[];
}

export function buildEntityModels(entities: EntityConfig[]): EntityModel[] {
  const normalized = new Map<string, EntityBase>();
  const configs = new Map(entities.map((entity) => [entity.name.toLowerCase(), entity]));

  for (const entity of entities) {
    const className = toPascalCase(entity.name);
    const pluralClassName = pluralize(className);
    const tableName = entity.tableName ?? toSnakeCase(pluralClassName);
    const fields = entity.fields.map((field) => normalizeField(field));
    normalized.set(entity.name.toLowerCase(), {
      ...entity,
      className,
      variableName: toCamelCase(className),
      pluralName: pluralClassName,
      pluralClassName,
      pluralVariableName: toCamelCase(pluralClassName),
      routeName: toKebabCase(pluralClassName),
      tableName,
      fields,
      inputFields: [],
      generatedFields: [],
      requestParameters: [],
      hasGeneratedLifecycle: false,
      hasGeneratedUpdates: false,
      relations: [],
      displayField: chooseDisplayField(fields),
      hasRelations: false,
      hasCollections: false,
      hasOwningCollections: false,
      hasOwningSingles: false,
      persistenceImports: [],
      domainImports: [],
      requestImports: [],
      responseImports: [],
      relationColumns: [],
      joinTables: [],
      mapperRepositories: [],
      formOptionSources: [],
    });
  }

  const relationSets = new Map<string, ResolvedRelationModel[]>();
  for (const entity of entities) {
    const source = normalized.get(entity.name.toLowerCase())!;
    relationSets.set(
      entity.name.toLowerCase(),
      entity.relations.map((relation) => resolveRelation(source, relation, normalized)),
    );
  }

  for (const entity of entities) {
    const relations = relationSets.get(entity.name.toLowerCase())!;
    for (const relation of relations) {
      if (relation.owningSide) continue;
      relation.mappedByField = relation.mappedBy ?? inferMappedBy(entity, relation, configs);
      assertMappedByField(entity, relation, configs);
    }
  }

  return entities.map((entity) => {
    const source = normalized.get(entity.name.toLowerCase())!;
    const relations = relationSets.get(entity.name.toLowerCase())!;
    const owningRelations = relations.filter((relation) => relation.owningSide);
    const inputFields = source.fields.filter((field) => !field.generated);
    const generatedFields = source.fields.filter((field) => field.generated);
    const fieldImports = buildFieldImports(source.fields);
    const inputFieldImports = buildFieldImports(inputFields);
    const persistenceImports = buildPersistenceImports(relations);
    const hasOwningCollections = owningRelations.some((relation) => relation.collection);
    const hasOwningSingles = owningRelations.some((relation) => !relation.collection);
    const hasGeneratedLifecycle = generatedFields.some(
      (field) => field.generatedExpression !== undefined,
    );
    const hasGeneratedUpdates = generatedFields.some((field) => field.generatedOnUpdate);
    const validationImports = buildValidationImports(inputFields, owningRelations);

    return {
      ...source,
      relations,
      owningRelations,
      inputFields,
      generatedFields,
      requestParameters: buildRequestParameters(inputFields, owningRelations),
      hasGeneratedLifecycle,
      hasGeneratedUpdates,
      hasRelations: relations.length > 0,
      hasCollections: relations.some((relation) => relation.collection),
      hasOwningCollections,
      hasOwningSingles,
      persistenceImports,
      domainImports: sortImports([
        'jakarta.persistence.Column',
        'jakarta.persistence.Entity',
        'jakarta.persistence.GeneratedValue',
        'jakarta.persistence.GenerationType',
        'jakarta.persistence.Id',
        'jakarta.persistence.Table',
        ...(hasGeneratedLifecycle ? ['jakarta.persistence.PrePersist'] : []),
        ...(hasGeneratedUpdates ? ['jakarta.persistence.PreUpdate'] : []),
        ...persistenceImports,
        ...fieldImports,
        'java.util.UUID',
      ]),
      requestImports: sortImports([
        ...(hasOwningCollections ? ['java.util.List'] : []),
        ...(hasOwningSingles ? ['java.util.UUID'] : []),
        ...inputFieldImports,
        ...validationImports,
      ]),
      responseImports: sortImports([
        'java.util.UUID',
        ...(relations.some((relation) => relation.collection) ? ['java.util.List'] : []),
        ...fieldImports,
      ]),
      relationColumns: owningRelations
        .filter((relation) => !relation.collection)
        .map((relation) => ({
          columnName: relation.joinColumnName,
          constraintName: `fk_${source.tableName}_${relation.joinColumnName}`,
          targetTable: relation.targetEntity.tableName,
          required: relation.required,
          unique: relation.type === 'one-to-one',
        })),
      joinTables: owningRelations
        .filter((relation) => relation.type === 'many-to-many')
        .map((relation) => ({
          name: relation.joinTableName,
          joinColumn: relation.joinTableJoinColumn,
          inverseColumn: relation.joinTableInverseColumn,
          ownerTable: source.tableName,
          targetTable: relation.targetEntity.tableName,
        })),
      mapperRepositories: uniqueRepositories(owningRelations),
      formOptionSources: uniqueFormOptionSources(owningRelations),
    };
  });
}

function resolveRelation(
  source: EntityBase,
  relation: RelationConfig,
  normalized: Map<string, EntityBase>,
): ResolvedRelationModel {
  const target = normalized.get(relation.target.toLowerCase());
  if (!target) {
    throw new Error(`Relation "${relation.field}" targets unknown entity "${relation.target}".`);
  }

  const collection = relation.type === 'one-to-many' || relation.type === 'many-to-many';
  const owningSide = isOwningRelation(relation);
  const singularVariableName = toSingularCamelCase(relation.field);
  const entityStem = singularSnakeCase(source.tableName);
  const targetStem = singularSnakeCase(target.tableName);
  const selfRelation = target.tableName === source.tableName;

  return {
    ...relation,
    className: toPascalCase(relation.field),
    variableName: toCamelCase(relation.field),
    targetEntity: {
      name: target.name,
      className: target.className,
      variableName: target.variableName,
      pluralName: target.pluralName,
      pluralVariableName: target.pluralVariableName,
      routeName: target.routeName,
      tableName: target.tableName,
      labelField: target.displayField?.name,
      labelGetter: target.displayField === undefined ? undefined : getterName(target.displayField),
    },
    collection,
    owningSide,
    mappedByField: undefined,
    javaType: collection ? `List<${target.className}>` : target.className,
    singularVariableName,
    idField: `${singularVariableName}${collection ? 'Ids' : 'Id'}`,
    labelField: `${singularVariableName}${collection ? 'Labels' : 'Label'}`,
    joinColumnName: `${toSnakeCase(relation.field)}_id`,
    joinTableName: `${source.tableName}_${target.tableName}`,
    joinTableJoinColumn: selfRelation ? `${entityStem}_source_id` : `${entityStem}_id`,
    joinTableInverseColumn: selfRelation ? `${targetStem}_target_id` : `${targetStem}_id`,
    optionsSignalName: `${target.variableName}Options`,
  };
}

function isOwningRelation(relation: RelationConfig): boolean {
  if (relation.type === 'one-to-many') return false;
  if (relation.type === 'many-to-one') return true;
  return !relation.inverse && relation.mappedBy === undefined;
}

function inferMappedBy(
  entity: EntityConfig,
  relation: ResolvedRelationModel,
  configs: Map<string, EntityConfig>,
): string {
  const target = configs.get(relation.target.toLowerCase())!;
  const complementaryType = relation.type === 'one-to-many' ? 'many-to-one' : relation.type;

  const candidates = target.relations.filter(
    (candidate) =>
      candidate.target.toLowerCase() === entity.name.toLowerCase() &&
      candidate.type === complementaryType &&
      isOwningRelation(candidate),
  );

  if (candidates.length === 1) return candidates[0]!.field;

  if (candidates.length === 0) {
    throw new Error(
      `Relation "${relation.field}" on "${entity.name}" is the inverse side of a ${relation.type} and needs a "mappedBy" value; "${target.name}" has no matching ${complementaryType} relation back to "${entity.name}".`,
    );
  }

  throw new Error(
    `Relation "${relation.field}" on "${entity.name}" needs an explicit "mappedBy" value because "${target.name}" has more than one matching relation (${candidates
      .map((candidate) => `"${candidate.field}"`)
      .join(', ')}).`,
  );
}

function assertMappedByField(
  entity: EntityConfig,
  relation: ResolvedRelationModel,
  configs: Map<string, EntityConfig>,
): void {
  const target = configs.get(relation.target.toLowerCase())!;
  const mappedByField = relation.mappedByField!;
  if (!target.relations.some((candidate) => candidate.field === mappedByField)) {
    throw new Error(
      `Relation "${relation.field}" on "${entity.name}" uses mappedBy "${mappedByField}", but "${target.name}" has no relation named "${mappedByField}".`,
    );
  }
}

function buildFieldImports(fields: EntityFieldModel[]): string[] {
  const imports = new Set<string>();
  for (const field of fields) {
    for (const importPath of resolveActiveFieldType(field.type)?.javaImports ?? []) {
      imports.add(importPath);
    }
    switch (field.javaType) {
      case 'BigDecimal':
        imports.add('java.math.BigDecimal');
        break;
      case 'BigInteger':
        imports.add('java.math.BigInteger');
        break;
      case 'UUID':
        imports.add('java.util.UUID');
        break;
      case 'Instant':
        imports.add('java.time.Instant');
        break;
      case 'LocalDate':
        imports.add('java.time.LocalDate');
        break;
      case 'LocalTime':
        imports.add('java.time.LocalTime');
        break;
      case 'LocalDateTime':
        imports.add('java.time.LocalDateTime');
        break;
      case 'OffsetDateTime':
        imports.add('java.time.OffsetDateTime');
        break;
      default:
        break;
    }
  }
  return [...imports];
}

function sortImports(imports: string[]): string[] {
  const group = (value: string): number => {
    if (value.startsWith('jakarta.')) return 0;
    if (value.startsWith('java.')) return 1;
    return 2;
  };
  return [...new Set(imports)].sort(
    (left, right) => group(left) - group(right) || left.localeCompare(right),
  );
}

function buildPersistenceImports(relations: ResolvedRelationModel[]): string[] {
  const imports = new Set<string>();
  for (const relation of relations) {
    if (relation.collection) {
      imports.add('jakarta.persistence.FetchType');
      imports.add('java.util.ArrayList');
      imports.add('java.util.List');
    }
    if (relation.type === 'many-to-one') {
      imports.add('jakarta.persistence.JoinColumn');
      imports.add('jakarta.persistence.ManyToOne');
    }
    if (relation.type === 'one-to-many') {
      imports.add('jakarta.persistence.OneToMany');
    }
    if (relation.type === 'one-to-one') {
      imports.add('jakarta.persistence.OneToOne');
      if (relation.owningSide) imports.add('jakarta.persistence.JoinColumn');
    }
    if (relation.type === 'many-to-many') {
      imports.add('jakarta.persistence.ManyToMany');
      if (relation.owningSide) imports.add('jakarta.persistence.JoinTable');
    }
  }
  return [...imports].sort();
}

function uniqueRepositories(relations: ResolvedRelationModel[]): MapperRepositoryModel[] {
  const repositories = new Map<string, MapperRepositoryModel>();
  for (const relation of relations) {
    const className = relation.targetEntity.className;
    if (repositories.has(className)) continue;
    repositories.set(className, {
      className,
      variableName: `${relation.targetEntity.variableName}Repository`,
    });
  }
  return [...repositories.values()];
}

function uniqueFormOptionSources(relations: ResolvedRelationModel[]): FormOptionSourceModel[] {
  const sources = new Map<string, FormOptionSourceModel>();
  for (const relation of relations) {
    const target = relation.targetEntity;
    if (sources.has(target.className)) continue;
    sources.set(target.className, {
      className: target.className,
      variableName: target.variableName,
      pluralName: target.pluralName,
      serviceName: `${target.className}Service`,
      optionsSignalName: relation.optionsSignalName,
      labelField: target.labelField,
    });
  }
  return [...sources.values()];
}

function chooseDisplayField(fields: EntityFieldModel[]): EntityFieldModel | undefined {
  const stringFields = fields.filter((field) => field.javaType === 'String' && !field.generated);
  const preferred = ['name', 'title', 'label', 'code', 'slug'];
  for (const candidate of preferred) {
    const field = stringFields.find((item) => item.name.toLowerCase() === candidate);
    if (field) return field;
  }
  return stringFields[0] ?? fields.find((field) => field.javaType === 'String');
}

function normalizeField(field: FieldConfig): EntityFieldModel {
  const custom = resolveActiveFieldType(field.type);
  const javaType = custom?.javaType ?? field.type;
  const typescriptType = custom?.typescriptType ?? toTypeScriptType(javaType);
  const generatedExpression = field.generated ? generatedExpressionFor(javaType) : undefined;
  const generatedOnUpdate =
    generatedExpression !== undefined && field.generated && isUpdatedFieldName(field.name);
  return {
    ...field,
    javaType,
    typescriptType,
    typescriptDefault: custom?.typescriptDefault ?? toTypeScriptDefault(typescriptType),
    columnName: toSnakeCase(field.name),
    javaGetter: javaGetterFor(field.name, javaType),
    validationAnnotations: buildValidationAnnotations(field),
    generatedExpression,
    generatedOnUpdate,
  };
}

function javaGetterFor(fieldName: string, javaType: string): string {
  const suffix = fieldName[0]!.toUpperCase() + fieldName.slice(1);
  return javaType === 'boolean' ? `is${suffix}` : `get${suffix}`;
}

/** Returns a deterministic initializer for server-generated field types. */
function generatedExpressionFor(javaType: string): string | undefined {
  switch (javaType) {
    case 'Instant':
      return 'Instant.now()';
    case 'LocalDate':
      return 'LocalDate.now()';
    case 'LocalTime':
      return 'LocalTime.now()';
    case 'LocalDateTime':
      return 'LocalDateTime.now()';
    case 'OffsetDateTime':
      return 'OffsetDateTime.now()';
    case 'UUID':
      return 'UUID.randomUUID()';
    default:
      return undefined;
  }
}

/** True for generated fields that represent the last modification time. */
function isUpdatedFieldName(fieldName: string): boolean {
  return /^(updated|modified|lastModified|changed)/i.test(fieldName);
}

function buildValidationImports(
  fields: EntityFieldModel[],
  owningRelations: ResolvedRelationModel[],
): string[] {
  const imports = new Set<string>();
  for (const field of fields) {
    for (const annotation of field.validationAnnotations) {
      const name = /^@([A-Za-z][A-Za-z0-9]*)/.exec(annotation)?.[1];
      if (name !== undefined) imports.add(`jakarta.validation.constraints.${name}`);
    }
  }
  if (owningRelations.some((relation) => !relation.collection && relation.required)) {
    imports.add('jakarta.validation.constraints.NotNull');
  }
  return [...imports];
}

function buildRequestParameters(
  fields: EntityFieldModel[],
  owningRelations: ResolvedRelationModel[],
): RequestParameterModel[] {
  const parameters = fields.map((field) => ({
    name: field.name,
    declaration: `${field.validationAnnotations.map((annotation) => `${annotation} `).join('')}${field.javaType} ${field.name}`,
  }));
  for (const relation of owningRelations) {
    if (relation.collection) {
      parameters.push({ name: relation.idField, declaration: `List<UUID> ${relation.idField}` });
    } else {
      const annotation = relation.required ? '@NotNull ' : '';
      parameters.push({
        name: relation.idField,
        declaration: `${annotation}UUID ${relation.idField}`,
      });
    }
  }
  return parameters;
}

function toTypeScriptDefault(typescriptType: string): string {
  if (typescriptType === 'boolean') return 'false';
  if (typescriptType === 'number') return '0';
  return "''";
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
  const javaType = resolveActiveFieldType(field.type)?.javaType ?? field.type;
  const primitive = PRIMITIVE_JAVA_TYPES.has(javaType);
  if (field.required && !primitive) annotations.add('@NotNull');
  for (const validation of field.validations) {
    annotations.add(`@${validation}`);
  }
  const lengthParts: string[] = [];
  if (field.minLength !== undefined) lengthParts.push(`min = ${field.minLength}`);
  if (field.maxLength !== undefined) lengthParts.push(`max = ${field.maxLength}`);
  if (lengthParts.length > 0) {
    annotations.add(`@Size(${lengthParts.join(', ')})`);
  }
  if (field.min !== undefined) {
    annotations.add(`@DecimalMin("${escapeJavaString(String(field.min))}")`);
  }
  if (field.max !== undefined) {
    annotations.add(`@DecimalMax("${escapeJavaString(String(field.max))}")`);
  }
  if (field.pattern !== undefined) {
    annotations.add(`@Pattern(regexp = "${escapeJavaString(field.pattern)}")`);
  }
  return [...annotations];
}

function escapeJavaString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function getterName(field: EntityFieldModel): string {
  return field.javaGetter;
}

function toPascalCase(value: string): string {
  return words(value)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(value: string): string {
  return camelWords(words(value));
}

function toSingularCamelCase(value: string): string {
  const parts = words(value);
  if (parts.length === 0) return value;
  parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]!);
  return camelWords(parts);
}

function camelWords(parts: string[]): string {
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

function singularSnakeCase(value: string): string {
  const parts = words(value);
  if (parts.length === 0) return toSnakeCase(value);
  parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]!);
  return parts.map((word) => word.toLowerCase()).join('_');
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

function singularizeWord(value: string): string {
  const irregular: Record<string, string> = {
    children: 'child',
    feet: 'foot',
    mice: 'mouse',
    people: 'person',
  };
  const lower = value.toLowerCase();
  if (irregular[lower]) return preserveInitialCase(value, irregular[lower]!);
  if (/ies$/i.test(value)) return `${value.slice(0, -3)}y`;
  if (/(ss|us|is)$/i.test(value)) return value;
  if (/(ch|sh|x|z|s)es$/i.test(value)) return value.slice(0, -2);
  if (/s$/i.test(value)) return value.slice(0, -1);
  return value;
}

function preserveInitialCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
