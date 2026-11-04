import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { CleanStackError } from '../utils/errors.js';
import { ensureWithinRoot, isMissingPath, resolveWithinRoot } from '../utils/path-safety.js';
import type { Logger } from '../utils/logger.js';
import type { BackendProject, GeneratedProject } from './project.js';

const execFileAsync = promisify(execFile);

/** Marker file written into a generated client directory. */
export const OPENAPI_CLIENT_MARKER = '.cleanstack-openapi.json';

/** Default output, relative to the generated Angular project. */
export const DEFAULT_OPENAPI_CLIENT_DIRECTORY = 'src/app/api/generated';

/** Default openapi-generator generator for Angular applications. */
export const DEFAULT_OPENAPI_GENERATOR = 'typescript-angular';

/** Default openapi-generator generator for Spring API interfaces. */
export const DEFAULT_SPRING_GENERATOR = 'spring';

/** Pinned generator used when the generated app has not installed it yet. */
export const OPENAPI_GENERATOR_PACKAGE = '@openapitools/openapi-generator-cli@2.42.0';

const JAVA_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SPEC_CANDIDATES = [
  'openapi/openapi.yaml',
  'openapi/openapi.yml',
  'openapi/openapi.json',
  'openapi.yaml',
  'openapi.yml',
  'openapi.json',
  'docs/openapi.yaml',
  'docs/openapi.yml',
  'docs/openapi.json',
  'src/main/resources/openapi.yaml',
  'src/main/resources/openapi.yml',
  'src/main/resources/openapi.json',
  'src/main/resources/static/openapi.yaml',
  'src/main/resources/static/openapi.yml',
  'src/main/resources/static/openapi.json',
] as const;

const PLACEHOLDER_FILE = '.gitkeep';
const GENERATOR_METADATA_DIRECTORY = '.openapi-generator';
const GENERATOR_IGNORE_FILE = '.openapi-generator-ignore';

export interface OpenApiDocumentInfo {
  /** Raw document contents, used for hashing and for URL downloads. */
  contents: string;
  /** Where the document came from, as shown to the user. */
  source: string;
  /** Local file path, or undefined when the document was fetched from a URL. */
  filePath?: string;
  hash: string;
  specVersion: string;
  title: string;
  version: string;
}

export interface OpenApiGeneratorInvocation {
  specPath: string;
  outputDir: string;
  generator: string;
  frontendDirectory: string;
}

export type OpenApiGeneratorRunner = (invocation: OpenApiGeneratorInvocation) => Promise<void>;

export interface SpringGeneratorInvocation {
  specPath: string;
  outputDir: string;
  generator: string;
  /** Directory used both as the working directory and local binary lookup root. */
  workingDirectory: string;
  /** Directory containing node_modules/.bin, when the Angular app has it installed. */
  localBinDirectory?: string;
  packageName: string;
  apiPackage: string;
  modelPackage: string;
}

export type SpringGeneratorRunner = (invocation: SpringGeneratorInvocation) => Promise<void>;

export interface GenerateAngularClientOptions {
  project: GeneratedProject;
  logger: Logger;
  /** OpenAPI document path or URL. Discovered from the project when omitted. */
  input?: string;
  /** Output directory relative to the Angular project. */
  output?: string;
  generator?: string;
  /** Allow writing over unowned files. Unknown files are still preserved. */
  force?: boolean;
  /** Perform generation in a temporary directory without writing to the project. */
  dryRun?: boolean;
  /** Injectable generator, primarily for tests. */
  runGenerator?: OpenApiGeneratorRunner;
  /** Injectable fetch implementation, primarily for tests. */
  fetchImpl?: typeof fetch;
  /** Directory used to resolve relative --input paths. Defaults to the project root. */
  cwd?: string;
}

export interface GenerateContractFirstOptions extends GenerateAngularClientOptions {
  /** Spring API output directory relative to the backend project. */
  backendOutput?: string;
  /** openapi-generator generator for the backend, default "spring". */
  springGenerator?: string;
  /** Injectable Spring generator, primarily for tests. */
  runBackendGenerator?: SpringGeneratorRunner;
}

export interface OpenApiClientSyncResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  /** Existing files that are not managed by CleanStack and were left untouched. */
  preserved: string[];
  warnings: string[];
  manifestPath: string;
}

