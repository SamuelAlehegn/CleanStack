import Handlebars from 'handlebars';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWithinRoot, isMissingPath, resolveWithinRoot } from '../utils/path-safety.js';
import { CleanStackError } from '../utils/errors.js';
import {
  lineEndingForFile,
  normalizeLineEndings,
  stripBom,
  type LineEnding,
} from '../utils/text.js';

export interface TemplateEngineOptions {
  /** Root of the project whose templates are rendered. Defaults to process.cwd(). */
  projectRoot?: string;
  /** User template directory. Defaults to ~/.cleanstack/templates. */
  userTemplatesDir?: string;
  /** Built-in template directory. Defaults to <package-root>/templates. */
  builtInTemplatesDir?: string;
  /** File extension used when a template name has no extension. Defaults to .hbs. */
  extension?: string;
}

export class TemplateNotFoundError extends CleanStackError {
  readonly templateName: string;
  readonly searchedPaths: string[];

  constructor(templateName: string, searchedPaths: string[]) {
    super(
      `Template "${templateName}" was not found. Searched:\n${searchedPaths
        .map((filePath) => `  - ${filePath}`)
        .join('\n')}`,
      {
        suggestions: [
          'Run "cleanstack templates list" to see the available templates and where they resolve from.',
          'Run "cleanstack templates init" to copy the built-in templates into the project.',
        ],
      },
    );
    this.name = 'TemplateNotFoundError';
    this.templateName = templateName;
    this.searchedPaths = searchedPaths;
  }
}

interface ResolvedTemplate {
  filePath: string;
  root: string;
}

type HandlebarsEnvironment = ReturnType<typeof Handlebars.create>;
type CompiledTemplate = ReturnType<typeof Handlebars.compile>;

interface CompiledTemplateCacheEntry {
  compiled: CompiledTemplate;
  mtimeMs: number;
  size: number;
}

export type TemplateOverrideLocation = 'project' | 'user' | 'built-in';

export interface ResolvedTemplateLocation {
  /** Absolute file path of the template that will be rendered. */
  filePath: string;
  /** Which override level the template was found at, in precedence order. */
  location: TemplateOverrideLocation;
  /** The override root directory that supplied the template. */
  rootDir: string;
}

const DEFAULT_EXTENSION = '.hbs';
/** Shipped template packs, used as the final fallback of the override chain. */
export const BUILT_IN_TEMPLATE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../templates',
);

/** Renders Handlebars templates without writing to the filesystem. */
export class TemplateEngine {
  private readonly roots: string[];
  private readonly extension: string;
  /**
   * One Handlebars environment per engine, so helpers and partials are
   * registered once instead of on every render.
   */
  private environment: Promise<HandlebarsEnvironment> | undefined;
  /** Compiled templates keyed by resolved file path, validated by mtime and size. */
  private readonly compiledTemplates = new Map<string, CompiledTemplateCacheEntry>();
  /** Concurrent renders of the same template share one compilation. */
  private readonly pendingCompilations = new Map<string, Promise<CompiledTemplate>>();

  constructor(options: TemplateEngineOptions = {}) {
    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    const userTemplatesDir = path.resolve(
      options.userTemplatesDir ?? path.join(getUserHome(), '.cleanstack', 'templates'),
    );
    const builtInTemplatesDir = path.resolve(options.builtInTemplatesDir ?? BUILT_IN_TEMPLATE_ROOT);

    this.roots = [
      path.join(projectRoot, '.cleanstack', 'templates'),
      userTemplatesDir,
      builtInTemplatesDir,
    ];
    this.extension = normalizeExtension(options.extension ?? DEFAULT_EXTENSION);
  }

