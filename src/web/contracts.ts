import type { EntityConfig, FieldConfig, GenerationOptions } from '../core/config.js';

/** A message emitted by the shared CLI engine while a request runs. */
export interface LogEntry {
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

/** A generated project as shown by the web UI. */
export interface ProjectSummary {
  name: string;
  rootDir: string;
  /** Path relative to the web server workspace, using forward slashes. */
  relativePath: string;
  packageName: string;
  backend: boolean;
  frontend: boolean;
  /** Backend directory relative to the project root, when present. */
  backendDirectory: string | null;
  /** Frontend directory relative to the project root, when present. */
  frontendDirectory: string | null;
  entities: EntityConfig[];
  options: GenerationOptions;
}

export interface WorkspaceResponse {
  workspacePath: string;
  workspaceName: string;
  projects: ProjectSummary[];
}

/** Features the running server can offer to the current client. */
export interface MetaCapabilities {
  /** Writing a generated project into the workspace is available from this machine. */
  localGeneration: boolean;
  /** JSON project options can be turned into a downloadable ZIP archive. */
  archiveDownload: boolean;
}

export interface MetaResponse {
  fieldTypes: string[];
  validations: string[];
  databases: GenerationOptions['database'][];
  authMethods: GenerationOptions['auth'][];
  buildTools: GenerationOptions['buildTool'][];
  defaults: GenerationOptions;
  capabilities: MetaCapabilities;
}

/** Generator settings shared by local generation and ZIP downloads. */
export interface ProjectGenerationRequest {
  name: string;
  packageName: string;
  database: GenerationOptions['database'];
  auth: GenerationOptions['auth'];
  buildTool: GenerationOptions['buildTool'];
  frontend: boolean;
  docker: boolean;
  /** Generate entities from the workspace configuration or `entities/` directory. */
  includeEntities: boolean;
}

export interface CreateProjectRequest extends ProjectGenerationRequest {
  outputDir: string;
  /** Initialize a git repository in the generated project. */
  git: boolean;
  /** Replace existing files, including protected regions. */
  force: boolean;
}

/** A ZIP download is generated in a temporary staging directory. */
export type DownloadProjectRequest = ProjectGenerationRequest;

export interface CreateEntityRequest {
  projectPath: string;
  name: string;
  tableName?: string;
  fields: EntityFieldRequest[];
}

export type EntityFieldRequest = Pick<FieldConfig, 'name' | 'type'> &
  Partial<Pick<FieldConfig, 'required' | 'unique' | 'maxLength'>>;

export interface CommandResult {
  project?: ProjectSummary;
  messages: LogEntry[];
  /** CLI arguments used under the hood, without the executable name. */
  command: string[];
}

export interface ProjectFile {
  path: string;
  size: number;
  extension: string;
}

export interface ProjectFilesResponse {
  project: ProjectSummary;
  files: ProjectFile[];
  truncated: boolean;
}

export interface ProjectFileResponse {
  project: ProjectSummary;
  file: ProjectFile;
  content: string;
  binary: boolean;
  truncated: boolean;
}

export interface ApiErrorResponse {
  error: string;
  suggestions: string[];
}
