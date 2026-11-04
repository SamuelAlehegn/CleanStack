import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { zipSync } from 'fflate';
import { runEntityCommand } from '../cli/entity.js';
import { runNewCommand } from '../cli/new.js';
import {
  FIELD_TYPES,
  FIELD_VALIDATIONS,
  GenerationOptionsSchema,
  type FieldConfig,
} from '../core/config.js';
import { resolveProjectConfig } from '../core/project-metadata.js';
import { locateGeneratedProject, type GeneratedProject } from '../core/project.js';
import { CleanStackError, formatError } from '../utils/errors.js';
import { ensureWithinRoot, isMissingPath, resolveWithinRoot } from '../utils/path-safety.js';
import { Logger } from '../utils/logger.js';
import type {
  ApiErrorResponse,
  CommandResult,
  EntityFieldRequest,
  LogEntry,
  MetaResponse,
  ProjectFile,
  ProjectFileResponse,
  ProjectFilesResponse,
  ProjectSummary,
  WorkspaceResponse,
} from './contracts.js';

const IGNORED_PROJECT_DIRECTORIES = new Set([
  '.angular',
  '.git',
  '.gradle',
  '.idea',
  '.next',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

const DATABASES: MetaResponse['databases'] = ['postgresql', 'mysql', 'h2'];
const AUTH_METHODS: MetaResponse['authMethods'] = ['jwt', 'none', 'keycloak'];
const BUILD_TOOLS: MetaResponse['buildTools'] = ['maven', 'gradle'];
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 5000;
const MAX_PROJECT_SCAN_DEPTH = 3;
const MAX_PROJECT_SCAN_DIRECTORIES = 500;

class ApiError extends Error {
  readonly status: number;
  readonly suggestions: string[];

  constructor(message: string, status = 400, suggestions: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.suggestions = suggestions;
  }
}

/** Captures the CLI logger output so the web UI can display engine progress. */
class CaptureLogger extends Logger {
  readonly entries: LogEntry[] = [];

  constructor() {
    super({ color: false });
  }

  override info(message: string): void {
    this.entries.push({ level: 'info', message });
  }

  override success(message: string): void {
    this.entries.push({ level: 'success', message });
  }

  override warn(message: string): void {
    this.entries.push({ level: 'warn', message });
  }

  override error(message: string): void {
    this.entries.push({ level: 'error', message });
  }

  override debug(): void {
    // The UI shows command output, not internal filesystem tracing.
  }
}

export interface ApiHandlerOptions {
  /** Directory used to discover generated projects and to create new ones. */
  workspace: string;
}

export type ApiHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/**
 * Creates the local JSON API used by the web UI. Every mutating route delegates
 * to the same command implementation the CLI uses: `runNewCommand` for project
 * creation and `runEntityCommand` for entity generation. The API only validates
 * HTTP input and presents the engine's result; it never renders templates,
 * validates entities, or writes generated files itself.
 */
export function createApiHandler(options: ApiHandlerOptions): ApiHandler {
  const workspace = path.resolve(options.workspace);

  return async (request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        allow: 'GET, POST, OPTIONS',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-expose-headers': 'content-disposition',
      });
      response.end();
      return;
    }

    try {
      await routeRequest(request, response, workspace);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status =
        error instanceof ApiError ? error.status : error instanceof CleanStackError ? 400 : 500;
      const body: ApiErrorResponse = {
        error: error instanceof CleanStackError ? error.message : formatError(error),
        suggestions: error instanceof CleanStackError ? error.suggestions : [],
      };
      sendJson(response, status, body);
    }
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/meta') {
    sendJson(response, 200, buildMeta(request));
    return;
  }

  if (method === 'GET' && pathname === '/api/workspace') {
    sendJson(response, 200, await buildWorkspace(workspace));
    return;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    sendJson(response, 200, { projects: await listProjects(workspace) });
    return;
  }

  if (method === 'GET' && pathname === '/api/projects/detail') {
    const project = await openProject(requiredQuery(url, 'path'), workspace);
    sendJson(response, 200, await summarizeProject(project, workspace));
    return;
  }

  if (method === 'GET' && pathname === '/api/projects/files') {
    const project = await openProject(requiredQuery(url, 'path'), workspace);
    const summary = await summarizeProject(project, workspace);
    const files = await listProjectFiles(project.rootDir);
    const result: ProjectFilesResponse = {
      project: summary,
      files: files.files,
      truncated: files.truncated,
    };
    sendJson(response, 200, result);
    return;
  }

  if (method === 'GET' && pathname === '/api/projects/file') {
    const project = await openProject(requiredQuery(url, 'path'), workspace);
    const relativeFile = requiredQuery(url, 'file');
    const summary = await summarizeProject(project, workspace);
    const file = await readProjectFile(project.rootDir, relativeFile);
    const result: ProjectFileResponse = {
      project: summary,
      ...file,
    };
    sendJson(response, 200, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/projects') {
    if (!isLoopbackRequest(request)) {
      throw new ApiError(
        'Local project generation is only available when the studio is opened on this machine.',
        403,
        ['Download a ZIP archive instead, or run the studio on the target machine.'],
      );
    }
    const body = await readJsonBody(request);
    const result = await createProject(workspace, body);
    sendJson(response, 201, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/projects/download') {
    const body = await readJsonBody(request);
    const archive = await createProjectArchive(workspace, body);
    sendArchive(response, archive);
    return;
  }

  if (method === 'POST' && pathname === '/api/entities') {
    const body = await readJsonBody(request);
    const result = await createEntity(body, workspace);
    sendJson(response, 201, result);
    return;
  }

  throw new ApiError(`No API route matches ${method} ${pathname}.`, 404);
}

function buildMeta(request: IncomingMessage): MetaResponse {
  return {
    fieldTypes: [...FIELD_TYPES],
    validations: [...FIELD_VALIDATIONS],
    databases: [...DATABASES],
    authMethods: [...AUTH_METHODS],
    buildTools: [...BUILD_TOOLS],
    defaults: GenerationOptionsSchema.parse({}),
    capabilities: {
      localGeneration: isLoopbackRequest(request),
      archiveDownload: true,
    },
  };
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (address === undefined) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

async function buildWorkspace(workspace: string): Promise<WorkspaceResponse> {
  return {
    workspacePath: workspace,
    workspaceName: path.basename(workspace),
    projects: await listProjects(workspace),
  };
}

async function listProjects(workspace: string): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  const seen = new Set<string>();
  const pending: Array<{ directory: string; depth: number }> = [{ directory: workspace, depth: 0 }];
  let inspected = 0;

  while (pending.length > 0 && inspected < MAX_PROJECT_SCAN_DIRECTORIES) {
    const next = pending.shift()!;
    inspected += 1;
    const resolved = path.resolve(next.directory);

    let project: GeneratedProject | undefined;
    try {
      project = await locateGeneratedProject({ cwd: resolved });
    } catch {
      // A normal directory is not a generated project; keep scanning.
    }

    if (project !== undefined && project.rootDir === resolved) {
      if (!seen.has(project.rootDir)) {
        seen.add(project.rootDir);
        try {
          projects.push(await summarizeProject(project, workspace));
        } catch {
          // Invalid metadata should not hide other projects in the workspace.
        }
      }
      continue;
    }

    if (next.depth >= MAX_PROJECT_SCAN_DEPTH) continue;
    for (const entry of await readDirectoryEntries(resolved)) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        IGNORED_PROJECT_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      pending.push({ directory: path.join(resolved, entry.name), depth: next.depth + 1 });
    }
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

async function openProject(projectPath: string, workspace: string): Promise<GeneratedProject> {
  const resolved = path.resolve(projectPath);
  try {
    await ensureWithinRoot(workspace, resolved, projectPath);
  } catch (error) {
    if (error instanceof Error && error.name === 'UnsafePathError') {
      throw new ApiError('The project must be inside the active workspace.', 400);
    }
    throw error;
  }

  let project: GeneratedProject;
  try {
    project = await locateGeneratedProject({ cwd: resolved });
  } catch (error) {
    if (error instanceof CleanStackError) {
      throw new ApiError(error.message, 400, error.suggestions);
    }
    throw error;
  }

  if (project.rootDir !== resolved) {
    throw new ApiError(`"${resolved}" is not the root of a generated CleanStack project.`, 400, [
      `Open "${project.rootDir}" instead.`,
    ]);
  }
  return project;
}

async function summarizeProject(
  project: GeneratedProject,
  workspace: string,
): Promise<ProjectSummary> {
  const config = await resolveProjectConfig(project, { cwd: project.rootDir });
  return {
    name: config.name || path.basename(project.rootDir),
    rootDir: project.rootDir,
    relativePath: relativePortable(workspace, project.rootDir) || '.',
    packageName: config.packageName,
    backend: project.backend !== undefined,
    frontend: project.frontend !== undefined,
    backendDirectory:
      project.backend === undefined
        ? null
        : relativePortable(project.rootDir, project.backend.directory),
    frontendDirectory:
      project.frontend === undefined
        ? null
        : relativePortable(project.rootDir, project.frontend.directory),
    entities: config.entities,
    options: config.options,
  };
}

interface ParsedProjectRequest {
  name: string;
  packageName: string;
  database: MetaResponse['databases'][number];
  auth: MetaResponse['authMethods'][number];
  buildTool: MetaResponse['buildTools'][number];
  frontend: boolean;
  docker: boolean;
  includeEntities: boolean;
  outputDir: string;
  git: boolean;
  force: boolean;
}

interface ProjectArchive {
  contents: Buffer;
  filename: string;
}

async function createProject(workspace: string, raw: unknown): Promise<CommandResult> {
  const request = parseProjectRequest(raw);
  const targetRoot = path.resolve(workspace, request.outputDir, request.name);
  try {
    await ensureWithinRoot(workspace, targetRoot, path.posix.join(request.outputDir, request.name));
  } catch (error) {
    if (error instanceof Error && error.name === 'UnsafePathError') {
      throw new ApiError('The output directory must stay inside the active workspace.', 400);
    }
    throw error;
  }
  if (!request.force && (await pathExists(targetRoot))) {
    throw new ApiError(
      `A project directory named "${request.name}" already exists at ${targetRoot}.`,
      409,
      [
        'Choose another project name, or turn on "Overwrite existing files" to regenerate it.',
        'You can also manage the existing project from the Entities page.',
      ],
    );
  }

  const args = projectArguments(request, request.git, request.force);
  const logger = new CaptureLogger();

  await runNewCommand(args, { cwd: workspace, logger });
  const project = await locateGeneratedProject({ cwd: targetRoot });
  return {
    project: await summarizeProject(project, workspace),
    messages: logger.entries,
    command: ['cleanstack', 'new', ...args],
  };
}

async function createProjectArchive(workspace: string, raw: unknown): Promise<ProjectArchive> {
  const request = parseProjectRequest(raw);
  // Generate into a hidden temporary directory so the archive uses exactly the
  // same engine, workspace configuration, and entities as a local generation.
  const staging = await mkdtemp(path.join(workspace, '.cleanstack-archive-'));
  try {
    const outputDir = relativePortable(workspace, staging) || '.';
    const args = projectArguments({ ...request, outputDir }, false, false);
    await runNewCommand(args, { cwd: workspace, logger: new CaptureLogger() });

    const projectRoot = path.join(staging, request.name);
    const entries = await collectArchiveEntries(projectRoot, request.name);
    return {
      contents: Buffer.from(zipSync(entries, { level: 6 })),
      filename: `${request.name}.zip`,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parseProjectRequest(raw: unknown): ParsedProjectRequest {
  const body = asRecord(raw, 'project');
  const name = requiredString(body, 'name');
  if (name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new ApiError('Project name must be a single directory name without path separators.');
  }

  return {
    name,
    packageName: requiredString(body, 'packageName'),
    database: requiredChoice(body, 'database', DATABASES),
    auth: requiredChoice(body, 'auth', AUTH_METHODS),
    buildTool: requiredChoice(body, 'buildTool', BUILD_TOOLS),
    frontend: optionalBoolean(body, 'frontend') ?? true,
    docker: optionalBoolean(body, 'docker') ?? false,
    includeEntities: optionalBoolean(body, 'includeEntities') ?? false,
    outputDir: optionalString(body, 'outputDir') || '.',
    git: optionalBoolean(body, 'git') ?? false,
    force: optionalBoolean(body, 'force') ?? false,
  };
}

function projectArguments(
  request: ParsedProjectRequest,
  initializeGit: boolean,
  force: boolean,
): string[] {
  return [
    request.name,
    '--yes',
    request.includeEntities ? '--entities' : '--no-entities',
    '--package',
    request.packageName,
    '--db',
    request.database,
    '--auth',
    request.auth,
    '--build',
    request.buildTool,
    '--frontend',
    request.frontend ? 'angular' : 'none',
    '--output-dir',
    request.outputDir,
    request.docker ? '--docker' : '--no-docker',
    '--no-dry-run',
    ...(initializeGit && request.git ? ['--git'] : []),
    ...(force ? ['--force'] : []),
  ];
}

async function collectArchiveEntries(
  rootDir: string,
  rootName: string,
): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readDirectoryEntries(directory)) {
      if (entry.name === '.DS_Store' || entry.name === '.git') continue;
      if (entry.isSymbolicLink()) continue;

      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      entries[`${rootName}/${relativePath}`] = new Uint8Array(await readFile(absolutePath));
    }
  };

  await walk(rootDir, '');
  return entries;
}

async function createEntity(raw: unknown, workspace: string): Promise<CommandResult> {
  const body = asRecord(raw, 'entity');
  const projectPath = requiredString(body, 'projectPath');
  const project = await openProject(projectPath, workspace);
  const name = requiredString(body, 'name');
  const tableName = optionalString(body, 'tableName');

  if (!Array.isArray(body.fields) || body.fields.length === 0) {
    throw new ApiError('Add at least one field before generating an entity.');
  }

  const fields = body.fields.map((field, index) => normalizeField(field, index));
  const args = [
    name,
    ...fields.flatMap((field) => ['--field', JSON.stringify(field)]),
    ...(tableName === undefined || tableName.trim() === '' ? [] : ['--table', tableName]),
  ];
  const logger = new CaptureLogger();

  await runEntityCommand(args, { cwd: project.rootDir, logger });
  const refreshed = await openProject(project.rootDir, workspace);
  return {
    project: await summarizeProject(refreshed, workspace),
    messages: logger.entries,
    command: ['cleanstack', 'entity', ...args],
  };
}

function normalizeField(raw: unknown, index: number): EntityFieldRequest {
  const field = asRecord(raw, `field ${index + 1}`);
  const name = requiredString(field, 'name');
  const type = requiredString(field, 'type');
  if (!FIELD_TYPES.includes(type as (typeof FIELD_TYPES)[number])) {
    throw new ApiError(`Field "${name}" has an unsupported type "${type}".`, 400, [
      `Use one of: ${FIELD_TYPES.join(', ')}.`,
    ]);
  }

  const result: EntityFieldRequest = { name, type: type as FieldConfig['type'] };
  const required = optionalBoolean(field, 'required');
  const unique = optionalBoolean(field, 'unique');
  const maxLength = optionalPositiveInteger(field, 'maxLength');
  if (required !== undefined) result.required = required;
  if (unique !== undefined) result.unique = unique;
  if (maxLength !== undefined) result.maxLength = maxLength;
  return result;
}

async function listProjectFiles(
  rootDir: string,
): Promise<{ files: ProjectFile[]; truncated: boolean }> {
  const files: ProjectFile[] = [];
  let truncated = false;

  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }

    for (const entry of await readDirectoryEntries(directory)) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name === '.DS_Store') continue;
      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_PROJECT_DIRECTORIES.has(entry.name)) continue;
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const fileStat = await stat(absolutePath);
      files.push({
        path: relativePath,
        size: fileStat.size,
        extension: path.extname(entry.name).replace(/^\./, '').toLowerCase(),
      });
    }
  };

  await walk(rootDir, '');
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated };
}

