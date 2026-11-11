import assert from 'node:assert/strict';
import test from 'node:test';
import { reportGeneratedFiles } from '../dist/cli/file-report.js';

function recordingLogger() {
  const messages = [];
  const record = (level) => (message) => messages.push(`${level}: ${message}`);
  return {
    messages,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

function result(path, status) {
  return { path, status, decisions: [], conflicts: [], warnings: [] };
}

test('keeps per-file output at debug level during a real run', () => {
  const logger = recordingLogger();
  reportGeneratedFiles(
    logger,
    [result('src/Product.java', 'created'), result('src/Category.java', 'unchanged')],
    { dryRun: false, force: false },
  );

  assert.ok(!logger.messages.some((message) => message.startsWith('info: create ')));
  assert.ok(logger.messages.includes('debug: create src/Product.java'));
  assert.ok(logger.messages.includes('debug: unchanged src/Category.java'));
  assert.ok(
    logger.messages.includes('info: Files: 1 created, 0 updated, 0 overwritten, 1 unchanged.'),
  );
});

test('keeps per-file detail visible during a dry run', () => {
  const logger = recordingLogger();
  reportGeneratedFiles(logger, [result('src/Product.java', 'updated')], {
    dryRun: true,
    force: false,
  });

  assert.ok(logger.messages.includes('info: would update src/Product.java'));
  assert.ok(
    logger.messages.includes(
      'info: Dry run: 0 to create, 1 to update, 0 to overwrite, 0 unchanged, 0 preserved, 0 conflicted.',
    ),
  );
});
