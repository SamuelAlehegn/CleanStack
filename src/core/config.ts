import { z } from 'zod';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export const FIELD_TYPES = [
  'String',
  'boolean',
  'Boolean',
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
  'UUID',
  'LocalDate',
  'LocalTime',
  'LocalDateTime',
  'OffsetDateTime',
  'Instant',
] as const;

export const FIELD_VALIDATIONS = [
  'NotBlank',
  'Email',
  'Positive',
  'PositiveOrZero',
  'Negative',
  'NegativeOrZero',
  'Past',
  'PastOrPresent',
  'Future',
  'FutureOrPresent',
] as const;

const identifier = (label: string) =>
  z.string().trim().min(1).regex(IDENTIFIER_PATTERN, `${label} must be a valid identifier.`);

export const FieldConfigSchema = z
  .object({
    name: identifier('Field names'),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    /** Legacy alias for `required`; new descriptors should use `required`. */
    nullable: z.boolean().optional(),
    unique: z.boolean().default(false),
    default: z.unknown().optional(),
    generated: z.boolean().default(false),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    pattern: z.string().min(1).optional(),
    validations: z.array(z.enum(FIELD_VALIDATIONS)).default([]),
  })
  .strict()
  .superRefine((field, ctx) => {
    const stringType = field.type === 'String';
    const numericTypes = new Set([
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

    if (
      (field.minLength !== undefined ||
        field.maxLength !== undefined ||
        field.pattern !== undefined) &&
      !stringType
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'minLength, maxLength, and pattern are only valid for String fields.',
        path: ['type'],
      });
    }
    if ((field.min !== undefined || field.max !== undefined) && !numericTypes.has(field.type)) {
      ctx.addIssue({
        code: 'custom',
        message: 'min and max are only valid for numeric fields.',
        path: ['type'],
      });
    }
    if (
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'minLength cannot be greater than maxLength.',
        path: ['minLength'],
      });
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      ctx.addIssue({ code: 'custom', message: 'min cannot be greater than max.', path: ['min'] });
    }
    if (
      field.required !== undefined &&
      field.nullable !== undefined &&
      field.required === field.nullable
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'required and nullable describe opposite values; provide only required in new descriptors.',
        path: ['required'],
      });
    }
  })
  .transform((field) => ({
    ...field,
    required: field.required ?? (field.nullable === undefined ? false : !field.nullable),
    nullable: field.required === undefined ? (field.nullable ?? false) : !field.required,
  }));

const RELATION_TYPES = [
  'OneToOne',
  'OneToMany',
  'ManyToOne',
  'ManyToMany',
  'one-to-one',
  'one-to-many',
  'many-to-one',
  'many-to-many',
] as const;

export const RelationConfigSchema = z
  .object({
    /** `field` is the descriptor spelling; `name` remains accepted for existing configs. */
    field: identifier('Relation fields').optional(),
    name: identifier('Relation names').optional(),
    type: z.enum(RELATION_TYPES),
    target: identifier('Relation targets'),
    required: z.boolean().default(false),
    mappedBy: z.string().trim().min(1).optional(),
    inverse: z.boolean().default(false),
  })
  .strict()
  .superRefine((relation, ctx) => {
    if (relation.field === undefined && relation.name === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A relation requires a field name.',
        path: ['field'],
      });
    }
    if (
      relation.field !== undefined &&
      relation.name !== undefined &&
      relation.field !== relation.name
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'field and name must match when both are provided.',
        path: ['field'],
      });
    }
  })
  .transform((relation) => ({
    ...relation,
    field: relation.field ?? relation.name!,
    type: relation.type.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() as
      'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many',
  }));

export const EntityConfigSchema = z
  .object({
    name: identifier('Entity names'),
    tableName: z.string().trim().min(1).optional(),
    fields: z.array(FieldConfigSchema).default([]),
    relations: z.array(RelationConfigSchema).default([]),
  })
  .strict();

export const GenerationOptionsSchema = z
  .object({
    backend: z.boolean().default(true),
    frontend: z.boolean().default(true),
    database: z.enum(['postgresql', 'mysql', 'h2']).default('postgresql'),
    auth: z.enum(['jwt', 'none', 'keycloak']).default('jwt'),
    buildTool: z.enum(['maven', 'gradle']).default('maven'),
    docker: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    outputDir: z.string().trim().min(1).default('.'),
  })
  .strict();

const DEFAULT_GENERATION_OPTIONS = GenerationOptionsSchema.parse({});

export const ProjectConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    packageName: z
      .string()
      .trim()
      .regex(
        PACKAGE_NAME_PATTERN,
        'packageName must be a valid Java package name (for example, com.example).',
      )
      .default('com.example'),
    entities: z.array(EntityConfigSchema).default([]),
    options: GenerationOptionsSchema.default(DEFAULT_GENERATION_OPTIONS),
  })
  .strict()
  .superRefine((config, ctx) => {
    const entityIndexes = new Map<string, number>();

    config.entities.forEach((entity, entityIndex) => {
      const entityKey = entity.name.toLowerCase();
      const existingEntityIndex = entityIndexes.get(entityKey);
      if (existingEntityIndex !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate entity "${entity.name}" (already defined at entities.${existingEntityIndex}).`,
          path: ['entities', entityIndex, 'name'],
        });
      } else {
        entityIndexes.set(entityKey, entityIndex);
      }

      const fieldNames = new Set<string>();
      entity.fields.forEach((field, fieldIndex) => {
        if (fieldNames.has(field.name)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate field "${field.name}" on entity "${entity.name}".`,
            path: ['entities', entityIndex, 'fields', fieldIndex, 'name'],
          });
        } else {
          fieldNames.add(field.name);
        }
      });

      const relationNames = new Set<string>();
      entity.relations.forEach((relation, relationIndex) => {
        if (relationNames.has(relation.field)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate relation "${relation.field}" on entity "${entity.name}".`,
            path: ['entities', entityIndex, 'relations', relationIndex, 'field'],
          });
        } else {
          relationNames.add(relation.field);
        }
      });
    });

    const knownEntities = new Set(config.entities.map((entity) => entity.name.toLowerCase()));
    config.entities.forEach((entity, entityIndex) => {
      entity.relations.forEach((relation, relationIndex) => {
        if (!knownEntities.has(relation.target.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            message: `Relation "${relation.field}" targets unknown entity "${relation.target}".`,
            path: ['entities', entityIndex, 'relations', relationIndex, 'target'],
          });
        }
      });
    });
  });

export type FieldConfig = z.infer<typeof FieldConfigSchema>;
export type RelationConfig = z.infer<typeof RelationConfigSchema>;
export type EntityConfig = z.infer<typeof EntityConfigSchema>;
export type GenerationOptions = z.infer<typeof GenerationOptionsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export interface TemplateContext {
  project: ProjectConfig;
  entity?: EntityConfig;
  entities: EntityConfig[];
}
