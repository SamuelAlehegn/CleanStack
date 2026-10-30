import type { Writable } from 'node:stream';
import ora from 'ora';
import picocolors from 'picocolors';

type Colors = ReturnType<typeof picocolors.createColors>;

export type TableAlignment = 'left' | 'right' | 'center';

export interface TableColumn {
  /** Key used to look the value up on each row. */
  key: string;
  /** Text shown in the header row. */
  header: string;
  /** Cell alignment. Defaults to left. */
  align?: TableAlignment;
}

export type TableRow = Record<string, unknown>;

export interface TableOptions {
  /** Message shown when there are no rows. Defaults to "No rows.". */
  emptyMessage?: string;
}

/** Minimal surface of ora's spinner that the logger depends on. */
export interface SpinnerLike {
  text: string;
  start(text?: string): SpinnerLike;
  stop(): SpinnerLike;
  succeed(text?: string): SpinnerLike;
  fail(text?: string): SpinnerLike;
  warn(text?: string): SpinnerLike;
  info(text?: string): SpinnerLike;
  clear(): SpinnerLike;
}

export type SpinnerFactory = (options: { text: string; stream: Writable }) => SpinnerLike;

export interface LoggerOptions {
  /** Enables debug output. */
  verbose?: boolean;
  /** Suppresses all output except errors. Takes precedence over verbose. */
  quiet?: boolean;
  /** Forces colors on or off. Defaults to TTY detection and NO_COLOR/FORCE_COLOR. */
  color?: boolean;
  /** Destination for info, success, debug, and table output. Defaults to process.stdout. */
  stdout?: Writable;
  /** Destination for warnings and errors. Defaults to process.stderr. */
  stderr?: Writable;
  /** Replaces the ora spinner factory, for example in tests. */
  createSpinner?: SpinnerFactory;
}

export interface SpinnerTaskOptions {
  /** Text to show when the task succeeds. Defaults to the initial spinner text. */
  successText?: string;
  /** Text to show when the task fails. Defaults to the initial spinner text. */
  failureText?: string;
}

/**
 * Console output for the CLI: colors, icons, spinner progress, verbosity
 * levels, and simple tables. Writes to injectable streams so it can be tested
 * and embedded without touching process stdout/stderr.
 */
export class Logger {
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly colorEnabled: boolean;

  private readonly stdout: Writable;
  private readonly stderr: Writable;
  private readonly colors: Colors;
  private readonly createSpinner: SpinnerFactory;
  private activeSpinner: SpinnerLike | undefined;

  constructor(options: LoggerOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.quiet = options.quiet ?? false;
    this.verbose = options.verbose ?? false;
    this.colorEnabled = options.color ?? shouldUseColor(this.stdout);
    this.colors = picocolors.createColors(this.colorEnabled);
    this.createSpinner =
      options.createSpinner ??
      (({ text, stream }) => ora({ text, stream, color: this.colorEnabled ? 'cyan' : false }));
  }

  /** Plain output. Hidden in quiet mode. */
  info(message: string): void {
    if (this.quiet) return;
    this.writeLine(this.stdout, message);
  }

  /** Green checkmark, for completed work. Hidden in quiet mode. */
  success(message: string): void {
    if (this.quiet) return;
    this.writeLine(this.stdout, `${this.colors.green('✔')} ${message}`);
  }

  /** Yellow warning icon, written to stderr. Hidden in quiet mode. */
  warn(message: string): void {
    if (this.quiet) return;
    this.writeLine(this.stderr, `${this.colors.yellow('⚠')} ${message}`);
  }

  /** Red error icon, written to stderr. Always shown, even in quiet mode. */
  error(message: string, cause?: unknown): void {
    this.writeLine(this.stderr, `${this.colors.red('✖')} ${message}`);
    if (cause !== undefined && this.verbose) {
      this.writeLine(this.stderr, this.colors.dim(indent(formatCause(cause))));
    }
  }

  /** Dimmed debug line, only shown in verbose mode. */
  debug(message: string): void {
    if (!this.verbose || this.quiet) return;
    this.writeLine(this.stdout, this.colors.dim(`[debug] ${message}`));
  }

