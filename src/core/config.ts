import { z } from 'zod';

export const FieldConfigSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.boolean().default(false),
  unique: z.boolean().default(false),
  default: z.unknown().optional(),
  validations: z.array(z.string()).default([]),
});

export const RelationConfigSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']),
  target: z.string().min(1),
  mappedBy: z.string().optional(),
  inverse: z.boolean().default(false),
});

export const EntityConfigSchema = z.object({
  name: z.string().min(1),
  tableName: z.string().min(1).optional(),
  fields: z.array(FieldConfigSchema).default([]),
  relations: z.array(RelationConfigSchema).default([]),
});

export const GenerationOptionsSchema = z.object({
  backend: z.boolean().default(true),
  frontend: z.boolean().default(true),
  database: z.enum(['postgresql', 'mysql', 'h2']).default('postgresql'),
  auth: z.enum(['jwt', 'none', 'keycloak']).default('jwt'),
  buildTool: z.enum(['maven', 'gradle']).default('maven'),
  docker: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  outputDir: z.string().default('.'),
});

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  packageName: z.string().min(1).default('com.example'),
  entities: z.array(EntityConfigSchema).default([]),
  options: GenerationOptionsSchema.default({
    backend: true,
    frontend: true,
    database: 'postgresql',
    auth: 'jwt',
    buildTool: 'maven',
    docker: false,
    dryRun: false,
    outputDir: '.',
  }),
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
  options: GenerationOptions;
}