async function readProjectFile(
  rootDir: string,
  relativeFile: string,
): Promise<Omit<ProjectFileResponse, 'project'>> {
  let target: string;
  try {
    target = await resolveWithinRoot(rootDir, relativeFile);
  } catch (error) {
    if (error instanceof Error && error.name === 'UnsafePathError') {
      throw new ApiError('The requested file path is outside the project.', 400);
    }
    throw error;
  }
  const fileStat = await stat(target).catch((error: unknown) => {
    if (isMissingPath(error)) {
      throw new ApiError(`The file "${relativeFile}" was not found.`, 404);
    }
    throw error;
  });
  if (!fileStat.isFile()) {
    throw new ApiError(`"${relativeFile}" is not a file.`, 400);
  }

  const length = Math.min(fileStat.size, MAX_FILE_BYTES);
  const handle = await open(target, 'r');
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
  } finally {
    await handle.close();
  }

  const binary = buffer.includes(0);
  return {
    file: {
      path: relativeFile,
      size: fileStat.size,
      extension: path.extname(relativeFile).replace(/^\./, '').toLowerCase(),
    },
    content: binary ? '' : buffer.toString('utf8'),
    binary,
    truncated: fileStat.size > length,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError('Request body is too large.', 413);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new ApiError('A JSON request body is required.');
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError(`Invalid JSON request body: ${detail}`);
  }
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === '') {
    throw new ApiError(`Query parameter "${name}" is required.`);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(`The ${label} request must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(`"${key}" is required.`);
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ApiError(`"${key}" must be a string.`);
  return value.trim();
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ApiError(`"${key}" must be a boolean.`);
  return value;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ApiError(`"${key}" must be a positive integer.`);
  }
  return value;
}

function requiredChoice<T extends string>(
  record: Record<string, unknown>,
  key: string,
  choices: readonly T[],
): T {
  const value = requiredString(record, key);
  if (!choices.includes(value as T)) {
    throw new ApiError(`"${key}" must be one of: ${choices.join(', ')}.`);
  }
  return value as T;
}

async function readDirectoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function relativePortable(from: string, to: string): string {
  const relative = path.relative(from, to);
  return relative === '' ? '' : relative.split(path.sep).join('/');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const contents = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(contents),
    'cache-control': 'no-store',
  });
  response.end(contents);
}

function sendArchive(response: ServerResponse, archive: ProjectArchive): void {
  const asciiFilename = archive.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': archive.contents.length,
    'content-disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(archive.filename)}`,
    'cache-control': 'no-store',
  });
  response.end(archive.contents);
}