  /**
   * Render a template by relative name. Project templates take precedence over user
   * templates, which take precedence over the built-in templates.
   */
  async render(templateName: string, context: Record<string, unknown>): Promise<string> {
    const resolved = await this.resolveTemplate(templateName);

    try {
      // Generated source code must not be HTML-escaped.
      const compiled = await this.getCompiledTemplate(resolved.filePath);
      const rendered = stripBom(compiled(context));
      return normalizeLineEndings(
        rendered,
        lineEndingForTemplate(resolved.filePath, this.extension),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to render template "${templateName}" (${resolved.filePath}): ${detail}`,
        {
          cause: error,
        },
      );
    }
  }

  /**
   * Drops compiled templates, cached partials, and helper registrations.
   * Long-running embedders call this after editing template files in place;
   * the CLI creates a fresh engine per command and rarely needs it.
   */
  clearCache(): void {
    this.compiledTemplates.clear();
    this.pendingCompilations.clear();
    this.environment = undefined;
  }

  /**
   * Finds the file that would back a single template and reports where it came
   * from, without rendering it. Callers use this for discovery, diffing, and
   * diagnostics on top of the override chain.
   */
  async resolve(templateName: string): Promise<ResolvedTemplateLocation> {
    const resolved = await this.resolveTemplate(templateName);
    const index = this.roots.indexOf(resolved.root);
    const location: TemplateOverrideLocation =
      index === 0 ? 'project' : index === 1 ? 'user' : 'built-in';
    return {
      filePath: resolved.filePath,
      location,
      rootDir: resolved.root,
    };
  }

  private async resolveTemplate(templateName: string): Promise<ResolvedTemplate> {
    const relativeName = normalizeTemplateName(templateName, this.extension);
    const searchedPaths: string[] = [];

    for (const root of this.roots) {
      // Symlinks are followed for reads, but must stay inside the template root.
      const filePath = await resolveWithinRoot(root, relativeName);
      searchedPaths.push(filePath);
      try {
        if ((await stat(filePath)).isFile()) return { filePath, root };
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }

    throw new TemplateNotFoundError(templateName, searchedPaths);
  }

  /**
   * Returns a compiled template, reusing it while the source file is unchanged.
   * The stat check keeps the cache correct for watch modes and web sessions
   * where an override may be edited between renders.
   */
  private async getCompiledTemplate(filePath: string): Promise<CompiledTemplate> {
    const fileStats = await stat(filePath);
    const cached = this.compiledTemplates.get(filePath);
    if (cached && cached.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) {
      return cached.compiled;
    }

    const pending = this.pendingCompilations.get(filePath);
    if (pending) return pending;

    const compilation = (async () => {
      const source = stripBom(await readFile(filePath, 'utf8'));
      const handlebars = await this.getEnvironment();
      const compiled = handlebars.compile(source, { strict: true, noEscape: true });
      this.compiledTemplates.set(filePath, {
        compiled,
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
      });
      return compiled;
    })();

    this.pendingCompilations.set(filePath, compilation);
    try {
      return await compilation;
    } finally {
      this.pendingCompilations.delete(filePath);
    }
  }

  private getEnvironment(): Promise<HandlebarsEnvironment> {
    this.environment ??= (async () => {
      const handlebars = Handlebars.create();
      registerHelpers(handlebars);
      await this.registerPartials(handlebars);
      return handlebars;
    })().catch((error: unknown) => {
      // A failed initialization must not poison the engine; the next render retries.
      this.environment = undefined;
      throw error;
    });
    return this.environment;
  }

  private async registerPartials(handlebars: HandlebarsEnvironment): Promise<void> {
    const registered = new Set<string>();

    // First registration wins, so the roots' configured priority is preserved.
    for (const root of this.roots) {
      const partialRoot = path.join(root, 'partials');
      await ensureWithinRoot(root, partialRoot, path.join('partials'));
      const partialFiles = await listFiles(partialRoot, this.extension);
      for (const filePath of partialFiles) {
        const relative = path.relative(partialRoot, filePath);
        const partialName = relative.slice(0, -this.extension.length).split(path.sep).join('/');
        if (registered.has(partialName)) continue;

        try {
          handlebars.registerPartial(partialName, stripBom(await readFile(filePath, 'utf8')));
          registered.add(partialName);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Unable to load partial "${partialName}" (${filePath}): ${detail}`, {
            cause: error,
          });
        }
      }
    }
  }
}

