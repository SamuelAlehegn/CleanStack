import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProtectedRegionManager,
  ProtectedRegionMergeError,
} from '../dist/core/protected-region-manager.js';
import {
  ProtectedRegionFormatError,
  computeProtectedRegionChecksum,
} from '../dist/core/protected-regions.js';

const JAVA = { language: 'java' };
const manager = new ProtectedRegionManager();

function region(
  id,
  body = '',
  { checksum = computeProtectedRegionChecksum(body), indent = '  ' } = {},
) {
  const checksumAttribute = checksum === null ? '' : ` checksum="${checksum}"`;
  const start = `${indent}// <cleanstack:user-code id="${id}"${checksumAttribute}>`;
  const end = `${indent}// </cleanstack:user-code>`;
  const bodyLines = body.length === 0 ? [] : body.replace(/\n$/, '').split('\n');
  return [start, ...bodyLines, end].join('\n');
}

function templateRegion(id, body = '', indent = '  ') {
  return region(id, body, { checksum: null, indent });
}

function javaFile(regions, { before = 'class ProductService {', after = '}', eol = '\n' } = {}) {
  const content = [before, ...regions, after, ''].join('\n');
  return eol === '\n' ? content : content.replace(/\n/g, eol);
}

function existingFile({
  id = 'service.product',
  templateBody = '',
  userBody = templateBody,
  checksum = computeProtectedRegionChecksum(templateBody),
} = {}) {
  return javaFile([region(id, userBody, { checksum })]);
}

function generatedFile({ id = 'service.product', templateBody = '', indent = '  ' } = {}) {
  return javaFile([templateRegion(id, templateBody, indent)]);
}

function parse(source, options = JAVA) {
  return manager.parse(source, options);
}

function statuses(result) {
  return result.decisions.map((decision) => decision.status);
}

test('parses multiple regions with bodies, checksums, positions, and indentation', () => {
  const body = '    return repository.save(product);\n';
  const source = javaFile([
    region('service.product.create', body),
    region('service.product.delete'),
  ]);
  const parsed = parse(source);

  assert.equal(parsed.language, 'java');
  assert.equal(parsed.regions.length, 2);

  const [first, second] = parsed.regions;
  assert.equal(first.id, 'service.product.create');
  assert.equal(first.body, '    return repository.save(product);');
  assert.equal(first.checksum, computeProtectedRegionChecksum(body));
  assert.equal(first.startLine, 2);
  assert.equal(first.endLine, 4);
  assert.equal(first.indent, '  ');
  assert.equal(first.modified, false);
  assert.match(source.slice(first.startOffset, first.endOffset), /<cleanstack:user-code/);

  assert.equal(second.id, 'service.product.delete');
  assert.equal(second.body, '');
  assert.equal(second.startLine, 5);
  assert.equal(second.endLine, 6);
  assert.equal(second.modified, false);
});

test('marks a region as modified when its body no longer matches the checksum', () => {
  const source = existingFile({
    templateBody: 'return 1;\n',
    userBody: 'return 2;\n',
  });

  assert.equal(parse(source).regions[0].modified, true);
});

test('leaves modified undefined when a region has no checksum', () => {
  const source = javaFile([templateRegion('service.product', 'return 1;\n')]);
  assert.equal(parse(source).regions[0].modified, undefined);
});

test('parses regions from SQL and HTML using the file extension', () => {
  const sql = [
    '-- <cleanstack:user-code id="migration.product.seed">',
    'INSERT INTO products VALUES (1);',
    '-- </cleanstack:user-code>',
    '',
  ].join('\n');
  const sqlParsed = manager.parse(sql, { filePath: 'V1__seed_product.sql' });
  assert.equal(sqlParsed.language, 'sql');
  assert.equal(sqlParsed.regions[0].body, 'INSERT INTO products VALUES (1);');

  const html = [
    '<div>',
    '  <!-- <cleanstack:user-code id="detail.product.actions"> -->',
    '  <button type="button">Archive</button>',
    '  <!-- </cleanstack:user-code> -->',
    '</div>',
    '',
  ].join('\n');
  const htmlParsed = manager.parse(html, { filePath: 'detail.component.html' });
  assert.equal(htmlParsed.language, 'html');
  assert.equal(htmlParsed.regions[0].body, '  <button type="button">Archive</button>');
});

