import { CleanStackError } from '../utils/errors.js';

/** JDK majors the generator can target. */
export const JAVA_VERSIONS = [17, 21, 25] as const;
export type JavaVersion = (typeof JAVA_VERSIONS)[number];

/** Spring Boot minor lines; the exact patch is pinned by the release metadata. */
export const SPRING_BOOT_LINES = ['3.5', '4.0', '4.1'] as const;
export type SpringBootLine = (typeof SPRING_BOOT_LINES)[number];

/** Angular majors the generator can target. */
export const ANGULAR_VERSIONS = [20, 21, 22] as const;
export type AngularVersion = (typeof ANGULAR_VERSIONS)[number];

export const VERSION_KEYWORDS = ['latest', 'lts'] as const;
export type VersionKeyword = (typeof VERSION_KEYWORDS)[number];

/** A user-supplied version, before keyword resolution. */
export type Requested<T> = T | VersionKeyword;

/** Version input as it appears in CLI flags and configuration files. */
export interface RequestedVersions {
  java?: Requested<JavaVersion>;
  springBoot?: Requested<SpringBootLine>;
  angular?: Requested<AngularVersion>;
}

/** Version values every downstream consumer sees. Always concrete. */
export interface ResolvedVersions {
  java: JavaVersion;
  springBoot: SpringBootLine;
  angular: AngularVersion;
}

export type SupportLevel = 'default' | 'supported' | 'legacy';

export interface SpringBootRelease {
  line: SpringBootLine;
  /** Exact patch the generator pins; resolution keys off `line`, not the patch. */
  version: string;
  java: readonly JavaVersion[];
  support: SupportLevel;
}

export interface AngularRelease {
  major: AngularVersion;
  /** Minor range written to the generated package.json, for example `^22.2.0`. */
  version: string;
  /** Node engine range copied from the upstream package metadata. */
  node: string;
  support: SupportLevel;
}

export interface CompatibilityMatrix {
  schemaVersion: 1;
  /** Date the upstream support windows were last verified. */
  verifiedOn: string;
  defaults: ResolvedVersions;
  keywords: Record<VersionKeyword, ResolvedVersions>;
  springBoot: readonly SpringBootRelease[];
  angular: readonly AngularRelease[];
}

/**
 * Single source of truth for supported toolchains and the `latest` / `lts`
 * profiles. Updating it is a generator release; nothing is fetched at runtime.
 */
export const COMPATIBILITY_MATRIX: CompatibilityMatrix = {
  schemaVersion: 1,
  verifiedOn: '2026-11-16',
  defaults: { java: 21, springBoot: '4.1', angular: 22 },
  keywords: {
    // Newest supported entry in each dimension.
    latest: { java: 25, springBoot: '4.1', angular: 22 },
    // Conservative profile: previous supported line in each dimension. Only
    // Java has a formal upstream LTS; see docs/version-support-design.md.
    lts: { java: 21, springBoot: '4.0', angular: 21 },
  },
  springBoot: [
    // Patch values are pinned per generator release; the resolver keys off the line.
    { line: '3.5', version: '3.5.6', java: [17, 21], support: 'legacy' },
    { line: '4.0', version: '4.0.6', java: [21, 25], support: 'supported' },
    { line: '4.1', version: '4.1.2', java: [21, 25], support: 'default' },
  ],
  angular: [
    {
      major: 20,
      version: '^20.3.0',
      node: '^20.19.0 || ^22.12.0 || >=24.0.0',
      support: 'legacy',
    },
    {
      major: 21,
      version: '^21.2.0',
      node: '^20.19.0 || ^22.12.0 || >=24.0.0',
      support: 'supported',
    },
    {
      major: 22,
      version: '^22.2.0',
      node: '^22.22.3 || ^24.15.0 || ^26.0.0',
      support: 'default',
    },
  ],
};

