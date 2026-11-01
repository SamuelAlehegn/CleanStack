import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTECTED_REGION_ID_MAX_LENGTH,
  ProtectedRegionFormatError,
  commentStyleFor,
  computeProtectedRegionChecksum,
  languageForFile,
  normalizeProtectedRegionBody,
  parseProtectedRegionMarker,
  renderProtectedRegionBlock,
  validateProtectedRegionChecksum,
  validateProtectedRegionId,
  verifyProtectedRegionChecksum,
} from '../dist/core/protected-regions.js';

const CHECKSUM = computeProtectedRegionChecksum('');

test('detects the protected-region language from a file extension', () => {
  assert.equal(languageForFile('src/main/java/Product.java'), 'java');
  assert.equal(languageForFile('src/app/product.ts'), 'typescript');
  assert.equal(languageForFile('src/app/product.spec.tsx'), 'typescript');
  assert.equal(languageForFile('src/app/product.js'), 'javascript');
  assert.equal(languageForFile('db/migration/V1__create_product.sql'), 'sql');
  assert.equal(languageForFile('src/app/product.html'), 'html');
  assert.equal(languageForFile('pom.xml'), 'xml');
  assert.equal(languageForFile('src/styles.css'), 'css');
  assert.equal(languageForFile('src/app/product.scss'), 'scss');
  assert.equal(languageForFile('application.yml'), 'yaml');
  assert.equal(languageForFile('application.properties'), 'properties');
  assert.equal(languageForFile('config/.env'), 'properties');
  assert.equal(languageForFile('README.md'), 'markdown');
  assert.equal(languageForFile('package.json'), undefined);
  assert.equal(languageForFile('Makefile'), undefined);
});

test('uses the right comment style for each language family', () => {
  assert.deepEqual(commentStyleFor('java'), { kind: 'line', prefix: '//' });
  assert.deepEqual(commentStyleFor('typescript'), { kind: 'line', prefix: '//' });
  assert.deepEqual(commentStyleFor('sql'), { kind: 'line', prefix: '--' });
  assert.deepEqual(commentStyleFor('yaml'), { kind: 'line', prefix: '#' });
  assert.deepEqual(commentStyleFor('html'), { kind: 'block', open: '<!--', close: '-->' });
  assert.deepEqual(commentStyleFor('scss'), { kind: 'block', open: '/*', close: '*/' });
});

test('renders and parses a Java protected region', () => {
  const block = renderProtectedRegionBlock({
    language: 'java',
    id: 'service.product.create',
    indent: '    ',
  });

  assert.equal(
    block,
    [
      '    // <cleanstack:user-code id="service.product.create" checksum="' + CHECKSUM + '">',
      '    // </cleanstack:user-code>',
      '',
    ].join('\n'),
  );

  const lines = block.trimEnd().split('\n');
  const start = parseProtectedRegionMarker(lines[0], 'java');
  const end = parseProtectedRegionMarker(lines[1], 'java');

  assert.deepEqual(start, {
    kind: 'start',
    tag: 'cleanstack:user-code',
    id: 'service.product.create',
    checksum: CHECKSUM,
  });
  assert.deepEqual(end, { kind: 'end', tag: 'cleanstack:user-code' });
});

test('renders markers with the comment syntax of each language', () => {
  assert.match(
    renderProtectedRegionBlock({ language: 'sql', id: 'migration.product' }),
    /^-- <cleanstack:user-code id="migration\.product" checksum="sha256:[0-9a-f]{64}">$/m,
  );
  assert.match(
    renderProtectedRegionBlock({ language: 'html', id: 'form.fields' }),
    /^<!-- <cleanstack:user-code id="form\.fields" checksum="sha256:[0-9a-f]{64}"> -->$/m,
  );
  assert.match(
    renderProtectedRegionBlock({ language: 'yaml', id: 'config.values' }),
    /^# <cleanstack:user-code id="config\.values" checksum="sha256:[0-9a-f]{64}">$/m,
  );
  assert.match(
    renderProtectedRegionBlock({ language: 'scss', id: 'theme.tokens' }),
    /^\/\* <cleanstack:user-code id="theme\.tokens" checksum="sha256:[0-9a-f]{64}"> \*\/$/m,
  );
});

test('renders a body between the markers and preserves indentation', () => {
  const body = '    return repository.save(product);\n';
  const checksum = computeProtectedRegionChecksum(body);
  const block = renderProtectedRegionBlock({
    language: 'java',
    id: 'service.product',
    indent: '  ',
    body,
  });

  assert.equal(
    block,
    [
      `  // <cleanstack:user-code id="service.product" checksum="${checksum}">`,
      '    return repository.save(product);',
      '  // </cleanstack:user-code>',
      '',
    ].join('\n'),
  );
});

test('omits the checksum when requested', () => {
  const block = renderProtectedRegionBlock({
    language: 'typescript',
    id: 'component.actions',
    checksum: null,
  });

  assert.equal(
    block,
    ['// <cleanstack:user-code id="component.actions">', '// </cleanstack:user-code>', ''].join(
      '\n',
    ),
  );
});