test('parses the cleanstack:protected alias and keeps its tag', () => {
  const source = [
    'class ProductService {',
    '  // <cleanstack:protected id="service-product" checksum="' +
      computeProtectedRegionChecksum('') +
      '">',
    '  // </cleanstack:protected>',
    '}',
    '',
  ].join('\n');
  const parsed = parse(source);

  assert.equal(parsed.regions[0].tag, 'cleanstack:protected');
  assert.equal(parsed.regions[0].id, 'service-product');
});

test('upgrades alias markers to the canonical tag when merging', () => {
  const body = 'return 1;\n';
  const existing = [
    'class ProductService {',
    `  // <cleanstack:protected id="service.product" checksum="${computeProtectedRegionChecksum(body)}">`,
    'return 1;',
    '  // </cleanstack:protected>',
    '}',
    '',
  ].join('\n');
  const generated = generatedFile({ templateBody: body });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['unchanged']);
  assert.match(result.content, /<cleanstack:user-code id="service\.product"/);
  assert.doesNotMatch(result.content, /<cleanstack:protected/);
});

test('ignores ordinary comments and files without regions', () => {
  assert.deepEqual(parse('// just a comment\nclass ProductService {}\n').regions, []);
  assert.deepEqual(parse('class ProductService {}\n').regions, []);
});

test('preserves blank lines and indentation in region bodies', () => {
  const body = '    if (condition) {\n\n      return 1;\n    }\n';
  const parsed = parse(javaFile([region('service.product', body)]));

  assert.equal(parsed.regions[0].body, body.slice(0, -1));
});

test('rejects an unclosed region', () => {
  const source = [
    'class ProductService {',
    '  // <cleanstack:user-code id="service.product">',
    '}',
    '',
  ].join('\n');

  assert.throws(
    () => parse(source),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_UNCLOSED',
  );
});

test('rejects a stray end marker', () => {
  const source = ['class ProductService {', '  // </cleanstack:user-code>', '}', ''].join('\n');

  assert.throws(
    () => parse(source),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_STRAY_END',
  );
});

test('rejects nested regions', () => {
  const source = [
    'class ProductService {',
    '  // <cleanstack:user-code id="outer">',
    '  // <cleanstack:user-code id="inner">',
    '  // </cleanstack:user-code>',
    '  // </cleanstack:user-code>',
    '}',
    '',
  ].join('\n');

  assert.throws(
    () => parse(source),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_NESTED',
  );
});

test('rejects mismatched start and end tags', () => {
  const source = [
    'class ProductService {',
    '  // <cleanstack:user-code id="service.product">',
    '  // </cleanstack:protected>',
    '}',
    '',
  ].join('\n');

  assert.throws(
    () => parse(source),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_TAG_MISMATCH',
  );
});

test('rejects duplicate region ids', () => {
  const source = javaFile([region('service.product', 'one\n'), region('service.product', 'two\n')]);

  assert.throws(
    () => parse(source),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_DUPLICATE_ID',
  );
});

test('rejects malformed markers with a format error code', () => {
  const source = javaFile([region('service.product', '', { checksum: 'sha256:not-a-checksum' })]);

  assert.throws(
    () => parse(source),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_MALFORMED',
  );
});

test('rejects unsupported file types and missing language options', () => {
  assert.throws(
    () => manager.parse('{}', { filePath: 'package.json' }),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_UNKNOWN_TYPE',
  );
  assert.throws(
    () => manager.parse('class ProductService {}'),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_UNKNOWN_TYPE',
  );
  assert.throws(
    () => manager.parse('class ProductService {}', { language: 'cobol' }),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_UNKNOWN_TYPE',
  );
});

