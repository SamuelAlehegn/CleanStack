import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectConfigSchema } from '../dist/core/config.js';

function expectIssue(config, pattern) {
  assert.throws(
    () => ProjectConfigSchema.parse(config),
    (error) => {
      assert.equal(error.name, 'ZodError');
      assert.ok(
        error.issues.some((issue) => pattern.test(issue.message)),
        `expected an issue matching ${pattern}, received ${JSON.stringify(error.issues)}`,
      );
      return true;
    },
  );
}

test('accepts a complete configuration with relations', () => {
  const config = ProjectConfigSchema.parse({
    name: 'shop',
    packageName: 'com.acme.shop',
    entities: [
      {
        name: 'Product',
        fields: [{ name: 'title', type: 'String' }],
        relations: [{ name: 'category', type: 'many-to-one', target: 'Category' }],
      },
      { name: 'Category' },
    ],
  });

  assert.equal(config.entities.length, 2);
  assert.equal(config.entities[0].relations[0].target, 'Category');
  assert.equal(config.options.database, 'postgresql');
});

test('rejects an invalid Java package name', () => {
  expectIssue({ name: 'shop', packageName: 'not a package!' }, /valid Java package name/);
});

test('rejects blank names', () => {
  expectIssue({ name: '   ' }, /Too small|expected string/i);
  expectIssue({ name: 'shop', entities: [{ name: ' ' }] }, /Too small|expected string/i);
});

test('rejects duplicate entity names regardless of case', () => {
  expectIssue(
    { name: 'shop', entities: [{ name: 'Product' }, { name: 'product' }] },
    /Duplicate entity "product"/,
  );
});

test('rejects duplicate fields and relations on an entity', () => {
  expectIssue(
    {
      name: 'shop',
      entities: [
        {
          name: 'Product',
          fields: [
            { name: 'title', type: 'String' },
            { name: 'title', type: 'String' },
          ],
        },
      ],
    },
    /Duplicate field "title"/,
  );

  expectIssue(
    {
      name: 'shop',
      entities: [
        {
          name: 'Product',
          relations: [
            { name: 'category', type: 'many-to-one', target: 'Category' },
            { name: 'category', type: 'many-to-one', target: 'Category' },
          ],
        },
        { name: 'Category' },
      ],
    },
    /Duplicate relation "category"/,
  );
});

test('rejects relations that target unknown entities', () => {
  expectIssue(
    {
      name: 'shop',
      entities: [
        {
          name: 'Product',
          relations: [{ name: 'category', type: 'many-to-one', target: 'Missing' }],
        },
      ],
    },
    /targets unknown entity "Missing"/,
  );
});

test('rejects unknown keys at every level', () => {
  expectIssue({ name: 'shop', package: 'com.acme' }, /Unrecognized key/);
  expectIssue({ name: 'shop', options: { databse: 'mysql' } }, /Unrecognized key/);
  expectIssue({ name: 'shop', entities: [{ name: 'Product', feilds: [] }] }, /Unrecognized key/);
});

test('rejects invalid entity, field, and relation identifiers', () => {
  expectIssue({ name: 'shop', entities: [{ name: 'Product-Item' }] }, /valid identifier/);
  expectIssue(
    { name: 'shop', entities: [{ name: 'Product', fields: [{ name: '1title', type: 'String' }] }] },
    /valid identifier/,
  );
  expectIssue(
    {
      name: 'shop',
      entities: [
        {
          name: 'Product',
          relations: [{ name: 'my relation', type: 'many-to-one', target: 'Product' }],
        },
      ],
    },
    /valid identifier/,
  );
});
