import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { CliOptionError } from '../dist/core/config-loader.js';
import { ProjectConfigSchema } from '../dist/core/config.js';
import { formatError, formatZodError } from '../dist/utils/errors.js';

test('formats zod issues with readable array paths and enum values', () => {
  const result = ProjectConfigSchema.safeParse({
    name: '',
    packageName: 'com.example',
    options: { database: 'oracle' },
    entities: [{ name: 'Product', fields: [{ name: 'price', type: 'Money' }] }],
  });
  assert.equal(result.success, false);

  const output = formatZodError(result.error);
  assert.match(output, /• name: Must not be empty\./);
  assert.match(
    output,
    /• options\.database: Invalid value\. Expected one of: "postgresql", "mysql", "h2"\./,
  );
  assert.match(output, /• entities\[0\]\.fields\[0\]\.type: Invalid value\. Expected one of:/);
});

test('explains unknown configuration keys instead of only saying unrecognized', () => {
  const result = ProjectConfigSchema.safeParse({ name: 'shop', package: 'com.acme' });
  assert.equal(result.success, false);

  assert.match(formatZodError(result.error), /Unknown key "package"\. Remove it or check/);
});

test('formatError includes suggestions from CleanStack errors', () => {
  assert.equal(
    formatError(new CliOptionError('Something went wrong.', ['Try the other flag.'])),
    'Something went wrong.\n\n  Hint: Try the other flag.',
  );
});

test('formatError pretty prints zod errors', () => {
  const result = z.object({ name: z.string().min(1) }).safeParse({ name: '' });
  assert.equal(result.success, false);
  const output = formatError(result.error);
  assert.match(output, /The configuration is invalid:/);
  assert.match(output, /• name: Must not be empty\./);
  assert.match(output, /Hint: Fix the highlighted fields/);
});

test('formatError adds hints for common filesystem errors', () => {
  const missing = Object.assign(new Error('ENOENT: no such file or directory'), {
    code: 'ENOENT',
  });
  assert.match(formatError(missing), /Hint: Check that the file or directory exists\./);

  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  assert.match(formatError(denied), /Hint: Check file permissions/);
});