test('writes the template body when neither side changed', () => {
  const body = 'return 1;\n';
  const existing = existingFile({ templateBody: body });
  const generated = generatedFile({ templateBody: body });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['unchanged']);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.content, existing);
  assert.equal(parse(result.content).regions[0].modified, false);
});

test('replaces user content when only the template changed', () => {
  const existing = existingFile({ templateBody: 'return 1;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['template-updated']);
  assert.match(result.content, /return 2;/);
  assert.doesNotMatch(result.content, /return 1;/);
  assert.equal(
    parse(result.content).regions[0].checksum,
    computeProtectedRegionChecksum('return 2;\n'),
  );
  assert.equal(parse(result.content).regions[0].modified, false);
});

test('preserves user content when only the user changed', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 1;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['user-preserved']);
  assert.match(result.content, /return 42;/);
  assert.doesNotMatch(result.content, /return 1;/);
  assert.equal(parse(result.content).regions[0].modified, true);
});

test('reports a manual conflict by default and leaves the existing file untouched', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, false);
  assert.equal(result.content, existing);
  assert.deepEqual(statuses(result), ['conflict-manual']);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, 'service.product');
  assert.equal(result.conflicts[0].kind, 'both-modified');
  assert.equal(result.conflicts[0].strategy, 'manual');
  assert.equal(result.conflicts[0].resolved, false);
  assert.match(result.conflicts[0].message, /service\.product/);
});

test('keeps user content for a conflict with the keep-user strategy', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, { ...JAVA, strategy: 'keep-user' });

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['conflict-kept-user']);
  assert.equal(result.conflicts[0].resolved, true);
  assert.match(result.content, /return 42;/);
  assert.doesNotMatch(result.content, /return 2;/);
  assert.equal(
    parse(result.content).regions[0].checksum,
    computeProtectedRegionChecksum('return 2;\n'),
  );
  assert.equal(parse(result.content).regions[0].modified, true);
});

test('keep-user still detects future template changes after the checksum moves forward', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const first = manager.merge(existing, generated, { ...JAVA, strategy: 'keep-user' });
  const second = manager.merge(first.content, generated, { ...JAVA, strategy: 'keep-user' });
  const third = manager.merge(second.content, generatedFile({ templateBody: 'return 3;\n' }), {
    ...JAVA,
    strategy: 'keep-user',
  });

  assert.deepEqual(statuses(first), ['conflict-kept-user']);
  assert.deepEqual(statuses(second), ['user-preserved']);
  assert.deepEqual(statuses(third), ['conflict-kept-user']);
  assert.match(third.content, /return 42;/);
});

test('replaces user content for a conflict with the keep-template strategy', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, { ...JAVA, strategy: 'keep-template' });

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['conflict-kept-template']);
  assert.equal(result.conflicts[0].resolved, true);
  assert.match(result.content, /return 2;/);
  assert.doesNotMatch(result.content, /return 42;/);
  assert.equal(parse(result.content).regions[0].modified, false);
});

test('uses constructor defaults, manager overrides, and per-region overrides', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const keepUserManager = new ProtectedRegionManager({ strategy: 'keep-user' });
  assert.deepEqual(statuses(keepUserManager.merge(existing, generated, JAVA)), [
    'conflict-kept-user',
  ]);
  assert.deepEqual(
    statuses(keepUserManager.merge(existing, generated, { ...JAVA, strategy: 'keep-template' })),
    ['conflict-kept-template'],
  );

  const perRegionManager = new ProtectedRegionManager({
    strategies: { 'service.product': 'keep-template' },
  });
  assert.deepEqual(statuses(perRegionManager.merge(existing, generated, JAVA)), [
    'conflict-kept-template',
  ]);
  assert.deepEqual(
    statuses(
      perRegionManager.merge(existing, generated, {
        ...JAVA,
        strategies: { 'service.product': 'keep-user' },
      }),
    ),
    ['conflict-kept-user'],
  );
});

