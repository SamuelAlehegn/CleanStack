import { z } from 'zod';

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const identifier = (label: string) =>
  z.string().trim().min(1).regex(IDENTIFIER_PATTERN, `${label} must be a valid identifier.`);

export const FieldConfigSchema = z
  .object({
    name: identifier('Field names'),
    type: z.string().trim().min(1),
    nullable: z.boolean().default(false),
    unique: z.boolean().default(false),
    default: z.unknown().optional(),
    validations: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const RelationConfigSchema = z
  .object({
    name: identifier('Relation names'),
    type: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
    target: identifier('Relation targets'),
    mappedBy: z.string().trim().min(1).optional(),
    inverse: z.boolean().default(false),
  })
  .strict();

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
        if (relationNames.has(relation.name)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate relation "${relation.name}" on entity "${entity.name}".`,
            path: ['entities', entityIndex, 'relations', relationIndex, 'name'],
          });
        } else {
          relationNames.add(relation.name);
        }
      });
    });

    const knownEntities = new Set(config.entities.map((entity) => entity.name.toLowerCase()));
    config.entities.forEach((entity, entityIndex) => {
      entity.relations.forEach((relation, relationIndex) => {
        if (!knownEntities.has(relation.target.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            message: `Relation "${relation.name}" targets unknown entity "${relation.target}".`,
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
