import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommand } from '../dist/cli/command-router.js';

test('resolves the entity command aliases', () => {
  assert.deepEqual(resolveCommand(['entity', 'Product']), {
    name: 'entity',
    args: ['Product'],
  });
  assert.deepEqual(resolveCommand(['generate', 'entity', 'Product']), {
    name: 'entity',
    args: ['Product'],
  });
  assert.deepEqual(resolveCommand(['g', 'e', 'Product']), {
    name: 'entity',
    args: ['Product'],
  });
});

test('resolves new, hello, and empty invocations', () => {
  assert.deepEqual(resolveCommand(['new', 'demo']), { name: 'new', args: ['demo'] });
  assert.deepEqual(resolveCommand(['hello']), { name: 'hello', args: [] });
  assert.deepEqual(resolveCommand([]), { name: 'help', args: [] });
  assert.deepEqual(resolveCommand(['--verbose']), { name: 'help', args: [] });
});

test('removes global verbosity flags from command arguments', () => {
  assert.deepEqual(resolveCommand(['--verbose', 'entity', 'Product', '--quiet']), {
    name: 'entity',
    args: ['Product'],
  });
});

test('reports unknown commands and generate targets', () => {
  const unknown = resolveCommand(['deploy']);
  assert.equal(unknown.name, 'unknown');
  assert.equal(unknown.unknownCommand, 'deploy');

  const unknownTarget = resolveCommand(['generate', 'project']);
  assert.equal(unknownTarget.name, 'unknown');
  assert.equal(unknownTarget.unknownCommand, 'project');
  assert.match(unknownTarget.error, /generate entity/);
});