test('adds new regions from the template', () => {
  const existing = javaFile([region('service.product.create', 'return 1;\n')]);
  const generated = javaFile([
    templateRegion('service.product.create', 'return 1;\n'),
    templateRegion('service.product.archive', 'return false;\n'),
  ]);

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['unchanged', 'added']);
  assert.match(result.content, /service\.product\.archive/);
  assert.match(result.content, /return false;/);
});

test('reports an orphaned region and preserves the file with the manual strategy', () => {
  const existing = existingFile({ id: 'service.product.create', templateBody: 'return 1;\n' });
  const generated = generatedFile({ id: 'service.product.other', templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, false);
  assert.equal(result.content, existing);
  assert.deepEqual(statuses(result), ['added', 'orphaned-manual']);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, 'service.product.create');
  assert.equal(result.conflicts[0].kind, 'orphaned');
  assert.equal(result.conflicts[0].resolved, false);
});

test('appends orphaned regions with the keep-user strategy and preserves their checksum', () => {
  const orphanChecksum = computeProtectedRegionChecksum('return 1;\n');
  const existing = existingFile({
    id: 'service.product.create',
    templateBody: 'return 1;\n',
    checksum: orphanChecksum,
  });
  const generated = generatedFile({ id: 'service.product.other', templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, { ...JAVA, strategy: 'keep-user' });

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['added', 'orphaned-kept']);
  assert.equal(result.conflicts[0].resolved, true);
  assert.match(result.content, /service\.product\.other/);
  assert.match(result.content, /service\.product\.create/);
  assert.match(result.content, /return 1;/);

  const orphan = parse(result.content).regions.find((item) => item.id === 'service.product.create');
  assert.equal(orphan.checksum, orphanChecksum);
  assert.equal(orphan.body, 'return 1;');
});

test('drops orphaned regions with the keep-template strategy', () => {
  const existing = existingFile({ id: 'service.product.create', templateBody: 'return 1;\n' });
  const generated = generatedFile({ id: 'service.product.other', templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, { ...JAVA, strategy: 'keep-template' });

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['added', 'orphaned-dropped']);
  assert.doesNotMatch(result.content, /service\.product\.create/);
  assert.doesNotMatch(result.content, /return 1;/);
  assert.match(result.content, /service\.product\.other/);
});

test('preserves a region without a checksum, warns, and records a new base', () => {
  const existing = javaFile([region('service.product', 'return 42;\n', { checksum: null })]);
  const generated = generatedFile({ templateBody: 'return 1;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['unverified']);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'PROTECTED_REGION_UNVERIFIED');
  assert.match(result.content, /return 42;/);
  assert.equal(
    parse(result.content).regions[0].checksum,
    computeProtectedRegionChecksum('return 1;\n'),
  );

  const second = manager.merge(result.content, generated, JAVA);
  assert.deepEqual(statuses(second), ['user-preserved']);
  assert.match(second.content, /return 42;/);
});

test('treats identical user and template edits as converged', () => {
  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 42;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['converged']);
  assert.deepEqual(result.conflicts, []);
  assert.match(result.content, /return 42;/);
  assert.equal(parse(result.content).regions[0].modified, false);
});

test('does not write a partially merged file when any conflict is manual', () => {
  const existing = javaFile([
    region('first', 'return userFirst;\n', {
      checksum: computeProtectedRegionChecksum('baseFirst\n'),
    }),
    region('second', 'return userSecond;\n', {
      checksum: computeProtectedRegionChecksum('baseSecond\n'),
    }),
  ]);
  const generated = javaFile([
    templateRegion('first', 'return templateFirst;\n'),
    templateRegion('second', 'return templateSecond;\n'),
  ]);

  const result = manager.merge(existing, generated, {
    ...JAVA,
    strategies: { first: 'keep-user' },
  });

  assert.equal(result.writable, false);
  assert.equal(result.content, existing);
  assert.deepEqual(
    result.conflicts.map((conflict) => [conflict.id, conflict.strategy, conflict.resolved]),
    [
      ['first', 'keep-user', true],
      ['second', 'manual', false],
    ],
  );
});

test('handles multiple regions with mixed outcomes', () => {
  const existing = javaFile([
    region('unchanged', 'return sameCode;\n'),
    region('user', 'return userCode;\n', {
      checksum: computeProtectedRegionChecksum('return templateCode;\n'),
    }),
    region('template', 'return oldCode;\n'),
  ]);
  const generated = javaFile([
    templateRegion('unchanged', 'return sameCode;\n'),
    templateRegion('user', 'return templateCode;\n'),
    templateRegion('template', 'return newCode;\n'),
  ]);

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['unchanged', 'user-preserved', 'template-updated']);
  assert.match(result.content, /return userCode;/);
  assert.match(result.content, /return newCode;/);
  assert.doesNotMatch(result.content, /return oldCode;/);
});

