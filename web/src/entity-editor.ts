import type { EntityConfig, FieldConfig, RelationConfig } from '../../src/core/config';
import type {
  EntityDefinitionRequest,
  EntityFieldRequest,
  EntityRelationRequest,
} from '../../src/web/contracts';

export type FieldType = EntityFieldRequest['type'];
export type RelationType = RelationConfig['type'];

export interface FieldRow {
  key: string;
  name: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  generated: boolean;
  minLength: string;
  maxLength: string;
  min: string;
  max: string;
  pattern: string;
  validations: string[];
  /** Preserved from an existing descriptor but not edited in the form yet. */
  defaultValue?: unknown;
}

export interface RelationRow {
  key: string;
  field: string;
  type: RelationType;
  target: string;
  required: boolean;
  mappedBy: string;
  inverse: boolean;
}

export interface EntityDraft {
  name: string;
  tableName: string;
  fields: FieldRow[];
  relations: RelationRow[];
}

export const RELATION_TYPES: Array<{
  value: RelationType;
  label: string;
  hint: string;
}> = [
  {
    value: 'many-to-one',
    label: 'Many to one',
    hint: 'Many records point at one related record, for example Product → Category.',
  },
  {
    value: 'one-to-many',
    label: 'One to many',
    hint: 'One record owns a collection, for example Category → Products.',
  },
  {
    value: 'one-to-one',
    label: 'One to one',
    hint: 'Each record has at most one related record, for example User ↔ Profile.',
  },
  {
    value: 'many-to-many',
    label: 'Many to many',
    hint: 'Both sides can reference a collection, for example Products ↔ Tags.',
  },
];

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const NUMERIC_TYPES = new Set<FieldType>([
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
]);

const TEMPORAL_TYPES = new Set<FieldType>([
  'LocalDate',
  'LocalTime',
  'LocalDateTime',
  'OffsetDateTime',
  'Instant',
]);

let nextFieldKey = 0;
let nextRelationKey = 0;

function fieldKey(): string {
  nextFieldKey += 1;
  return `field-${nextFieldKey}`;
}

function relationKey(): string {
  nextRelationKey += 1;
  return `relation-${nextRelationKey}`;
}

export function blankField(overrides: Partial<FieldRow> = {}): FieldRow {
  return {
    key: fieldKey(),
    name: '',
    type: 'String',
    required: false,
    unique: false,
    generated: false,
    minLength: '',
    maxLength: '',
    min: '',
    max: '',
    pattern: '',
    validations: [],
    ...overrides,
  };
}

export function blankRelation(overrides: Partial<RelationRow> = {}): RelationRow {
  return {
    key: relationKey(),
    field: '',
    type: 'many-to-one',
    target: '',
    required: false,
    mappedBy: '',
    inverse: false,
    ...overrides,
  };
}

export function emptyDraft(): EntityDraft {
  return {
    name: '',
    tableName: '',
    fields: [blankField()],
    relations: [],
  };
}

export function draftFromEntity(entity: EntityConfig): EntityDraft {
  return {
    name: entity.name,
    tableName: entity.tableName ?? '',
    fields: entity.fields.length === 0 ? [blankField()] : entity.fields.map(fieldRowFromConfig),
    relations: entity.relations.map(relationRowFromConfig),
  };
}

function fieldRowFromConfig(field: FieldConfig): FieldRow {
  return {
    key: fieldKey(),
    name: field.name,
    type: field.type,
    required: field.required,
    unique: field.unique,
    generated: field.generated,
    minLength: field.minLength === undefined ? '' : String(field.minLength),
    maxLength: field.maxLength === undefined ? '' : String(field.maxLength),
    min: field.min === undefined ? '' : String(field.min),
    max: field.max === undefined ? '' : String(field.max),
    pattern: field.pattern ?? '',
    validations: [...field.validations],
    ...(field.default === undefined ? {} : { defaultValue: field.default }),
  };
}

function relationRowFromConfig(relation: RelationConfig): RelationRow {
  return {
    key: relationKey(),
    field: relation.field,
    type: relation.type,
    target: relation.target,
    required: relation.required,
    mappedBy: relation.mappedBy ?? '',
    inverse: relation.inverse,
  };
}

export function isStringFieldType(type: FieldType): boolean {
  return type === 'String';
}

export function isNumericFieldType(type: FieldType): boolean {
  return NUMERIC_TYPES.has(type);
}

export function isTemporalFieldType(type: FieldType): boolean {
  return TEMPORAL_TYPES.has(type);
}

export function isValidationApplicable(type: FieldType, validation: string): boolean {
  switch (validation) {
    case 'NotBlank':
    case 'Email':
      return isStringFieldType(type);
    case 'Positive':
    case 'PositiveOrZero':
    case 'Negative':
    case 'NegativeOrZero':
      return isNumericFieldType(type);
    case 'Past':
    case 'PastOrPresent':
    case 'Future':
    case 'FutureOrPresent':
      return isTemporalFieldType(type);
    default:
      return false;
  }
}

export function validationOptionsForType(type: FieldType, available: readonly string[]): string[] {
  return available.filter((validation) => isValidationApplicable(type, validation));
}

export function applicableValidations(
  type: FieldType,
  validations: readonly string[],
  available: readonly string[],
): string[] {
  return validations.filter(
    (validation) => available.includes(validation) && isValidationApplicable(type, validation),
  );
}

