import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { Logger, shouldUseColor } from '../dist/utils/logger.js';

function createOutput() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function createLogger(options = {}) {
  const stdout = createOutput();
  const stderr = createOutput();
  const logger = new Logger({
    color: false,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...options,
  });
  return { logger, stdout, stderr };
}

function createSpinnerHarness() {
  const instances = [];
  const factory = ({ text, stream }) => {
    const spinner = {
      text,
      stream,
      started: false,
      stopped: false,
      finishedWith: undefined,
      finalText: undefined,
      start(value) {
        if (value !== undefined) spinner.text = value;
        spinner.started = true;
        return spinner;
      },
      stop() {
        spinner.stopped = true;
        return spinner;
      },
      succeed(value) {
        spinner.finishedWith = 'succeed';
        spinner.finalText = value ?? spinner.text;
        return spinner;
      },
      fail(value) {
        spinner.finishedWith = 'fail';
        spinner.finalText = value ?? spinner.text;
        return spinner;
      },
      warn(value) {
        spinner.finishedWith = 'warn';
        spinner.finalText = value ?? spinner.text;
        return spinner;
      },
      info(value) {
        spinner.finishedWith = 'info';
        spinner.finalText = value ?? spinner.text;
        return spinner;
      },
      clear() {
        return spinner;
      },
    };
    instances.push(spinner);
    return spinner;
  };
  return { factory, instances };
}

test('routes info, success, warnings, and errors to the right streams', () => {
  const { logger, stdout, stderr } = createLogger();

  logger.info('hello');
  logger.success('done');
  logger.warn('careful');
  logger.error('boom');

  assert.equal(stdout.text(), 'hello\n✔ done\n');
  assert.equal(stderr.text(), '⚠ careful\n✖ boom\n');
  assert.ok(!stdout.text().includes('\u001b['));
  assert.ok(!stderr.text().includes('\u001b['));
});

test('adds ANSI colors when colors are enabled', () => {
  const { logger, stdout } = createLogger({ color: true });

  logger.success('done');

  assert.ok(stdout.text().includes('\u001b['));
  assert.match(stdout.text(), /✔/);
  assert.match(stdout.text(), /done/);
});

test('quiet mode suppresses everything except errors', () => {
  const { logger, stdout, stderr } = createLogger({ quiet: true, verbose: true });

  logger.info('hello');
  logger.success('done');
  logger.warn('careful');
  logger.debug('details');
  logger.table([{ key: 'name', header: 'Name' }], [{ name: 'Product' }]);
  logger.error('boom');

  assert.equal(stdout.text(), '');
  assert.equal(stderr.text(), '✖ boom\n');
});

test('debug output only appears in verbose mode', () => {
  const normal = createLogger();
  normal.logger.debug('hidden');
  assert.equal(normal.stdout.text(), '');

  const verbose = createLogger({ verbose: true });
  verbose.logger.debug('details');
  assert.equal(verbose.stdout.text(), '[debug] details\n');
});

test('verbose errors include the cause stack', () => {
  const { logger, stderr } = createLogger({ verbose: true });

  logger.error('build failed', new Error('missing tool'));

  assert.match(stderr.text(), /✖ build failed/);
  assert.match(stderr.text(), /Error: missing tool/);
  assert.match(stderr.text(), /^\s+at /m);
});

test('renders aligned tables with headers and a divider', () => {
  const { logger, stdout } = createLogger();

  logger.table(
    [
      { key: 'name', header: 'Name' },
      { key: 'count', header: 'Count', align: 'right' },
    ],
    [
      { name: 'Product', count: 2 },
      { name: 'Category', count: 12 },
    ],
  );

  const lines = stdout.text().trimEnd().split('\n');
  assert.equal(lines[0], 'Name      Count');
  assert.equal(lines[1], '--------  -----');
  assert.equal(lines[2], 'Product       2');
  assert.equal(lines[3], 'Category     12');
});

test('renders an empty message when a table has no rows', () => {
  const { logger, stdout } = createLogger();

  logger.table([{ key: 'name', header: 'Name' }], [], { emptyMessage: 'No entities.' });

  const lines = stdout.text().trimEnd().split('\n');
  assert.deepEqual(lines, ['Name', '----', 'No entities.']);
});

test('keeps table columns aligned when cells contain ANSI colors', () => {
  const { logger, stdout } = createLogger();

  logger.table([{ key: 'status', header: 'S' }], [{ status: '\u001b[32mred\u001b[39m' }]);

  const lines = stdout.text().trimEnd().split('\n');
  assert.equal(lines[1], '---');
  assert.equal(lines[2], '\u001b[32mred\u001b[39m');
});

test('drives a spinner through start, update, and success', () => {
  const harness = createSpinnerHarness();
  const { logger } = createLogger({ createSpinner: harness.factory });

  const spinner = logger.startSpinner('Generating');
  assert.ok(spinner);
  assert.equal(harness.instances.length, 1);
  assert.equal(spinner.started, true);
  assert.equal(spinner.text, 'Generating');

  logger.updateSpinner('Almost done');
  assert.equal(spinner.text, 'Almost done');

  logger.succeedSpinner('Generated');
  assert.equal(spinner.finishedWith, 'succeed');
  assert.equal(spinner.finalText, 'Generated');

  logger.succeedSpinner('ignored');
  assert.equal(spinner.finalText, 'Generated');
});

test('stops an active spinner before starting another', () => {
  const harness = createSpinnerHarness();
  const { logger } = createLogger({ createSpinner: harness.factory });

  const first = logger.startSpinner('First');
  logger.startSpinner('Second');

  assert.equal(first.stopped, true);
  assert.equal(harness.instances.length, 2);
  assert.equal(harness.instances[1].text, 'Second');
});

test('withSpinner succeeds, fails, and rethrows task errors', async () => {
  const harness = createSpinnerHarness();
  const { logger } = createLogger({ createSpinner: harness.factory });

  const result = await logger.withSpinner('Working', async () => 42, { successText: 'Built' });
  assert.equal(result, 42);
  assert.equal(harness.instances[0].finishedWith, 'succeed');
  assert.equal(harness.instances[0].finalText, 'Built');

  await assert.rejects(
    logger.withSpinner('Working', async () => {
      throw new Error('task failed');
    }),
    /task failed/,
  );
  assert.equal(harness.instances[1].finishedWith, 'fail');
});

test('quiet mode does not create spinners but still runs the task', async () => {
  const harness = createSpinnerHarness();
  const { logger, stdout, stderr } = createLogger({
    quiet: true,
    createSpinner: harness.factory,
  });

  assert.equal(logger.startSpinner('Hidden'), undefined);
  assert.equal(harness.instances.length, 0);

  assert.equal(await logger.withSpinner('Hidden', async () => 'ok'), 'ok');
  assert.equal(harness.instances.length, 0);
  assert.equal(stdout.text(), '');
  assert.equal(stderr.text(), '');
});

test('detects color support from the environment and the stream', () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  assert.equal(shouldUseColor(tty, { TERM: 'xterm-256color' }), true);
  assert.equal(shouldUseColor(tty, { TERM: 'xterm-256color', NO_COLOR: '1' }), false);
  assert.equal(shouldUseColor(tty, { TERM: 'dumb' }), false);
  assert.equal(shouldUseColor(pipe, { FORCE_COLOR: '1' }), true);
  assert.equal(shouldUseColor(pipe, { FORCE_COLOR: '0' }), false);
});
