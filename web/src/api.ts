import type {
  ApiErrorResponse,
  CommandResult,
  CreateEntityRequest,
  CreateProjectRequest,
  DownloadProjectRequest,
  EntityPreviewResponse,
  MetaResponse,
  PreviewEntityRequest,
  ProjectFileResponse,
  ProjectFilesResponse,
  ProjectSummary,
  SaveEntityYamlRequest,
  SaveEntityYamlResponse,
  WorkspaceResponse,
} from '../../src/web/contracts';
import {
  demoEntityPreview,
  demoMeta,
  demoProject,
  demoProjectFile,
  demoProjectFiles,
  demoWorkspace,
} from './demo';

export interface DownloadedArchive {
  blob: Blob;
  filename: string;
}

let staticDemo = false;

/** Switches every API call to the bundled demo fixtures. */
export function enableStaticDemo(): void {
  staticDemo = true;
}

export function isStaticDemo(): boolean {
  return staticDemo;
}

function demoUnavailable(action: string): ApiError {
  return new ApiError(`The static demo cannot ${action}.`, [
    'Run "cleanstack ui" locally to use the shared generation engine.',
  ]);
}

export class ApiError extends Error {
  readonly suggestions: string[];
  readonly status: number | undefined;

  constructor(message: string, suggestions: string[] = [], status?: number) {
    super(message);
    this.name = 'ApiError';
    this.suggestions = suggestions;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('The CleanStack local engine is not reachable.', [
      'Start the UI with "cleanstack ui" and try again.',
    ]);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    throw new ApiError(`The server returned an unreadable response (${response.status}).`);
  }

  if (!response.ok) {
    const error = body as ApiErrorResponse | undefined;
    throw new ApiError(
      error?.error ?? `The request failed with status ${response.status}.`,
      error?.suggestions ?? [],
      response.status,
    );
  }

  return body as T;
}

export const api = {
  workspace(): Promise<WorkspaceResponse> {
    return staticDemo
      ? Promise.resolve(demoWorkspace())
      : request<WorkspaceResponse>('/api/workspace');
  },

  meta(): Promise<MetaResponse> {
    return staticDemo ? Promise.resolve(demoMeta()) : request<MetaResponse>('/api/meta');
  },

  createProject(body: CreateProjectRequest): Promise<CommandResult> {
    if (staticDemo) return Promise.reject(demoUnavailable('create projects'));
    return request<CommandResult>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async downloadProject(body: DownloadProjectRequest): Promise<DownloadedArchive> {
    if (staticDemo) throw demoUnavailable('build project archives');
    let response: Response;
    try {
      response = await fetch('/api/projects/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('The CleanStack local engine is not reachable.', [
        'Start the UI with "cleanstack ui" and try again.',
      ]);
    }

    if (!response.ok) throw await readApiError(response);

    const blob = await response.blob();
    return {
      blob,
      filename:
        filenameFromDisposition(response.headers.get('content-disposition')) ?? `${body.name}.zip`,
    };
  },

  createEntity(body: CreateEntityRequest): Promise<CommandResult> {
    if (staticDemo) return Promise.reject(demoUnavailable('generate or update entities'));
    return request<CommandResult>('/api/entities', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  previewEntity(body: PreviewEntityRequest): Promise<EntityPreviewResponse> {
    if (staticDemo) return Promise.resolve(demoEntityPreview(body));
    return request<EntityPreviewResponse>('/api/entities/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  saveEntityYaml(body: SaveEntityYamlRequest): Promise<SaveEntityYamlResponse> {
    if (staticDemo) return Promise.reject(demoUnavailable('save YAML descriptors'));
    return request<SaveEntityYamlResponse>('/api/entities/yaml', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  projectFiles(projectPath: string): Promise<ProjectFilesResponse> {
    if (staticDemo) return Promise.resolve(demoProjectFiles(projectPath));
    return request<ProjectFilesResponse>(
      `/api/projects/files?path=${encodeURIComponent(projectPath)}`,
    );
  },

  file(projectPath: string, filePath: string): Promise<ProjectFileResponse> {
    if (staticDemo) {
      try {
        return Promise.resolve(demoProjectFile(projectPath, filePath));
      } catch (error) {
        return Promise.reject(new ApiError(error instanceof Error ? error.message : String(error)));
      }
    }
    return request<ProjectFileResponse>(
      `/api/projects/file?path=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(filePath)}`,
    );
  },

  project(projectPath: string): Promise<ProjectSummary> {
    if (staticDemo) return Promise.resolve(demoProject(projectPath));
    return request<ProjectSummary>(`/api/projects/detail?path=${encodeURIComponent(projectPath)}`);
  },
};

async function readApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = undefined;
  }
  const error = body as ApiErrorResponse | undefined;
  return new ApiError(
    error?.error ?? `The request failed with status ${response.status}.`,
    error?.suggestions ?? [],
    response.status,
  );
}

function filenameFromDisposition(value: string | null): string | undefined {
  if (value === null) return undefined;

  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  const encoded = utf8?.[1];
  if (encoded !== undefined) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  const quoted = /filename="([^"]+)"/i.exec(value);
  if (quoted !== null) return quoted[1];

  const plain = /filename=([^;]+)/i.exec(value);
  return plain?.[1]?.trim();
}
