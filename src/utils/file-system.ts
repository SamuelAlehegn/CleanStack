import {
  access as nodeAccess,
  cp as nodeCopy,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  rm as nodeRemove,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import path from 'node:path';
import { ensureWithinRoot, isMissingPath, resolveWithinRoot } from './path-safety.js';

export interface FileSystemEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface FileSystemAdapter {
  access(filePath: string): Promise<void>;
  copy(sourcePath: string, destinationPath: string, options: { overwrite: boolean }): Promise<void>;
  mkdir(directoryPath: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  readdir(directoryPath: string): Promise<FileSystemEntry[]>;
  realpath(filePath: string): Promise<string>;
  remove(filePath: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  writeFile(filePath: string, contents: string, options: { overwrite: boolean }): Promise<void>;
}

export type FileSystemOperation =
  | 'createDirectory'
  | 'writeFile'
  | 'readFile'
  | 'exists'
  | 'copy'
  | 'backup'
  | 'delete'
  | 'listFiles';

export type FileSystemActionStatus = 'started' | 'succeeded' | 'skipped' | 'failed';

export interface FileSystemAction {
  operation: FileSystemOperation;
  path: string;
  status: FileSystemActionStatus;
  dryRun: boolean;
  sourcePath?: string;
  detail?: string;
}

export interface FileSystemLogger {
  log(action: FileSystemAction): void;
}

export interface FileSystemServiceOptions {
  /** All paths passed to the service are resolved beneath this directory. */
  rootDir?: string;
  /** Mutating operations are logged and skipped when true. */
  dryRun?: boolean;
  /** Back up overwritten files by default. Per-operation options can override this. */
  backup?: boolean;
  /** Suffix appended to an overwritten path for its first backup. Defaults to .bak. */
  backupSuffix?: string;
  /** Replace filesystem and logging behavior for tests or embedding. */
  adapter?: FileSystemAdapter;
  logger?: FileSystemLogger;
}

export interface WriteFileOptions {
  /** Defaults to false: existing files are protected from accidental overwrite. */
  overwrite?: boolean;
  /** Overrides the service-level backup setting for this write. */
  backup?: boolean;
}

export type CopyOptions = WriteFileOptions;

export interface DeleteOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface ListFilesOptions {
  recursive?: boolean;
}

export class FileExistsError extends Error {
  constructor(filePath: string) {
    super(
      `Refusing to overwrite existing path: ${filePath}. Pass { overwrite: true } to replace it.`,
    );
    this.name = 'FileExistsError';
  }
}

export class InvalidOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOperationError';
  }
}

const nodeFileSystemAdapter: FileSystemAdapter = {
  async access(filePath) {
    await nodeAccess(filePath);
  },
  async copy(sourcePath, destinationPath, options) {
    await nodeCopy(sourcePath, destinationPath, {
      recursive: true,
      force: options.overwrite,
      errorOnExist: !options.overwrite,
    });
  },
  async mkdir(directoryPath) {
    await nodeMkdir(directoryPath, { recursive: true });
  },
  async readFile(filePath) {
    return nodeReadFile(filePath, 'utf8');
  },
  async readdir(directoryPath) {
    return nodeReaddir(directoryPath, { withFileTypes: true });
  },
  async realpath(filePath) {
    return nodeRealpath(filePath);
  },
  async remove(filePath, options) {
    await nodeRemove(filePath, options);
  },
  async writeFile(filePath, contents, options) {
    await nodeWriteFile(filePath, contents, {
      encoding: 'utf8',
      flag: options.overwrite ? 'w' : 'wx',
    });
  },
};

const consoleLogger: FileSystemLogger = {
  log(action) {
    const source = action.sourcePath ? ` from ${action.sourcePath}` : '';
    const detail = action.detail ? ` (${action.detail})` : '';
    console.info(
      `[filesystem] ${action.operation} ${action.path}${source}: ${action.status}${detail}`,
    );
  },
};

/**
 * A root-confined filesystem service with injectable IO and structured action logging.
 * Paths are relative to rootDir; dry-run mode skips all mutations but still permits reads.
 */
export class FileSystemService {
  readonly rootDir: string;
  readonly dryRun: boolean;

  private readonly adapter: FileSystemAdapter;
  private readonly logger: FileSystemLogger;
  private readonly backupByDefault: boolean;
  private readonly backupSuffix: string;

  constructor(options: FileSystemServiceOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    this.dryRun = options.dryRun ?? false;
    this.backupByDefault = options.backup ?? false;
    this.backupSuffix = options.backupSuffix ?? '.bak';
    this.adapter = options.adapter ?? nodeFileSystemAdapter;
    this.logger = options.logger ?? consoleLogger;
  }

  async createDirectory(directoryPath: string): Promise<void> {
    const target = await this.resolvePath(directoryPath);
    await this.perform('createDirectory', directoryPath, () => this.adapter.mkdir(target), true);
  }

  async writeFile(
    filePath: string,
    contents: string,
    options: WriteFileOptions = {},
  ): Promise<void> {
    const target = await this.resolvePath(filePath);
    const overwrite = options.overwrite ?? false;
    const backup = options.backup ?? this.backupByDefault;

    await this.perform(
      'writeFile',
      filePath,
      async () => {
        const fileExists = await this.pathExists(target);
        if (fileExists && !overwrite) throw new FileExistsError(filePath);
        if (fileExists && backup) await this.createBackup(target, filePath);
        await this.adapter.writeFile(target, contents, { overwrite });
      },
      true,
    );
  }

  async readFile(filePath: string): Promise<string> {
    const target = await this.resolvePath(filePath);
    return this.perform('readFile', filePath, () => this.adapter.readFile(target), false);
  }

  async exists(filePath: string): Promise<boolean> {
    const target = await this.resolvePath(filePath);
    return this.perform('exists', filePath, () => this.pathExists(target), false);
  }

  async copy(
    sourcePath: string,
    destinationPath: string,
    options: CopyOptions = {},
  ): Promise<void> {
    const source = await this.resolvePath(sourcePath);
    const destination = await this.resolvePath(destinationPath);
    if (source === this.rootDir || destination === this.rootDir) {
      throw new InvalidOperationError(
        `Refusing to copy to or from the filesystem root "${this.rootDir}". Choose a path inside the root.`,
      );
    }
    if (destination === source || destination.startsWith(`${source}${path.sep}`)) {
      throw new InvalidOperationError(
        `Cannot copy "${sourcePath}" into itself or one of its descendants ("${destinationPath}").`,
      );
    }
    const overwrite = options.overwrite ?? false;
    const backup = options.backup ?? this.backupByDefault;

    await this.perform(
      'copy',
      destinationPath,
      async () => {
        if (!(await this.pathExists(source))) {
          throw new Error(`Cannot copy missing source: ${sourcePath}`);
        }
        const destinationExists = await this.pathExists(destination);
        if (destinationExists && !overwrite) throw new FileExistsError(destinationPath);
        if (destinationExists && backup) {
          await this.createBackup(destination, destinationPath);
        }
        await this.adapter.copy(source, destination, { overwrite });
      },
      true,
      { sourcePath },
    );
  }

  async delete(filePath: string, options: DeleteOptions = {}): Promise<void> {
    const target = await this.resolvePath(filePath);
    if (target === this.rootDir) {
      throw new InvalidOperationError(`Refusing to delete the filesystem root "${this.rootDir}".`);
    }
    await this.perform(
      'delete',
      filePath,
      () =>
        this.adapter.remove(target, {
          recursive: options.recursive ?? false,
          force: options.force ?? false,
        }),
      true,
    );
  }

  /** Returns file paths relative to the requested directory, in stable sorted order. */
  async listFiles(directoryPath = '.', options: ListFilesOptions = {}): Promise<string[]> {
    const directory = await this.resolvePath(directoryPath);
    return this.perform(
      'listFiles',
      directoryPath,
      async () => {
        const files: string[] = [];
        await this.collectFiles(directory, directory, options.recursive ?? true, files);
        return files.sort((left, right) => left.localeCompare(right));
      },
      false,
    );
  }

  private async createBackup(target: string, relativePath: string): Promise<void> {
    let backupPath = `${target}${this.backupSuffix}`;
    let suffix = 1;
    while (await this.pathExists(backupPath)) {
      backupPath = `${target}${this.backupSuffix}.${suffix}`;
      suffix += 1;
    }
    const relativeBackupPath = `${relativePath}${this.backupSuffix}${suffix > 1 ? `.${suffix - 1}` : ''}`;
    await ensureWithinRoot(this.rootDir, backupPath, relativeBackupPath, (filePath) =>
      this.adapter.realpath(filePath),
    );
    await this.perform(
      'backup',
      relativeBackupPath,
      () => this.adapter.copy(target, backupPath, { overwrite: false }),
      true,
      { sourcePath: relativePath },
    );
  }

  private async collectFiles(
    root: string,
    directory: string,
    recursive: boolean,
    files: string[],
  ): Promise<void> {
    const entries = await this.adapter.readdir(directory);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile()) {
        files.push(path.relative(root, entryPath).split(path.sep).join('/'));
      } else if (recursive && entry.isDirectory()) {
        await this.collectFiles(root, entryPath, true, files);
      }
    }
  }

  private async resolvePath(relativePath: string): Promise<string> {
    return resolveWithinRoot(this.rootDir, relativePath, (filePath) =>
      this.adapter.realpath(filePath),
    );
  }

  private async pathExists(target: string): Promise<boolean> {
    try {
      await this.adapter.access(target);
      return true;
    } catch (error) {
      if (isMissingPath(error)) return false;
      throw error;
    }
  }

  private async perform<T>(
    operation: FileSystemOperation,
    relativePath: string,
    action: () => Promise<T>,
    mutating: boolean,
    extra: Pick<FileSystemAction, 'sourcePath'> = {},
  ): Promise<T> {
    this.log({ operation, path: relativePath, status: 'started', dryRun: this.dryRun, ...extra });
    if (mutating && this.dryRun) {
      this.log({
        operation,
        path: relativePath,
        status: 'skipped',
        dryRun: true,
        detail: 'dry-run',
        ...extra,
      });
      return undefined as T;
    }

    try {
      const result = await action();
      this.log({
        operation,
        path: relativePath,
        status: 'succeeded',
        dryRun: this.dryRun,
        ...extra,
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log({
        operation,
        path: relativePath,
        status: 'failed',
        dryRun: this.dryRun,
        detail,
        ...extra,
      });
      throw error;
    }
  }

  private log(action: FileSystemAction): void {
    this.logger.log(action);
  }
}