test('matches regions by id when the template reorders them', () => {
  const existing = javaFile([
    region('first', 'return firstCode;\n'),
    region('second', 'return secondCode;\n'),
  ]);
  const generated = javaFile([
    templateRegion('second', 'return secondCode;\n'),
    templateRegion('first', 'return firstCode;\n'),
  ]);

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.deepEqual(statuses(result), ['unchanged', 'unchanged']);
  assert.ok(result.content.indexOf('id="second"') < result.content.indexOf('id="first"'));
});

test('preserves CRLF line endings and rejects lone LF characters', () => {
  const existing = javaFile([region('service.product', 'return 1;\n')], { eol: '\r\n' });
  const generated = javaFile([templateRegion('service.product', 'return 2;\n')], { eol: '\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.match(result.content, /\r\n/);
  assert.doesNotMatch(result.content.replace(/\r\n/g, ''), /\n/);
  assert.match(result.content, /return 2;/);
});

test('preserves the existing trailing-newline convention', () => {
  const existing = javaFile([region('service.product', 'return 1;\n')]).replace(/\n$/, '');
  const generated = generatedFile({ templateBody: 'return 2;\n' });

  const result = manager.merge(existing, generated, JAVA);

  assert.equal(result.writable, true);
  assert.equal(result.content.endsWith('\n'), false);
  assert.match(result.content, /return 2;/);
});

test('handles an empty existing file and a generated file without regions', () => {
  const generated = generatedFile({ templateBody: 'return 1;\n' });
  const added = manager.merge('', generated, JAVA);
  assert.equal(added.writable, true);
  assert.deepEqual(statuses(added), ['added']);
  assert.match(added.content, /return 1;/);

  const existing = existingFile({ templateBody: 'return 1;\n' });
  const withoutRegions = 'class ProductService {\n}\n';
  const manual = manager.merge(existing, withoutRegions, JAVA);
  assert.equal(manual.writable, false);
  assert.equal(manual.content, existing);
  assert.deepEqual(statuses(manual), ['orphaned-manual']);

  const templateWins = manager.merge(existing, withoutRegions, {
    ...JAVA,
    strategy: 'keep-template',
  });
  assert.equal(templateWins.writable, true);
  assert.equal(templateWins.content, withoutRegions);
});

test('throws when a merge strategy is invalid at runtime', () => {
  assert.throws(
    () => new ProtectedRegionManager({ strategy: 'overwrite' }),
    (error) =>
      error instanceof ProtectedRegionMergeError && error.code === 'PROTECTED_REGION_CONFLICT',
  );

  const existing = existingFile({ templateBody: 'return 1;\n', userBody: 'return 42;\n' });
  const generated = generatedFile({ templateBody: 'return 2;\n' });
  assert.throws(
    () => manager.merge(existing, generated, { ...JAVA, strategy: 'overwrite' }),
    ProtectedRegionMergeError,
  );
});

test('reports duplicate ids in the generated file as well', () => {
  const existing = existingFile({ templateBody: 'return 1;\n' });
  const generated = javaFile([
    templateRegion('service.product', 'return 2;\n'),
    templateRegion('service.product', 'return 3;\n'),
  ]);

  assert.throws(
    () => manager.merge(existing, generated, JAVA),
    (error) =>
      error instanceof ProtectedRegionFormatError && error.code === 'PROTECTED_REGION_DUPLICATE_ID',
  );
});