test('accepts the cleanstack:protected alias used by existing templates', () => {
  assert.deepEqual(
    parseProtectedRegionMarker(
      '// <cleanstack:protected id="service-product" checksum="' + CHECKSUM + '">',
      'java',
    ),
    {
      kind: 'start',
      tag: 'cleanstack:protected',
      id: 'service-product',
      checksum: CHECKSUM,
    },
  );
  assert.deepEqual(parseProtectedRegionMarker('// </cleanstack:protected>', 'java'), {
    kind: 'end',
    tag: 'cleanstack:protected',
  });
});

test('ignores lines that are not protected-region markers', () => {
  assert.equal(parseProtectedRegionMarker('// regular comment', 'java'), undefined);
  assert.equal(parseProtectedRegionMarker('const value = 1;', 'typescript'), undefined);
  assert.equal(parseProtectedRegionMarker('<!-- a layout comment -->', 'html'), undefined);
  assert.equal(parseProtectedRegionMarker('-- a migration comment', 'sql'), undefined);
});

test('rejects malformed markers with readable errors', () => {
  assert.throws(
    () => parseProtectedRegionMarker('// <cleanstack:user-code id="broken"', 'java'),
    ProtectedRegionFormatError,
  );
  assert.throws(
    () => parseProtectedRegionMarker('// <cleanstack:user-code>', 'java'),
    /missing an id/,
  );
  assert.throws(
    () => parseProtectedRegionMarker('// <cleanstack:user-code id="x" unknown="y">', 'java'),
    /Unknown protected region attribute "unknown"/,
  );
  assert.throws(
    () => parseProtectedRegionMarker('// <cleanstack:user-code id="x" id="y">', 'java'),
    /repeats the "id" attribute/,
  );
  assert.throws(
    () => parseProtectedRegionMarker('// <cleanstack:user-code id="x" extra>', 'java'),
    /Malformed protected region start marker/,
  );
  assert.throws(
    () => parseProtectedRegionMarker('// </cleanstack:user-code', 'java'),
    /Malformed protected region end marker/,
  );
});

test('validates region ids', () => {
  assert.doesNotThrow(() => validateProtectedRegionId('service.create'));
  assert.doesNotThrow(() => validateProtectedRegionId('service-product'));
  assert.doesNotThrow(() => validateProtectedRegionId('service-orderItem'));

  for (const id of [
    '',
    '.service',
    'service..create',
    'service create',
    'service/create',
    '1service',
  ]) {
    assert.throws(() => validateProtectedRegionId(id), ProtectedRegionFormatError);
  }
  assert.throws(
    () => validateProtectedRegionId('a'.repeat(PROTECTED_REGION_ID_MAX_LENGTH + 1)),
    /longer than/,
  );
});

test('validates checksums', () => {
  assert.doesNotThrow(() => validateProtectedRegionChecksum(CHECKSUM));
  for (const checksum of ['', 'sha256:', 'sha256:ABC', 'md5:abc', `sha256:${'a'.repeat(63)}`]) {
    assert.throws(() => validateProtectedRegionChecksum(checksum), ProtectedRegionFormatError);
  }
});

test('normalizes line endings and one trailing newline before hashing', () => {
  const unix = 'line one\nline two\n';
  const windows = 'line one\r\nline two\r\n';
  const classicMac = 'line one\rline two\r';
  const withoutTrailingNewline = 'line one\nline two';

  assert.equal(normalizeProtectedRegionBody(unix), 'line one\nline two');
  assert.equal(normalizeProtectedRegionBody(windows), 'line one\nline two');
  assert.equal(normalizeProtectedRegionBody(classicMac), 'line one\nline two');
  assert.equal(computeProtectedRegionChecksum(unix), computeProtectedRegionChecksum(windows));
  assert.equal(
    computeProtectedRegionChecksum(unix),
    computeProtectedRegionChecksum(withoutTrailingNewline),
  );
  assert.notEqual(
    computeProtectedRegionChecksum(unix),
    computeProtectedRegionChecksum('line one\nline two\nline three\n'),
  );
  assert.notEqual(
    computeProtectedRegionChecksum('    return value;\n'),
    computeProtectedRegionChecksum('  return value;\n'),
  );
});

test('verifies whether a region body still matches its checksum', () => {
  const body = 'return repository.findAll();\n';
  const checksum = computeProtectedRegionChecksum(body);

  assert.equal(verifyProtectedRegionChecksum(body, checksum), true);
  assert.equal(verifyProtectedRegionChecksum(body.replace(/\n/g, '\r\n'), checksum), true);
  assert.equal(verifyProtectedRegionChecksum(`${body}return null;\n`, checksum), false);
  assert.equal(verifyProtectedRegionChecksum(body, undefined), undefined);
});

test('checksums are stable for the same body and differ for different bodies', () => {
  const first = computeProtectedRegionChecksum('public void create() {}\n');
  const second = computeProtectedRegionChecksum('public void create() {}\n');
  const third = computeProtectedRegionChecksum('public void delete() {}\n');

  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});