export interface GenerateAngularClientResult extends OpenApiClientSyncResult {
  spec: OpenApiDocumentInfo;
  /** Output directory relative to the Angular project. */
  target: string;
  dryRun: boolean;
}

export interface SpringControllerGenerationResult extends OpenApiClientSyncResult {
  spec: OpenApiDocumentInfo;
  /** Output directory relative to the Spring Boot project. */
  target: string;
  /** Base package matching the output directory, for example com.acme.shop.api.generated. */
  packageName: string;
  apiPackage: string;
  modelPackage: string;
  dryRun: boolean;
}

export interface GenerateContractFirstResult {
  spec: OpenApiDocumentInfo;
  frontend: GenerateAngularClientResult;
  backend: SpringControllerGenerationResult;
  dryRun: boolean;
}

interface OpenApiClientManifest {
  version: 1;
  generatedBy: 'cleanstack';
  generator: string;
  spec: {
    source: string;
    hash: string;
  };
  /** Generated file path (relative to the client directory) to content hash. */
  files: Record<string, string>;
}

export interface SyncOpenApiClientOptions {
  stagingDir: string;
  targetDir: string;
  generator: string;
  specSource: string;
  specHash: string;
  force?: boolean;
  dryRun?: boolean;
  /** Only synchronize files accepted by this predicate. */
  include?: (relativePath: string) => boolean;
}

/**
 * Resolves, validates, generates, and safely synchronizes an Angular client.
 *
 * The OpenAPI generator always writes into a temporary directory. The project
 * is only touched after generation succeeds, and then only files listed in the
 * previous CleanStack manifest can be replaced or removed.
 */
