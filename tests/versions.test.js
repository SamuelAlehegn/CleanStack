import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANGULAR_VERSIONS,
  COMPATIBILITY_MATRIX,
  JAVA_VERSIONS,
  SPRING_BOOT_LINES,
  assertSupportedVersions,
  buildToolchainContext,
  formatVersions,
  resolveVersions,
  validateVersions,
  versionVariants,
} from '../dist/core/versions.js';
import { CleanStackError } from '../dist/utils/errors.js';

test('resolves the shipped baseline when nothing is requested', () => {
  assert.deepEqual(resolveVersions(), { java: 21, springBoot: '4.1', angular: 22 });
});

test('resolves latest and lts to concrete profiles', () => {
  assert.deepEqual(resolveVersions({ java: 'latest', springBoot: 'latest', angular: 'latest' }), {
    java: 25,
    springBoot: '4.1',
    angular: 22,
  });
  assert.deepEqual(resolveVersions({ java: 'lts', springBoot: 'lts', angular: 'lts' }), {
    java: 21,
    springBoot: '4.0',
    angular: 21,
  });
});

test('mixes keywords with explicit versions', () => {
  assert.deepEqual(resolveVersions({ java: 'latest', springBoot: '4.0', angular: 21 }), {
    java: 25,
    springBoot: '4.0',
    angular: 21,
  });
});

test('keeps legacy lines selectable', () => {
  assert.deepEqual(resolveVersions({ java: 17, springBoot: '3.5', angular: 20 }), {
    java: 17,
    springBoot: '3.5',
    angular: 20,
  });
});

test('rejects unsupported explicit versions with a helpful error', () => {
  assert.throws(
    () => resolveVersions({ java: 19 }),
    (error) => {
      assert.ok(error instanceof CleanStackError);
      assert.match(error.message, /Unsupported Java version: 19/);
      assert.ok(error.suggestions.some((suggestion) => suggestion.includes('17, 21, 25')));
      return true;
    },
  );
  assert.throws(
    () => resolveVersions({ springBoot: '3.3' }),
    /Unsupported Spring Boot version: 3\.3/,
  );
  assert.throws(() => resolveVersions({ angular: 19 }), /Unsupported Angular version: 19/);
});

test('rejects an incompatible Java and Spring Boot pair', () => {
  assert.throws(
    () => resolveVersions({ java: 17, springBoot: '4.1' }),
    (error) => {
      assert.ok(error instanceof CleanStackError);
      assert.match(error.message, /Spring Boot 4\.1 does not support Java 17/);
      assert.match(error.message, /Supported Java versions for Spring Boot 4\.1: 21, 25/);
      assert.ok(error.suggestions.some((suggestion) => suggestion.includes('Java 21 or 25')));
      assert.ok(error.suggestions.some((suggestion) => suggestion.includes('Spring Boot 3.5')));
      return true;
    },
  );
});

test('rejects keyword profiles the selected line cannot support', () => {
  assert.throws(
    () => resolveVersions({ java: 'latest', springBoot: '3.5' }),
    /Spring Boot 3\.5 does not support Java 25/,
  );
});

test('validateVersions reports issues without throwing', () => {
  const result = validateVersions({ java: 17, springBoot: '4.1', angular: 22 });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'incompatible-java-spring-boot');
  assert.deepEqual(result.warnings, []);
});

test('accepts every row the matrix marks as supported', () => {
  for (const release of COMPATIBILITY_MATRIX.springBoot) {
    for (const java of release.java) {
      const result = validateVersions({
        java,
        springBoot: release.line,
        angular: COMPATIBILITY_MATRIX.defaults.angular,
      });
      assert.equal(result.valid, true, `${java} + ${release.line} should be valid`);
    }
  }
});

test('builds version overlay tags in runtime-before-language order', () => {
  const versions = resolveVersions();
  assert.deepEqual(versionVariants(versions, 'spring-boot'), ['spring-boot-4.1', 'java-21']);
  assert.deepEqual(versionVariants(versions, 'angular'), ['angular-22']);
  assert.deepEqual(versionVariants(versions, 'project'), []);
});

test('builds a toolchain context with pinned versions', () => {
  assert.deepEqual(buildToolchainContext(resolveVersions()), {
    java: { version: 21 },
    springBoot: { line: '4.1', version: '4.1.2' },
    angular: {
      major: 22,
      version: '^22.2.0',
      node: '^22.22.3 || ^24.15.0 || ^26.0.0',
    },
  });
});

test('formats a toolchain for messages', () => {
  assert.equal(formatVersions(resolveVersions()), 'Java 21 + Spring Boot 4.1 + Angular 22');
});

test('keeps the compatibility matrix internally consistent', () => {
  assert.equal(COMPATIBILITY_MATRIX.schemaVersion, 1);
  assert.match(COMPATIBILITY_MATRIX.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);

  assert.deepEqual(
    COMPATIBILITY_MATRIX.springBoot
      .filter((release) => release.support === 'default')
      .map((release) => release.line),
    [COMPATIBILITY_MATRIX.defaults.springBoot],
  );
  assert.deepEqual(
    COMPATIBILITY_MATRIX.angular
      .filter((release) => release.support === 'default')
      .map((release) => release.major),
    [COMPATIBILITY_MATRIX.defaults.angular],
  );

  assert.deepEqual(
    COMPATIBILITY_MATRIX.springBoot.map((release) => release.line).sort(),
    [...SPRING_BOOT_LINES].sort(),
  );
  assert.deepEqual(
    COMPATIBILITY_MATRIX.angular
      .map((release) => release.major)
      .sort((left, right) => left - right),
    [...ANGULAR_VERSIONS].sort((left, right) => left - right),
  );

  for (const release of COMPATIBILITY_MATRIX.springBoot) {
    assert.ok(release.java.length > 0);
    assert.ok(release.java.every((version) => JAVA_VERSIONS.includes(version)));
  }

  for (const profile of Object.values(COMPATIBILITY_MATRIX.keywords)) {
    assert.equal(validateVersions(profile).valid, true);
  }

  assert.doesNotThrow(() => assertSupportedVersions(COMPATIBILITY_MATRIX.defaults));
  assert.doesNotThrow(() => assertSupportedVersions(COMPATIBILITY_MATRIX.keywords.latest));
  assert.doesNotThrow(() => assertSupportedVersions(COMPATIBILITY_MATRIX.keywords.lts));
});