/** Returns the first problem that prevents the draft from being sent to the engine. */
export function validateDraft(draft: EntityDraft): string | null {
  const name = draft.name.trim();
  if (!IDENTIFIER_PATTERN.test(name)) {
    return 'Entity names must be valid identifiers, for example Product.';
  }
  if (draft.fields.length === 0) {
    return 'Add at least one field before generating an entity.';
  }

  const fieldNames = new Set<string>();
  for (const [index, field] of draft.fields.entries()) {
    const fieldName = field.name.trim();
    if (!IDENTIFIER_PATTERN.test(fieldName)) {
      return `Field ${index + 1} needs a valid identifier name, for example productName.`;
    }
    if (fieldNames.has(fieldName.toLowerCase())) {
      return `The field "${fieldName}" is defined more than once.`;
    }
    fieldNames.add(fieldName.toLowerCase());

    const hasStringConstraints =
      field.minLength.trim() !== '' || field.maxLength.trim() !== '' || field.pattern.trim() !== '';
    if (hasStringConstraints && !isStringFieldType(field.type)) {
      return `Min length, max length, and pattern only apply to String fields, not "${fieldName}".`;
    }
    const hasNumericConstraints = field.min.trim() !== '' || field.max.trim() !== '';
    if (hasNumericConstraints && !isNumericFieldType(field.type)) {
      return `Min and max only apply to numeric fields, not "${fieldName}".`;
    }

    const minLength = parseInteger(field.minLength);
    if (minLength === null) {
      return `Min length for "${fieldName}" must be a non-negative whole number.`;
    }
    const maxLength = parseInteger(field.maxLength);
    if (maxLength === null || (maxLength !== undefined && maxLength <= 0)) {
      return `Max length for "${fieldName}" must be a positive whole number.`;
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      return `Min length cannot be greater than max length for "${fieldName}".`;
    }

    const min = parseNumber(field.min);
    if (min === null) {
      return `Min for "${fieldName}" must be a number.`;
    }
    const max = parseNumber(field.max);
    if (max === null) {
      return `Max for "${fieldName}" must be a number.`;
    }
    if (min !== undefined && max !== undefined && min > max) {
      return `Min cannot be greater than max for "${fieldName}".`;
    }
  }

  const relationNames = new Set<string>();
  for (const [index, relation] of draft.relations.entries()) {
    const relationName = relation.field.trim();
    if (!IDENTIFIER_PATTERN.test(relationName)) {
      return `Relation ${index + 1} needs a valid field name, for example category.`;
    }
    if (relationNames.has(relationName.toLowerCase())) {
      return `The relation "${relationName}" is defined more than once.`;
    }
    relationNames.add(relationName.toLowerCase());
    if (fieldNames.has(relationName.toLowerCase())) {
      return `The relation "${relationName}" conflicts with a field of the same name.`;
    }
    if (!IDENTIFIER_PATTERN.test(relation.target.trim())) {
      return `Relation "${relationName}" needs a valid target entity name.`;
    }
  }

  return null;
}

function parseInteger(value: string): number | undefined | null {
  if (value.trim() === '') return undefined;
  if (!/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

function parseNumber(value: string): number | undefined | null {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toEntityDefinition(draft: EntityDraft): EntityDefinitionRequest {
  const fields: EntityFieldRequest[] = draft.fields.map((field) => {
    const prepared: EntityFieldRequest = {
      name: field.name.trim(),
      type: field.type,
    };
    if (field.required) prepared.required = true;
    if (field.unique) prepared.unique = true;
    if (field.generated) prepared.generated = true;
    if (field.minLength.trim() !== '') prepared.minLength = Number(field.minLength);
    if (field.maxLength.trim() !== '') prepared.maxLength = Number(field.maxLength);
    if (field.min.trim() !== '') prepared.min = Number(field.min);
    if (field.max.trim() !== '') prepared.max = Number(field.max);
    if (field.pattern.trim() !== '') prepared.pattern = field.pattern.trim();
    if (field.validations.length > 0) {
      prepared.validations = [...field.validations] as FieldConfig['validations'];
    }
    if (field.defaultValue !== undefined) prepared.default = field.defaultValue;
    return prepared;
  });

  const relations: EntityRelationRequest[] = draft.relations.map((relation) => {
    const prepared: EntityRelationRequest = {
      field: relation.field.trim(),
      type: relation.type,
      target: relation.target.trim(),
    };
    if (relation.required) prepared.required = true;
    if (relation.mappedBy.trim() !== '') prepared.mappedBy = relation.mappedBy.trim();
    if (relation.inverse) prepared.inverse = true;
    return prepared;
  });

  const definition: EntityDefinitionRequest = {
    name: draft.name.trim(),
    fields,
    relations,
  };
  if (draft.tableName.trim() !== '') definition.tableName = draft.tableName.trim();
  return definition;
}

/** True when the relation owns the join column and can be marked required. */
export function relationOwnsColumn(relation: RelationRow): boolean {
  if (relation.type === 'one-to-many') return false;
  if (relation.type === 'many-to-one') return true;
  return !relation.inverse && relation.mappedBy.trim() === '';
}

export function relationShowsInverse(relation: RelationRow): boolean {
  return relation.type === 'one-to-one' || relation.type === 'many-to-many';
}