function registerHelpers(handlebars: typeof Handlebars): void {
  handlebars.registerHelper('camelCase', (value: unknown) => toCamelCase(String(value ?? '')));
  handlebars.registerHelper('pascalCase', (value: unknown) => toPascalCase(String(value ?? '')));
  handlebars.registerHelper('kebabCase', (value: unknown) =>
    toWords(String(value ?? '')).join('-'),
  );
  handlebars.registerHelper('snakeCase', (value: unknown) =>
    toWords(String(value ?? '')).join('_'),
  );
  handlebars.registerHelper('packagePath', (value: unknown) =>
    String(value ?? '')
      .split('.')
      .filter(Boolean)
      .join('/'),
  );
  handlebars.registerHelper('capitalize', (value: unknown) => {
    const text = String(value ?? '');
    return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
  });
  handlebars.registerHelper('lowercase', (value: unknown) => String(value ?? '').toLowerCase());
  handlebars.registerHelper('uppercase', (value: unknown) => String(value ?? '').toUpperCase());
  handlebars.registerHelper('pluralize', (...args: unknown[]) => pluralizeHelper(args));
  handlebars.registerHelper('eq', (left: unknown, right: unknown) => left === right);
  handlebars.registerHelper('or', (...args: unknown[]) =>
    args.filter((value) => !isHandlebarsOptions(value)).some(Boolean),
  );
  handlebars.registerHelper('json', (value: unknown) => {
    const serialized = JSON.stringify(value, null, 2) ?? 'undefined';
    return new Handlebars.SafeString(serialized);
  });
}

function pluralizeHelper(args: unknown[]): string {
  const values = args.filter((value) => !isHandlebarsOptions(value));
  if (typeof values[0] === 'number' && typeof values[1] === 'string') {
    return values[0] === 1 ? values[1] : pluralizeWord(values[1]);
  }
  return pluralizeWord(String(values[0] ?? ''));
}

function isHandlebarsOptions(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'hash' in value && 'data' in value;
}

function pluralizeWord(word: string): string {
  const irregular: Record<string, string> = {
    child: 'children',
    foot: 'feet',
    mouse: 'mice',
    person: 'people',
  };
  const lower = word.toLowerCase();
  const irregularPlural = irregular[lower];
  if (irregularPlural) return matchCase(word, irregularPlural);
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/fe$/i.test(word)) return `${word.slice(0, -2)}ves`;
  if (/f$/i.test(word)) return `${word.slice(0, -1)}ves`;
  return `${word}s`;
}

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0]?.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function toCamelCase(value: string): string {
  const words = toWords(value);
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join('');
}

function toPascalCase(value: string): string {
  return toWords(value)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function normalizeTemplateName(name: string, extension: string): string {
  if (!name.trim()) throw new TypeError('Template name must not be empty.');
  const normalized = name.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new TypeError(`Template name must be a relative path: "${name}".`);
  }
  return path.normalize(path.extname(normalized) ? normalized : `${normalized}${extension}`);
}

function normalizeExtension(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`;
}

/**
 * Template filenames mirror their destination names, apart from the trailing
 * template extension. That lets direct renders of mvnw.cmd.hbs emit CRLF just
 * like manifest-driven generation does.
 */
function lineEndingForTemplate(filePath: string, extension: string): LineEnding {
  const destination = filePath.endsWith(extension)
    ? filePath.slice(0, -extension.length)
    : filePath;
  return lineEndingForFile(destination);
}

/**
 * Home directory used for the user-level override chain. `os.homedir()` reads
 * HOME on POSIX and USERPROFILE on Windows, so redirected environments behave
 * consistently; the env fallbacks keep exotic setups working.
 */
export function getUserHome(): string {
  return homedir() || process.env.HOME || process.env.USERPROFILE || process.cwd();
}

async function listFiles(directory: string, extension: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(entryPath, extension);
      return entry.isFile() && entry.name.endsWith(extension) ? [entryPath] : [];
    }),
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
}
