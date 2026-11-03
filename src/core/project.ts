import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CleanStackError } from '../utils/errors.js';

export interface BackendProject {
  /** Absolute path to the Spring Boot project. */
  directory: string;
  /** Path relative to the workspace root, using forward slashes. */
  relativeDirectory: string;
  packageName: string;
  buildTool: 'maven' | 'gradle';
}

export interface FrontendProject {
  /** Absolute path to the Angular project. */
  directory: string;
  /** Path relative to the workspace root, using forward slashes. */
  relativeDirectory: string;
}

export interface GeneratedProject {
  /** Absolute path to the generated project root. */
  rootDir: string;
  /** Path relative to the workspace root, using forward slashes. */
  relativeRootDir: string;
  /** The common ancestor of the current directory and the generated project. */
  workspaceRoot: string;
  backend?: BackendProject;
  frontend?: FrontendProject;
}

export interface LocateProjectOptions {
  cwd?: string;
}

export class ProjectNotFoundError extends CleanStackError {
  constructor(cwd: string) {
    super(
      `No generated CleanStack project was found from "${cwd}". Run this command inside a project created by "cleanstack new".`,
      {
        suggestions: [
          'Run "cleanstack new <name>" to create a project.',
          'Or change into a generated project directory and run the command again.',
        ],
      },
    );
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectDetectionError extends CleanStackError {
  constructor(message: string, suggestions: string[] = []) {
    super(message, { suggestions });
    this.name = 'ProjectDetectionError';
  }
}

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'target', '.git']);

/**
 * Finds a generated project by walking up from the current directory. If the
 * current directory contains generated projects, its direct children are
 * inspected as a fallback.
 */
export async function locateGeneratedProject(
  options: LocateProjectOptions = {},
): Promise<GeneratedProject> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let current = cwd;
  let best: Omit<GeneratedProject, 'workspaceRoot'> | undefined;

  while (true) {
    const found = await inspectDirectory(current);
    if (found) {
      if (found.backend && found.frontend) {
        return withWorkspaceRoot(cwd, found);
      }
      best ??= found;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (best) return withWorkspaceRoot(cwd, best);

  const children = await listDirectories(cwd);
  const candidates: Omit<GeneratedProject, 'workspaceRoot'>[] = [];
  for (const child of children) {
    const found = await inspectDirectory(child);
    if (found) candidates.push(found);
  }

  if (candidates.length === 1) return withWorkspaceRoot(cwd, candidates[0]!);
  if (candidates.length > 1) {
    throw new ProjectDetectionError(
      `${cwd} contains multiple generated projects (${candidates
        .map((candidate) => path.basename(candidate.rootDir))
        .join(', ')}). Run the command inside one of them.`,
    );
  }

  throw new ProjectNotFoundError(cwd);
}

async function inspectDirectory(
  directory: string,
): Promise<Omit<GeneratedProject, 'workspaceRoot'> | undefined> {
  const backend = await findBackend(directory);
  const frontend = await findFrontend(directory);
  if (!backend && !frontend) return undefined;
  return {
    rootDir: directory,
    relativeRootDir: '.',
    ...(backend ? { backend } : {}),
    ...(frontend ? { frontend } : {}),
  };
}

async function findBackend(directory: string): Promise<BackendProject | undefined> {
  if (await looksLikeBackend(directory)) {
    return {
      directory,
      relativeDirectory: '.',
      packageName: await detectPackageName(directory),
      buildTool: (await isFile(path.join(directory, 'pom.xml'))) ? 'maven' : 'gradle',
    };
  }

  const candidates: string[] = [];
  for (const child of await listDirectories(directory)) {
    if (await looksLikeBackend(child)) candidates.push(child);
  }
  const selected = chooseCandidate(candidates, '-backend', 'backend');
  if (!selected) return undefined;
  return {
    directory: selected,
    relativeDirectory: '.',
    packageName: await detectPackageName(selected),
    buildTool: (await isFile(path.join(selected, 'pom.xml'))) ? 'maven' : 'gradle',
  };
}

async function findFrontend(directory: string): Promise<FrontendProject | undefined> {
  if (await looksLikeFrontend(directory)) {
    return { directory, relativeDirectory: '.' };
  }

  const candidates: string[] = [];
  for (const child of await listDirectories(directory)) {
    if (await looksLikeFrontend(child)) candidates.push(child);
  }
  const selected = chooseCandidate(candidates, '-ui', 'frontend');
  if (!selected) return undefined;
  return { directory: selected, relativeDirectory: '.' };
}

function chooseCandidate(
  candidates: string[],
  preferredSuffix: string,
  label: string,
): string | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0]!;

  const preferred = candidates.filter((candidate) => candidate.endsWith(preferredSuffix));
  if (preferred.length === 1) return preferred[0]!;

  throw new ProjectDetectionError(
    `Multiple ${label} projects were found (${candidates
      .map((candidate) => path.basename(candidate))
      .join(', ')}). Run the command inside the one you want to update.`,
  );
}

async function looksLikeBackend(directory: string): Promise<boolean> {
  const hasBuildFile =
    (await isFile(path.join(directory, 'pom.xml'))) ||
    (await isFile(path.join(directory, 'build.gradle.kts')));
  return hasBuildFile && (await isDirectory(path.join(directory, 'src', 'main', 'java')));
}

async function looksLikeFrontend(directory: string): Promise<boolean> {
  return (
    (await isFile(path.join(directory, 'angular.json'))) &&
    (await isDirectory(path.join(directory, 'src', 'app')))
  );
}

async function detectPackageName(backendDirectory: string): Promise<string> {
  const javaRoot = path.join(backendDirectory, 'src', 'main', 'java');
  const javaFiles = await listFiles(javaRoot);
  const sourceFile =
    javaFiles.find((file) => file.endsWith('Application.java')) ??
    javaFiles.find((file) => file.endsWith('.java'));

  if (sourceFile) {
    const contents = await readFile(sourceFile, 'utf8');
    const match = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(contents);
    if (match?.[1]) return match[1];
  }

  throw new ProjectDetectionError(
    `Could not detect the Java package under "${javaRoot}". Pass --package to set it explicitly.`,
  );
}

function withWorkspaceRoot(
  cwd: string,
  project: Omit<GeneratedProject, 'workspaceRoot'>,
): GeneratedProject {
  const workspaceRoot = isWithin(cwd, project.rootDir) ? cwd : project.rootDir;
  const relative = (target: string): string =>
    path.relative(workspaceRoot, target).split(path.sep).join('/') || '.';

  return {
    ...project,
    workspaceRoot,
    relativeRootDir: relative(project.rootDir),
    ...(project.backend
      ? { backend: { ...project.backend, relativeDirectory: relative(project.backend.directory) } }
      : {}),
    ...(project.frontend
      ? {
          frontend: {
            ...project.frontend,
            relativeDirectory: relative(project.frontend.directory),
          },
        }
      : {}),
  };
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listFiles(entryPath);
        return entry.isFile() ? [entryPath] : [];
      }),
    );
    return files.flat().sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}