export async function generateAngularClient(
  options: GenerateAngularClientOptions,
): Promise<GenerateAngularClientResult> {
  const frontend = options.project.frontend;
  if (frontend === undefined) {
    throw new CleanStackError('No Angular project was found in this CleanStack workspace.', {
      suggestions: [
        'Regenerate the project with a frontend, or run the command inside the Angular project.',
      ],
    });
  }

  const cwd = path.resolve(options.cwd ?? options.project.rootDir);
  const spec = await loadOpenApiDocument({
    project: options.project,
    cwd,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const target = await resolveClientDirectory(frontend.directory, options.output);
  const generator = options.generator ?? DEFAULT_OPENAPI_GENERATOR;
  const runner = options.runGenerator ?? runOpenApiGenerator;
  const dryRun = options.dryRun ?? false;

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'cleanstack-openapi-'));
  try {
    const specPath =
      spec.filePath ?? path.join(temporaryRoot, `openapi${extensionFor(spec.source)}`);
    if (spec.filePath === undefined) {
      await writeFile(specPath, spec.contents, 'utf8');
    }

    const stagingDir = path.join(temporaryRoot, 'client');
    await mkdir(stagingDir, { recursive: true });
    await runner({
      specPath,
      outputDir: stagingDir,
      generator,
      frontendDirectory: frontend.directory,
    });

    const generatedFiles = await listGeneratedFiles(stagingDir);
    if (generatedFiles.length === 0) {
      throw new CleanStackError(
        `The OpenAPI generator (${generator}) produced no files for "${spec.source}".`,
        {
          suggestions: [
            'Check that the document contains at least one path or schema.',
            'Run the generator manually with --verbose to inspect its output.',
          ],
        },
      );
    }

    const sync = await syncOpenApiClient({
      stagingDir,
      targetDir: target.absolute,
      generator,
      specSource: spec.source,
      specHash: spec.hash,
      ...(options.force === undefined ? {} : { force: options.force }),
      dryRun,
    });

    options.logger.debug(
      `OpenAPI spec ${spec.specVersion} "${spec.title}" ${spec.version} (${spec.hash.slice(0, 12)})`,
    );

    return { ...sync, spec, target: target.relative, dryRun };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Generates Spring API interfaces and the Angular client from one contract.
 *
 * The Spring generator runs in interface-only mode. It produces API interfaces
 * annotated with Spring MVC mappings plus request/response models. Projects
 * implement those interfaces with normal `@RestController` classes, so the
 * OpenAPI document remains the source of truth for both sides.
 */
export async function generateContractFirst(
  options: GenerateContractFirstOptions,
): Promise<GenerateContractFirstResult> {
  const frontend = options.project.frontend;
  if (frontend === undefined) {
    throw new CleanStackError('No Angular project was found in this CleanStack workspace.', {
      suggestions: [
        'Regenerate the project with a frontend, or run the command inside the Angular project.',
      ],
    });
  }
  const backend = options.project.backend;
  if (backend === undefined) {
    throw new CleanStackError(
      'Contract-first generation needs a Spring Boot project, but none was found.',
      {
        suggestions: [
          'Regenerate the project with a backend, or run the command inside the Spring Boot project.',
          'Use "cleanstack openapi" without --contract-first to generate only the Angular client.',
        ],
      },
    );
  }

  const cwd = path.resolve(options.cwd ?? options.project.rootDir);
  const spec = await loadOpenApiDocument({
    project: options.project,
    cwd,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const frontendTarget = await resolveClientDirectory(frontend.directory, options.output);
  const backendTarget = await resolveSpringDirectory(backend, options.backendOutput);
  const frontendGenerator = options.generator ?? DEFAULT_OPENAPI_GENERATOR;
  const springGenerator = options.springGenerator ?? DEFAULT_SPRING_GENERATOR;
  const runFrontendGenerator = options.runGenerator ?? runOpenApiGenerator;
  const runBackendGenerator = options.runBackendGenerator ?? runSpringGenerator;
  const dryRun = options.dryRun ?? false;

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'cleanstack-openapi-contract-'));
  try {
    const specPath =
      spec.filePath ?? path.join(temporaryRoot, `openapi${extensionFor(spec.source)}`);
    if (spec.filePath === undefined) {
      await writeFile(specPath, spec.contents, 'utf8');
    }

    const frontendStaging = path.join(temporaryRoot, 'client');
    const backendStaging = path.join(temporaryRoot, 'spring');
    await mkdir(frontendStaging, { recursive: true });
    await mkdir(backendStaging, { recursive: true });

    await runFrontendGenerator({
      specPath,
      outputDir: frontendStaging,
      generator: frontendGenerator,
      frontendDirectory: frontend.directory,
    });
    await runBackendGenerator({
      specPath,
      outputDir: backendStaging,
      generator: springGenerator,
      workingDirectory: frontend.directory,
      localBinDirectory: frontend.directory,
      packageName: backendTarget.packageName,
      apiPackage: backendTarget.apiPackage,
      modelPackage: backendTarget.modelPackage,
    });

    if ((await listGeneratedFiles(frontendStaging)).length === 0) {
      throw new CleanStackError(
        `The OpenAPI generator (${frontendGenerator}) produced no Angular client files for "${spec.source}".`,
        {
          suggestions: [
            'Check that the document contains at least one path or schema.',
            'Run the generator manually with --verbose to inspect its output.',
          ],
        },
      );
    }

    const backendPackageDir = path.join(backendStaging, ...backendTarget.packageName.split('.'));
    if (!(await isDirectory(backendPackageDir))) {
      throw new CleanStackError(
        `The OpenAPI generator (${springGenerator}) did not create the expected Java package "${backendTarget.packageName}".`,
        {
          suggestions: [
            'Check the generator output with --verbose.',
            'Make sure apiPackage and modelPackage use valid Java package names.',
          ],
        },
      );
    }
    const backendGenerated = await listRelativeFiles(backendPackageDir);
    if (!backendGenerated.some((file) => file.endsWith('.java'))) {
      throw new CleanStackError(
        `The OpenAPI generator (${springGenerator}) produced no Spring API files for "${spec.source}".`,
        {
          suggestions: [
            'Check that the document contains at least one operation or schema.',
            'Tag operations to control the generated interface names.',
          ],
        },
      );
    }

    const frontendSyncOptions: SyncOpenApiClientOptions = {
      stagingDir: frontendStaging,
      targetDir: frontendTarget.absolute,
      generator: frontendGenerator,
      specSource: spec.source,
      specHash: spec.hash,
      ...(options.force === undefined ? {} : { force: options.force }),
      dryRun,
    };
    const backendSyncOptions: SyncOpenApiClientOptions = {
      stagingDir: backendPackageDir,
      targetDir: backendTarget.absolute,
      generator: springGenerator,
      specSource: spec.source,
      specHash: spec.hash,
      ...(options.force === undefined ? {} : { force: options.force }),
      dryRun,
      include: (file) => file.endsWith('.java'),
    };

    // Plan both targets before writing either one so an unmanaged directory or
    // collision in the backend cannot leave the frontend half-regenerated.
    const frontendPlan = await syncOpenApiClient({ ...frontendSyncOptions, dryRun: true });
    const backendPlan = await syncOpenApiClient({ ...backendSyncOptions, dryRun: true });
    const frontendSync = dryRun ? frontendPlan : await syncOpenApiClient(frontendSyncOptions);
    const backendSync = dryRun ? backendPlan : await syncOpenApiClient(backendSyncOptions);

    options.logger.debug(
      `Contract-first ${spec.specVersion} "${spec.title}" ${spec.version}: ` +
        `${backendTarget.apiPackage} -> ${frontendTarget.relative}, ${backendTarget.relative}`,
    );

    return {
      spec,
      frontend: { ...frontendSync, spec, target: frontendTarget.relative, dryRun },
      backend: {
        ...backendSync,
        spec,
        target: backendTarget.relative,
        packageName: backendTarget.packageName,
        apiPackage: backendTarget.apiPackage,
        modelPackage: backendTarget.modelPackage,
        dryRun,
      },
      dryRun,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Loads an OpenAPI 3 document from a path, a URL, or a discovered project file. */
export async function loadOpenApiDocument(options: {
  project: GeneratedProject;
  cwd: string;
  input?: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenApiDocumentInfo> {
  const source = options.input ?? (await discoverSpecFile(options.project, options.cwd));
  if (/^https?:\/\//i.test(source)) {
    const fetchImpl = options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(source, { signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new CleanStackError(`Could not download the OpenAPI document from "${source}".`, {
        suggestions: [
          'Make sure the backend is running and the URL is reachable.',
          'The springdoc endpoint is usually http://localhost:8080/v3/api-docs.',
        ],
        cause: error,
      });
    }
    if (!response.ok) {
      throw new CleanStackError(
        `Downloading "${source}" failed with HTTP ${response.status} ${response.statusText}.`,
        {
          suggestions: [
            'Check the URL and make sure the backend is running.',
            'The springdoc endpoint is usually http://localhost:8080/v3/api-docs.',
          ],
        },
      );
    }
    const contents = await response.text();
    return parseOpenApiDocument(contents, source);
  }

  const filePath = path.resolve(options.cwd, source);
  if (!(await isFile(filePath))) {
    throw new CleanStackError(`OpenAPI document not found: ${filePath}`, {
      suggestions: [
        'Pass an explicit document with --input <path-or-url>.',
        'Save the backend spec with: curl http://localhost:8080/v3/api-docs -o openapi/openapi.json',
      ],
    });
  }
  const contents = await readFile(filePath, 'utf8');
  return { ...parseOpenApiDocument(contents, filePath), filePath };
}

/** Parses and validates an OpenAPI 3 document. */
export function parseOpenApiDocument(
  contents: string,
  source: string,
): Omit<OpenApiDocumentInfo, 'filePath'> {
  let document: unknown;
  try {
    document = parseYaml(contents);
  } catch (error) {
    throw new CleanStackError(`Could not parse the OpenAPI document "${source}".`, {
      suggestions: [
        'Check the YAML or JSON syntax.',
        'If the URL returns an HTML page, point it at /v3/api-docs instead.',
      ],
      cause: error,
    });
  }

  if (!isRecord(document)) {
    throw new CleanStackError(`"${source}" is not an OpenAPI document.`, {
      suggestions: ['The document must contain an "openapi" field and a "paths" object.'],
    });
  }

  if (typeof document.swagger === 'string') {
    throw new CleanStackError(
      `"${source}" uses Swagger ${document.swagger}; only OpenAPI 3 documents are supported.`,
      {
        suggestions: [
          'Upgrade the backend to springdoc-openapi 3.x so it publishes OpenAPI 3.',
          'Or convert the document to OpenAPI 3 before generating the client.',
        ],
      },
    );
  }

  if (typeof document.openapi !== 'string') {
    throw new CleanStackError(`"${source}" is not an OpenAPI 3 document.`, {
      suggestions: ['Make sure the document has an "openapi" version field (for example 3.1.0).'],
    });
  }
  if (!document.openapi.startsWith('3.')) {
    throw new CleanStackError(
      `"${source}" declares OpenAPI ${document.openapi}; only OpenAPI 3 is supported.`,
    );
  }

  const info = isRecord(document.info) ? document.info : {};
  const title = typeof info.title === 'string' ? info.title : 'Untitled API';
  const version = typeof info.version === 'string' ? info.version : '';

  return {
    contents,
    source,
    hash: sha256(contents),
    specVersion: document.openapi,
    title,
    version,
  };
}

/**
 * Synchronizes a generated client tree into the project.
 *
 * A manifest records every generated file and its hash. On regeneration only
 * tracked files can be replaced or removed; unknown files, including local
 * adapters placed inside the client directory, are preserved. Files modified
 * after generation produce warnings, and collisions with untracked files are
 * rejected unless `force` is set.
 */
export async function syncOpenApiClient(
  options: SyncOpenApiClientOptions,
): Promise<OpenApiClientSyncResult> {
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const manifestPath = path.join(options.targetDir, OPENAPI_CLIENT_MARKER);
  const targetExists = await isDirectory(options.targetDir);
  if (!targetExists && (await pathExists(options.targetDir))) {
    throw new CleanStackError(
      `The OpenAPI client output path is not a directory: ${options.targetDir}`,
      { suggestions: ['Choose a different directory with --output <path>.'] },
    );
  }

  const existingFiles = targetExists
    ? (await listRelativeFiles(options.targetDir)).filter(
        (file) => file !== OPENAPI_CLIENT_MARKER && !isPlaceholder(file),
      )
    : [];
  const previous = await readManifest(manifestPath);
  const warnings: string[] = [];

  if (existingFiles.length > 0 && previous === undefined && !force) {
    throw new CleanStackError(
      `Refusing to write the OpenAPI client into an unmanaged non-empty directory: ${options.targetDir}`,
      {
        suggestions: [
          'Use --force to replace colliding files; unknown files are still preserved.',
          'Or choose an empty directory with --output <path>.',
          `CleanStack only manages directories that contain ${OPENAPI_CLIENT_MARKER}.`,
        ],
      },
    );
  }

  const generatedFiles = await listRelativeFiles(options.stagingDir, {
    exclude: (file) =>
      file === GENERATOR_IGNORE_FILE || file.startsWith(`${GENERATOR_METADATA_DIRECTORY}/`),
  });
  const includedFiles = generatedFiles.filter((file) => options.include?.(file) ?? true);
  const generated = new Map<string, { contents: string; hash: string }>();
  for (const file of includedFiles) {
    const contents = await readFile(path.join(options.stagingDir, file), 'utf8');
    generated.set(file, { contents, hash: sha256(contents) });
  }

  const previousFiles = previous?.files ?? {};
  const collisions = [...generated.keys()].filter(
    (file) => existingFiles.includes(file) && previousFiles[file] === undefined,
  );
  if (collisions.length > 0 && !force) {
    throw new CleanStackError(
      `${collisions.length} generated file(s) would replace unmanaged files in ${options.targetDir}.`,
      {
        suggestions: [
          ...collisions.slice(0, 5).map((file) => `Move or delete: ${file}`),
          'Use --force to replace the colliding files. Files not produced by the generator are kept.',
        ],
      },
    );
  }
  for (const file of collisions) {
    warnings.push(`${file} already exists outside the CleanStack manifest and will be replaced.`);
  }

  for (const file of generated.keys()) {
    const trackedHash = previousFiles[file];
    if (trackedHash === undefined) continue;
    const targetFile = await safeTargetPath(options.targetDir, file);
    if (!(await isFile(targetFile))) continue;
    const currentHash = sha256(await readFile(targetFile, 'utf8'));
    if (currentHash !== trackedHash) {
      warnings.push(
        `${file} was modified after generation. Regenerating replaces those changes; keep customizations outside ${path.basename(options.targetDir)}.`,
      );
    }
  }

  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  for (const [file, generatedFile] of generated) {
    const targetFile = await safeTargetPath(options.targetDir, file);
    if (!(await isFile(targetFile))) {
      created.push(file);
      if (!dryRun) {
        await mkdir(path.dirname(targetFile), { recursive: true });
        await writeFile(targetFile, generatedFile.contents, 'utf8');
      }
      continue;
    }

    const current = await readFile(targetFile, 'utf8');
    if (current === generatedFile.contents) {
      unchanged.push(file);
      continue;
    }

    updated.push(file);
    if (!dryRun) await writeFile(targetFile, generatedFile.contents, 'utf8');
  }

  const stale = Object.keys(previousFiles)
    .filter((file) => !generated.has(file))
    .sort();
  for (const file of stale) {
    const targetFile = await safeTargetPath(options.targetDir, file);
    if (!(await isFile(targetFile))) continue;
    removed.push(file);
    if (!dryRun) {
      await rm(targetFile, { force: true });
      await removeEmptyParents(options.targetDir, path.dirname(targetFile));
    }
  }

  const preserved = existingFiles.filter(
    (file) => previousFiles[file] === undefined && !generated.has(file),
  );

  if (!dryRun) {
    const manifest: OpenApiClientManifest = {
      version: 1,
      generatedBy: 'cleanstack',
      generator: options.generator,
      spec: { source: options.specSource, hash: options.specHash },
      files: Object.fromEntries(
        [...generated.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, value]) => [file, value.hash]),
      ),
    };
    await mkdir(options.targetDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return { created, updated, unchanged, removed, preserved, warnings, manifestPath };
}

/** Builds the argument list passed to openapi-generator-cli for Angular. */
export function openApiGeneratorArguments(invocation: OpenApiGeneratorInvocation): string[] {
  return [
    'generate',
    '-i',
    invocation.specPath,
    '-g',
    invocation.generator,
    '-o',
    invocation.outputDir,
    '--additional-properties',
    'providedIn=root,useSingleRequestParameter=true,fileNaming=kebab-case,hideGenerationTimestamp=true',
    '--global-property',
    'apiTests=false,modelTests=false,apiDocs=false,modelDocs=false',
  ];
}

/**
 * Builds the argument list for the Spring generator in interface-only mode.
 * Generated sources declare packages matching the configured target directory.
 */
export function springGeneratorArguments(invocation: SpringGeneratorInvocation): string[] {
  return [
    'generate',
    '-i',
    invocation.specPath,
    '-g',
    invocation.generator,
    '-o',
    invocation.outputDir,
    '--additional-properties',
    [
      `apiPackage=${invocation.apiPackage}`,
      `modelPackage=${invocation.modelPackage}`,
      'interfaceOnly=true',
      'useSpringBoot4=true',
      'useJackson3=true',
      'useJspecify=true',
      'useTags=true',
      'skipDefaultInterface=true',
      'requestMappingMode=api_interface',
      'useBeanValidation=true',
      'useResponseEntity=true',
      'openApiNullable=false',
      'documentationProvider=none',
      'annotationLibrary=none',
      'useSpringController=false',
      'generateJsonIncludeAnnotations=false',
      'generateJsonSetterNullsAnnotations=false',
      'hideGenerationTimestamp=true',
      'sourceFolder=.',
    ].join(','),
    '--global-property',
    'apiTests=false,modelTests=false,apiDocs=false,modelDocs=false',
  ];
}

/**
 * Runs openapi-generator-cli from the Angular project. A locally installed
 * generator is used first; otherwise npx downloads the pinned package.
 */
export const runOpenApiGenerator: OpenApiGeneratorRunner = async (invocation) => {
  await runGeneratorCli({
    args: openApiGeneratorArguments(invocation),
    workingDirectory: invocation.frontendDirectory,
    localBinDirectory: invocation.frontendDirectory,
    label: 'the Angular client',
    manualCommand: `npx --yes ${OPENAPI_GENERATOR_PACKAGE} generate -i <spec> -g typescript-angular -o <output>`,
  });
};

/** Runs the Spring generator through the same local-or-npx strategy. */
export const runSpringGenerator: SpringGeneratorRunner = async (invocation) => {
  await runGeneratorCli({
    args: springGeneratorArguments(invocation),
    workingDirectory: invocation.workingDirectory,
    ...(invocation.localBinDirectory === undefined
      ? {}
      : { localBinDirectory: invocation.localBinDirectory }),
    label: 'the Spring API interfaces',
    manualCommand: `npx --yes ${OPENAPI_GENERATOR_PACKAGE} generate -i <spec> -g spring -o <output> --additional-properties interfaceOnly=true`,
  });
};

interface GeneratorCliOptions {
  args: string[];
  workingDirectory: string;
  localBinDirectory?: string;
  label: string;
  manualCommand: string;
}

async function runGeneratorCli(options: GeneratorCliOptions): Promise<void> {
  const localBinary =
    options.localBinDirectory === undefined
      ? undefined
      : path.join(
          options.localBinDirectory,
          'node_modules',
          '.bin',
          process.platform === 'win32' ? 'openapi-generator-cli.cmd' : 'openapi-generator-cli',
        );
  const useLocalBinary = localBinary !== undefined && (await isFile(localBinary));
  const command =
    useLocalBinary && localBinary !== undefined
      ? localBinary
      : process.platform === 'win32'
        ? 'npx.cmd'
        : 'npx';
  const args = useLocalBinary
    ? options.args
    : ['--yes', OPENAPI_GENERATOR_PACKAGE, ...options.args];

  try {
    await execFileAsync(command, args, {
      cwd: options.workingDirectory,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const output = generatorFailureDetail(error);
    throw new CleanStackError(
      `Generating ${options.label} with openapi-generator-cli failed${output === '' ? '.' : `:\n${output}`}`,
      {
        suggestions: [
          'Make sure Java 11 or later is installed and available on PATH.',
          `Run the generator manually from the generated project: ${options.manualCommand}`,
          'Run "cleanstack doctor" to check the local environment.',
        ],
        cause: error,
      },
    );
  }
}

async function discoverSpecFile(project: GeneratedProject, cwd: string): Promise<string> {
  const roots = [
    project.rootDir,
    project.workspaceRoot,
    cwd,
    ...(project.backend ? [project.backend.directory] : []),
  ];
  const candidates = [
    ...new Set(roots.flatMap((root) => SPEC_CANDIDATES.map((name) => path.resolve(root, name)))),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }

  throw new CleanStackError('No OpenAPI document was found in this project.', {
    suggestions: [
      'Start the backend and pass its spec URL: cleanstack openapi --input http://localhost:8080/v3/api-docs',
      'Or save the spec first: curl http://localhost:8080/v3/api-docs -o openapi/openapi.json',
      'Then run: cleanstack openapi --input openapi/openapi.json',
    ],
  });
}

async function resolveClientDirectory(
  frontendDirectory: string,
  output: string | undefined,
): Promise<{ absolute: string; relative: string }> {
  const requested = output ?? DEFAULT_OPENAPI_CLIENT_DIRECTORY;
  if (path.isAbsolute(requested)) {
    throw new CleanStackError('The OpenAPI client output must be inside the Angular project.', {
      suggestions: ['Pass a relative path such as --output src/app/api/generated.'],
    });
  }

  const absolute = path.resolve(frontendDirectory, requested);
  await ensureWithinRoot(frontendDirectory, absolute, requested);
  const relative = path.relative(frontendDirectory, absolute).split(path.sep).join('/');
  if (relative === '') {
    throw new CleanStackError('The OpenAPI client output cannot be the Angular project root.', {
      suggestions: ['Choose a dedicated directory such as src/app/api/generated.'],
    });
  }
  return { absolute, relative };
}

interface SpringTargetDirectory {
  absolute: string;
  relative: string;
  packageName: string;
  apiPackage: string;
  modelPackage: string;
}

async function resolveSpringDirectory(
  backend: BackendProject,
  output: string | undefined,
): Promise<SpringTargetDirectory> {
  const packagePath = backend.packageName.split('.');
  const requested =
    output ?? path.posix.join('src', 'main', 'java', ...packagePath, 'api', 'generated');
  if (path.isAbsolute(requested)) {
    throw new CleanStackError('The Spring API output must be inside the Spring Boot project.', {
      suggestions: ['Pass a relative path such as --backend-output src/main/java/com/acme/api.'],
    });
  }

  const absolute = path.resolve(backend.directory, requested);
  await ensureWithinRoot(backend.directory, absolute, requested);

  const sourceRoot = path.join(backend.directory, 'src', 'main', 'java');
  const relativeToSource = path.relative(sourceRoot, absolute);
  if (
    relativeToSource === '' ||
    relativeToSource === '..' ||
    relativeToSource.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToSource)
  ) {
    throw new CleanStackError(
      'The Spring API output must be a package directory under src/main/java.',
      {
        suggestions: [
          'Use --backend-output src/main/java/com/acme/api/generated.',
          'The generated directory name becomes the base Java package.',
        ],
      },
    );
  }

  const segments = relativeToSource.split(path.sep).filter((segment) => segment !== '');
  if (segments.length === 0 || segments.some((segment) => !JAVA_IDENTIFIER_PATTERN.test(segment))) {
    throw new CleanStackError(
      `The Spring API output path does not form a valid Java package: ${relativeToSource}`,
      {
        suggestions: [
          'Use only letters, digits, and underscores in each directory name.',
          'Java package segments cannot start with a digit or contain hyphens.',
        ],
      },
    );
  }

  const packageName = segments.join('.');
  return {
    absolute,
    relative: path.relative(backend.directory, absolute).split(path.sep).join('/'),
    packageName,
    apiPackage: `${packageName}.api`,
    modelPackage: `${packageName}.model`,
  };
}

async function listGeneratedFiles(stagingDir: string): Promise<string[]> {
  return listRelativeFiles(stagingDir, {
    exclude: (file) =>
      file === OPENAPI_CLIENT_MARKER ||
      file === GENERATOR_IGNORE_FILE ||
      file.startsWith(`${GENERATOR_METADATA_DIRECTORY}/`),
  });
}

async function listRelativeFiles(
  root: string,
  options: { exclude?: (relativePath: string) => boolean } = {},
): Promise<string[]> {
  const files: string[] = [];
  await collectFiles(root, root, files, options.exclude);
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(
  root: string,
  directory: string,
  files: string[],
  exclude: ((relativePath: string) => boolean) | undefined,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(root, entryPath).split(path.sep).join('/');
    if (exclude?.(relative)) continue;
    if (entry.isDirectory()) {
      await collectFiles(root, entryPath, files, exclude);
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
}

async function readManifest(manifestPath: string): Promise<OpenApiClientManifest | undefined> {
  let contents: string;
  try {
    contents = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }

  try {
    const value = JSON.parse(contents) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.generatedBy !== 'cleanstack' ||
      typeof value.generator !== 'string' ||
      !isRecord(value.spec) ||
      typeof value.spec.source !== 'string' ||
      typeof value.spec.hash !== 'string' ||
      !isRecord(value.files)
    ) {
      return undefined;
    }

    const files: Record<string, string> = {};
    for (const [file, hash] of Object.entries(value.files)) {
      if (typeof hash !== 'string' || !isSafeRelativePath(file)) return undefined;
      files[file] = hash;
    }

    return {
      version: 1,
      generatedBy: 'cleanstack',
      generator: value.generator,
      spec: { source: value.spec.source, hash: value.spec.hash },
      files,
    };
  } catch {
    return undefined;
  }
}

async function safeTargetPath(rootDir: string, relativePath: string): Promise<string> {
  return resolveWithinRoot(rootDir, relativePath);
}

async function removeEmptyParents(rootDir: string, directory: string): Promise<void> {
  let current = directory;
  while (current !== rootDir && current.startsWith(`${rootDir}${path.sep}`)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function generatorFailureDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const details: string[] = [];
  for (const key of ['stderr', 'stdout'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim() !== '') details.push(value.trim());
  }
  const message = (error as Record<string, unknown>).message;
  if (details.length === 0 && typeof message === 'string') details.push(message);
  return details.join('\n').split('\n').slice(-12).join('\n');
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function extensionFor(source: string): string {
  const extension = path.extname(source).toLowerCase();
  return extension === '.json' || extension === '.yaml' || extension === '.yml'
    ? extension
    : '.json';
}

function isPlaceholder(relativePath: string): boolean {
  return path.posix.basename(relativePath) === PLACEHOLDER_FILE;
}

function isSafeRelativePath(value: string): boolean {
  if (value === '' || path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  return !normalized.split('/').includes('..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}