export interface ToolchainContext {
  java: { version: JavaVersion };
  springBoot: { line: SpringBootLine; version: string };
  angular: { major: AngularVersion; version: string; node: string };
}

export type TemplatePack = 'spring-boot' | 'angular' | 'project';

export type VersionValidationIssueCode =
  | 'unsupported-java'
  | 'unsupported-spring-boot'
  | 'unsupported-angular'
  | 'incompatible-java-spring-boot';

export interface VersionValidationIssue {
  code: VersionValidationIssueCode;
  message: string;
  suggestions: string[];
}

export interface VersionValidationResult {
  valid: boolean;
  errors: VersionValidationIssue[];
  /** Reserved for environment checks such as the local Node version. */
  warnings: VersionValidationIssue[];
}

export function isVersionKeyword(value: unknown): value is VersionKeyword {
  return value === 'latest' || value === 'lts';
}

export function getSpringBootRelease(line: SpringBootLine): SpringBootRelease {
  const release = COMPATIBILITY_MATRIX.springBoot.find((candidate) => candidate.line === line);
  if (release === undefined) {
    throw new Error(`Compatibility matrix is missing Spring Boot ${line}.`);
  }
  return release;
}

export function getAngularRelease(major: AngularVersion): AngularRelease {
  const release = COMPATIBILITY_MATRIX.angular.find((candidate) => candidate.major === major);
  if (release === undefined) {
    throw new Error(`Compatibility matrix is missing Angular ${major}.`);
  }
  return release;
}

/**
 * Resolves user input to concrete versions and validates the result. The
 * returned object never contains a keyword, so downstream code cannot
 * accidentally persist `"latest"` into project metadata.
 */
export function resolveVersions(requested: RequestedVersions = {}): ResolvedVersions {
  const versions: ResolvedVersions = {
    java: resolveRequestedVersion(
      'Java',
      requested.java,
      JAVA_VERSIONS,
      COMPATIBILITY_MATRIX.defaults.java,
      {
        latest: COMPATIBILITY_MATRIX.keywords.latest.java,
        lts: COMPATIBILITY_MATRIX.keywords.lts.java,
      },
    ),
    springBoot: resolveRequestedVersion(
      'Spring Boot',
      requested.springBoot,
      SPRING_BOOT_LINES,
      COMPATIBILITY_MATRIX.defaults.springBoot,
      {
        latest: COMPATIBILITY_MATRIX.keywords.latest.springBoot,
        lts: COMPATIBILITY_MATRIX.keywords.lts.springBoot,
      },
    ),
    angular: resolveRequestedVersion(
      'Angular',
      requested.angular,
      ANGULAR_VERSIONS,
      COMPATIBILITY_MATRIX.defaults.angular,
      {
        latest: COMPATIBILITY_MATRIX.keywords.latest.angular,
        lts: COMPATIBILITY_MATRIX.keywords.lts.angular,
      },
    ),
  };

  assertSupportedVersions(versions);
  return versions;
}

function resolveRequestedVersion<T extends string | number>(
  label: string,
  requested: Requested<T> | undefined,
  supported: readonly T[],
  fallback: T,
  keywords: Record<VersionKeyword, T>,
): T {
  if (requested === undefined) return fallback;
  if (isVersionKeyword(requested)) return keywords[requested];
  if (!supported.includes(requested)) {
    throw new CleanStackError(`Unsupported ${label} version: ${String(requested)}.`, {
      suggestions: [
        `Use one of: ${supported.join(', ')}, latest, lts.`,
        'Run "cleanstack versions" to see the compatibility matrix.',
      ],
    });
  }
  return requested;
}

/**
 * Validates a resolved toolchain without throwing. Use this for interactive
 * feedback; use {@link assertSupportedVersions} at command boundaries.
 */
