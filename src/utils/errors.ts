import { ZodError, type ZodIssue } from 'zod';

export interface CleanStackErrorOptions {
  /** Actionable next steps shown below the error message. */
  suggestions?: string[];
  cause?: unknown;
}

/**
 * Base class for errors that can explain how to recover. The CLI prints the
 * suggestions after the message, so users see what to do rather than only what
 * went wrong.
 */
export class CleanStackError extends Error {
  readonly suggestions: string[];

  constructor(message: string, options: CleanStackErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CleanStackError';
    this.suggestions = options.suggestions ?? [];
  }
}

/**
 * Formats Zod issues as an indented, one-per-line list with readable array
 * paths. Unknown keys and enum values get friendlier wording than the raw Zod
 * messages.
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `  • ${formatPath(issue.path)}: ${formatIssue(issue)}`)
    .join('\n');
}

/**
 * Converts any thrown value into a complete CLI error report, including hints
 * for common filesystem mistakes and validation failures.
 */
export function formatError(error: unknown): string {
  if (error instanceof ZodError) {
    return [
      'The configuration is invalid:',
      formatZodError(error),
      '',
      '  Hint: Fix the highlighted fields and run the command again.',
    ].join('\n');
  }
  if (error instanceof CleanStackError) {
    return withSuggestions(error.message, error.suggestions);
  }
  if (error instanceof Error) {
    return withSuggestions(error.message, suggestionsForError(error));
  }
  return String(error);
}

/** Appends indented hint lines to a message. */
export function withSuggestions(message: string, suggestions: readonly string[]): string {
  if (suggestions.length === 0) return message;
  return `${message}\n\n${suggestions.map((suggestion) => `  Hint: ${suggestion}`).join('\n')}`;
}

function formatPath(segments: PropertyKey[]): string {
  let result = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      result += `[${segment}]`;
      continue;
    }
    const text = String(segment);
    if (/^[A-Za-z_$][\w$]*$/.test(text)) {
      result += result === '' ? text : `.${text}`;
    } else {
      result += `[${JSON.stringify(text)}]`;
    }
  }
  return result === '' ? '(root)' : result;
}

function formatIssue(issue: ZodIssue): string {
  if (issue.code === 'invalid_value' && 'values' in issue && Array.isArray(issue.values)) {
    const values = issue.values as unknown[];
    if (values.length > 0) {
      return `Invalid value. Expected one of: ${values.map((value) => JSON.stringify(value)).join(', ')}.`;
    }
  }
  if (issue.code === 'unrecognized_keys' && 'keys' in issue && Array.isArray(issue.keys)) {
    const keys = issue.keys as string[];
    const label = keys.length === 1 ? 'key' : 'keys';
    const pronoun = keys.length === 1 ? 'it' : 'them';
    return `Unknown ${label} ${keys.map((key) => `"${key}"`).join(', ')}. Remove ${pronoun} or check the spelling.`;
  }
  if (issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) === 1) {
    return 'Must not be empty.';
  }
  return issue.message;
}

function suggestionsForError(error: Error): string[] {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOENT':
      return [
        'Check that the file or directory exists.',
        'Run the command from the directory that contains the project, or pass an explicit path.',
      ];
    case 'EACCES':
    case 'EPERM':
      return ['Check file permissions, or run the command from a directory you can write to.'];
    case 'ENOSPC':
      return ['Free some disk space and try again.'];
    case 'EEXIST':
      return ['The path already exists. Use --force to overwrite generated files.'];
  }

  if (/Unexpected token|JSON/i.test(error.message)) {
    return ['Check the JSON syntax near the position reported above.'];
  }
  if (/YAML|flow sequence|implicit key/i.test(error.message)) {
    return ['Check the YAML indentation and use "key: value" syntax.'];
  }
  return [];
}
