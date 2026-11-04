import type {
  ApiErrorResponse,
  CommandResult,
  CreateEntityRequest,
  CreateProjectRequest,
  DownloadProjectRequest,
  MetaResponse,
  ProjectFileResponse,
  ProjectFilesResponse,
  ProjectSummary,
  WorkspaceResponse,
} from '../../src/web/contracts';

export interface DownloadedArchive {
  blob: Blob;
  filename: string;
}

export class ApiError extends Error {
  readonly suggestions: string[];

  constructor(message: string, suggestions: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.suggestions = suggestions;
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
      'Start the UI with "npm run ui:dev" and try again.',
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
    );
  }

  return body as T;
}

export const api = {
  workspace(): Promise<WorkspaceResponse> {
    return request<WorkspaceResponse>('/api/workspace');
  },

  meta(): Promise<MetaResponse> {
    return request<MetaResponse>('/api/meta');
  },

  createProject(body: CreateProjectRequest): Promise<CommandResult> {
    return request<CommandResult>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async downloadProject(body: DownloadProjectRequest): Promise<DownloadedArchive> {
    let response: Response;
    try {
      response = await fetch('/api/projects/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('The CleanStack local engine is not reachable.', [
        'Start the UI with "npm run ui:dev" and try again.',
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
    return request<CommandResult>('/api/entities', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  projectFiles(projectPath: string): Promise<ProjectFilesResponse> {
    return request<ProjectFilesResponse>(
      `/api/projects/files?path=${encodeURIComponent(projectPath)}`,
    );
  },

  file(projectPath: string, filePath: string): Promise<ProjectFileResponse> {
    return request<ProjectFileResponse>(
      `/api/projects/file?path=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(filePath)}`,
    );
  },

  project(projectPath: string): Promise<ProjectSummary> {
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