export function validateVersions(versions: ResolvedVersions): VersionValidationResult {
  const errors: VersionValidationIssue[] = [];

  if (!JAVA_VERSIONS.includes(versions.java)) {
    errors.push(unsupportedIssue('unsupported-java', 'Java', versions.java, JAVA_VERSIONS));
  }

  const springBoot = COMPATIBILITY_MATRIX.springBoot.find(
    (release) => release.line === versions.springBoot,
  );
  if (springBoot === undefined) {
    errors.push(
      unsupportedIssue(
        'unsupported-spring-boot',
        'Spring Boot',
        versions.springBoot,
        SPRING_BOOT_LINES,
      ),
    );
  } else if (!springBoot.java.includes(versions.java)) {
    const compatibleLines = COMPATIBILITY_MATRIX.springBoot
      .filter((release) => release.java.includes(versions.java))
      .map((release) => release.line);
    const suggestions = [
      `Use Java ${joinAlternatives(springBoot.java)} with Spring Boot ${springBoot.line}.`,
    ];
    if (compatibleLines.length > 0) {
      suggestions.push(
        `Use Spring Boot ${joinAlternatives(compatibleLines)} with Java ${versions.java}.`,
      );
    }
    errors.push({
      code: 'incompatible-java-spring-boot',
      message: `Spring Boot ${versions.springBoot} does not support Java ${versions.java}. Supported Java versions for Spring Boot ${versions.springBoot}: ${springBoot.java.join(', ')}.`,
      suggestions,
    });
  }

  if (!ANGULAR_VERSIONS.includes(versions.angular)) {
    errors.push(
      unsupportedIssue('unsupported-angular', 'Angular', versions.angular, ANGULAR_VERSIONS),
    );
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

/** Throws a {@link CleanStackError} with suggestions when the toolchain is invalid. */
export function assertSupportedVersions(versions: ResolvedVersions): void {
  const result = validateVersions(versions);
  if (result.valid) return;

  const message = [
    `Unsupported toolchain: ${formatVersions(versions)}.`,
    ...result.errors.map((issue) => issue.message),
  ].join('\n\n');
  const suggestions = [...new Set(result.errors.flatMap((issue) => issue.suggestions))];
  suggestions.push('Run "cleanstack versions" to see the compatibility matrix.');

  throw new CleanStackError(message, { suggestions });
}

export function formatVersions(versions: ResolvedVersions): string {
  return `Java ${versions.java} + Spring Boot ${versions.springBoot} + Angular ${versions.angular}`;
}

/**
 * Ordered overlay tags for the template engine. Runtime lines come before
 * language lines so a Spring Boot-specific file wins over a Java-specific one.
 */
export function versionVariants(versions: ResolvedVersions, pack: TemplatePack): string[] {
  if (pack === 'spring-boot') {
    return [`spring-boot-${versions.springBoot}`, `java-${versions.java}`];
  }
  if (pack === 'angular') {
    return [`angular-${versions.angular}`];
  }
  return [];
}

export function buildToolchainContext(versions: ResolvedVersions): ToolchainContext {
  const springBoot = getSpringBootRelease(versions.springBoot);
  const angular = getAngularRelease(versions.angular);
  return {
    java: { version: versions.java },
    springBoot: { line: springBoot.line, version: springBoot.version },
    angular: { major: angular.major, version: angular.version, node: angular.node },
  };
}

function unsupportedIssue(
  code: VersionValidationIssueCode,
  label: string,
  value: string | number,
  supported: readonly (string | number)[],
): VersionValidationIssue {
  return {
    code,
    message: `Unsupported ${label} version: ${String(value)}. Supported versions: ${supported.join(', ')}.`,
    suggestions: [`Use one of: ${supported.join(', ')}, latest, lts.`],
  };
}

function joinAlternatives(values: readonly (string | number)[]): string {
  const last = values[values.length - 1];
  if (values.length === 0 || last === undefined) return values.join('');
  if (values.length === 1) return String(last);
  return `${values.slice(0, -1).join(', ')} or ${last}`;
}
