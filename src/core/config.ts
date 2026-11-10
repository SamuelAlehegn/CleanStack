import { z, type RefinementCtx } from 'zod';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Pattern for a dotted Java package name. */
export const JAVA_PACKAGE_PATTERN = PACKAGE_NAME_PATTERN;

/**
 * Structural category of a descriptor field type; decides which field options
 * (minLength/pattern versus min/max) apply. Extensions classify their types
 * with the same categories the built-in types use.
 */
export type FieldKind = 'string' | 'numeric' | 'boolean' | 'other';

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

export const MIGRATION_TOOLS = ['flyway', 'liquibase'] as const;

const identifier = (label: string) =>
  z.string().trim().min(1).regex(IDENTIFIER_PATTERN, `${label} must be a valid identifier.`);

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

export const GenerationOptionsSchema = z
  .object({
    backend: z.boolean().default(true),
    frontend: z.boolean().default(true),
    database: z.enum(['postgresql', 'mysql', 'h2']).default('postgresql'),
    auth: z.enum(['jwt', 'session', 'oidc', 'keycloak', 'auth0', 'none']).default('jwt'),
    buildTool: z.enum(['maven', 'gradle']).default('maven'),
    docker: z.boolean().default(false),
    /** Schema migration tool used by the generated Spring Boot backend. */
    migrationTool: z.enum(MIGRATION_TOOLS).default('flyway'),
    /** Generate seed migrations for entities that opt in with `seed` or `seedData`. */
    seed: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    outputDir: z.string().trim().min(1).default('.'),
  })
  .strict();

const DEFAULT_GENERATION_OPTIONS = GenerationOptionsSchema.parse({});

/**
 * Built-in kinds of descriptor field types used by `createConfigSchemas` when
 * an extension has not classified the type.
 */
export const BUILT_IN_FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  String: 'string',
  boolean: 'boolean',
  Boolean: 'boolean',
  byte: 'numeric',
  Byte: 'numeric',
  short: 'numeric',
  Short: 'numeric',
  int: 'numeric',
  Integer: 'numeric',
  long: 'numeric',
  Long: 'numeric',
  BigInteger: 'numeric',
  float: 'numeric',
  Float: 'numeric',
  double: 'numeric',
  Double: 'numeric',
  BigDecimal: 'numeric',
  UUID: 'other',
  LocalDate: 'other',
  LocalTime: 'other',
  LocalDateTime: 'other',
  OffsetDateTime: 'other',
  Instant: 'other',
};

/** Options that adapt the config schemas to the field types added by extensions. */
export interface ConfigSchemaOptions {
  /** Extra field type names accepted in descriptors, contributed by extensions. */
  fieldTypes?: readonly string[];
  /** Classifies an added field type; built-ins are classified by {@link BUILT_IN_FIELD_KINDS}. */
  fieldKind?: (fieldType: string) => FieldKind | undefined;
}

/**
 * Builds the schemas that validate entity fields, parameterized by the field
 * types extensions contribute. Callers without extensions use the module-level
 * exports, which are built from the built-in types only.
 */
export function createConfigSchemas(options: ConfigSchemaOptions = {}) {
  const additionalFieldTypes = options.fieldTypes ?? [];
  const kindOf = (fieldType: string): FieldKind =>
    options.fieldKind?.(fieldType) ?? BUILT_IN_FIELD_KINDS[fieldType] ?? 'other';

  const FieldConfigSchema = z
    .object({
      name: identifier('Field names'),
      type: z.enum([...FIELD_TYPES, ...additionalFieldTypes]),
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
      const kind = kindOf(field.type);

      if (
        (field.minLength !== undefined ||
          field.maxLength !== undefined ||
          field.pattern !== undefined) &&
        kind !== 'string'
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'minLength, maxLength, and pattern are only valid for String fields.',
          path: ['type'],
        });
      }
      if ((field.min !== undefined || field.max !== undefined) && kind !== 'numeric') {
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
    .transform((field) => {
      const required = field.required ?? (field.nullable === undefined ? false : !field.nullable);
      return {
        ...field,
        required,
        nullable: !required,
      };
    });

  const EntityConfigSchema = z
    .object({
      name: identifier('Entity names'),
      tableName: z.string().trim().min(1).optional(),
      fields: z.array(FieldConfigSchema).default([]),
      relations: z.array(RelationConfigSchema).default([]),
      /** Generate one sample seed row for this entity. */
      seed: z.boolean().default(false),
      /** Explicit seed rows, keyed by field name or `<relation>Id`. */
      seedData: z.array(z.record(z.string(), z.unknown())).default([]),
    })
    .strict();

  const projectConfigFields = {
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
    /**
     * Extension module names or paths registered before generation.
     * See docs/EXTENSIONS.md.
     */
    extensions: z.array(z.string().trim().min(1)).optional(),
  };

  const ProjectConfigObjectSchema = z.object(projectConfigFields).strict();
  const ProjectConfigSchema = ProjectConfigObjectSchema.superRefine(refineProjectConfig);
  const ProjectDefaultsSchema = z
    .object({
      ...projectConfigFields,
      name: z.string().trim().min(1).optional(),
    })
    .strict()
    .superRefine(refineProjectConfig);

  return { FieldConfigSchema, EntityConfigSchema, ProjectConfigSchema, ProjectDefaultsSchema };
}

const builtInSchemas = createConfigSchemas();

export const FieldConfigSchema = builtInSchemas.FieldConfigSchema;
export const EntityConfigSchema = builtInSchemas.EntityConfigSchema;
export const ProjectConfigSchema = builtInSchemas.ProjectConfigSchema;
export const ProjectDefaultsSchema = builtInSchemas.ProjectDefaultsSchema;

function refineProjectConfig(config: { entities: EntityConfig[] }, ctx: RefinementCtx): void {
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
}

export type FieldConfig = z.infer<typeof FieldConfigSchema>;
export type RelationConfig = z.infer<typeof RelationConfigSchema>;
export type EntityConfig = z.infer<typeof EntityConfigSchema>;
export type GenerationOptions = z.infer<typeof GenerationOptionsSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectDefaults = z.infer<typeof ProjectDefaultsSchema>;

export interface TemplateContext {
  project: ProjectConfig;
  entity?: EntityConfig;
  entities: EntityConfig[];
}