  /** Renders a minimal, aligned table. Hidden in quiet mode. */
  table(columns: TableColumn[], rows: TableRow[], options: TableOptions = {}): void {
    if (this.quiet) return;
    if (columns.length === 0) throw new TypeError('A table requires at least one column.');

    const cells = rows.map((row) => columns.map((column) => formatCell(row[column.key])));
    const widths = columns.map((column, index) =>
      Math.max(displayWidth(column.header), ...cells.map((row) => displayWidth(row[index] ?? ''))),
    );

    const render = (values: string[]): string =>
      values
        .map((value, index) => padCell(value, widths[index] ?? 0, columns[index]?.align ?? 'left'))
        .join('  ');

    this.writeLine(this.stdout, this.colors.bold(render(columns.map((column) => column.header))));
    this.writeLine(
      this.stdout,
      this.colors.dim(widths.map((width) => '-'.repeat(width)).join('  ')),
    );

    if (cells.length === 0) {
      this.writeLine(this.stdout, this.colors.dim(options.emptyMessage ?? 'No rows.'));
      return;
    }

    for (const row of cells) this.writeLine(this.stdout, render(row));
  }

  /** Starts a spinner and returns its handle, or undefined in quiet mode. */
  startSpinner(text: string): SpinnerLike | undefined {
    if (this.quiet) return undefined;
    this.stopSpinner();

    const spinner = this.createSpinner({ text, stream: this.stderr });
    spinner.start();
    this.activeSpinner = spinner;
    return spinner;
  }

  /** Updates the text of the active spinner, if any. */
  updateSpinner(text: string): void {
    if (this.activeSpinner) this.activeSpinner.text = text;
  }

  /** Marks the active spinner as succeeded and clears it. */
  succeedSpinner(text?: string): void {
    this.finishSpinner('succeed', text);
  }

  /** Marks the active spinner as failed and clears it. */
  failSpinner(text?: string): void {
    this.finishSpinner('fail', text);
  }

  /** Marks the active spinner as warned and clears it. */
  warnSpinner(text?: string): void {
    this.finishSpinner('warn', text);
  }

  /** Stops and clears the active spinner without printing a final message. */
  stopSpinner(): void {
    this.activeSpinner?.stop();
    this.activeSpinner = undefined;
  }

  /**
   * Runs a task while showing a spinner. The spinner succeeds when the task
   * resolves and fails when it rejects; the rejection is re-thrown.
   */
  async withSpinner<T>(
    text: string,
    task: () => Promise<T>,
    options: SpinnerTaskOptions = {},
  ): Promise<T> {
    const spinner = this.startSpinner(text);
    try {
      const result = await task();
      spinner?.succeed(options.successText ?? text);
      this.activeSpinner = undefined;
      return result;
    } catch (error) {
      spinner?.fail(options.failureText ?? text);
      this.activeSpinner = undefined;
      throw error;
    }
  }

  private finishSpinner(method: 'succeed' | 'fail' | 'warn', text?: string): void {
    const spinner = this.activeSpinner;
    if (!spinner) return;
    this.activeSpinner = undefined;
    spinner[method](text);
  }

  private writeLine(stream: Writable, message: string): void {
    stream.write(`${message}\n`);
  }
}

/** Returns whether colored output should be used for a stream. */
export function shouldUseColor(
  stream: Writable = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment.NO_COLOR) return false;

  const forceColor = environment.FORCE_COLOR;
  if (forceColor === '0' || forceColor === 'false') return false;
  if (forceColor !== undefined && forceColor !== '') return true;

  const terminal = stream as Writable & { isTTY?: boolean };
  return Boolean(terminal.isTTY) && environment.TERM !== 'dumb';
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function displayWidth(value: string): number {
  return stripAnsi(value).length;
}

function padCell(value: string, width: number, align: TableAlignment): string {
  const padding = Math.max(0, width - displayWidth(value));
  if (align === 'right') return `${' '.repeat(padding)}${value}`;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${value}${' '.repeat(padding - left)}`;
  }
  return `${value}${' '.repeat(padding)}`;
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
