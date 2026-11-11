# Contributing to CleanStack

CleanStack is a TypeScript generator for Spring Boot and Angular projects. This
guide covers the local setup, repository conventions, test strategy, and the
rules for changing templates or generated-file behavior.

## Before you start

- Use Node.js 22 (the repository's `.nvmrc` pins the major version).
- Install npm dependencies with `npm ci` when a lockfile is present.
- A JDK 21 and Maven are only needed for the opt-in end-to-end test.
- Git is used for the normal branch/PR workflow. The generator itself also checks
  for Git in `cleanstack doctor`.
- Keep generated build output (`dist/`, `web/dist/`) out of commits.

## Setup

```sh
git clone https://github.com/SamuelAlehegn/CleanStack.git
cd CleanStack
npm ci
npm run build
npm test
```

The CLI entry point is `dist/cli/index.js` after a build. For manual testing,
either run it directly or link the package:

```sh
node dist/cli/index.js --help
npm link
cleanstack --help
```

`npm start` currently points at a placeholder command and is not part of the
development workflow. Use `npm link`, `node dist/cli/index.js`, or
`npm run ui:dev`.

## Scripts

| Script                 | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `npm run build`        | Compile `src/` to `dist/` with TypeScript                   |
| `npm test`             | Build, then run the Node test suite                         |
| `npm run test:e2e`     | Build, then run the opt-in full-stack end-to-end test       |
| `npm run lint`         | Run ESLint over the repository                              |
| `npm run format`       | Format supported files with Prettier                        |
| `npm run format:check` | Check formatting without writing                            |
| `npm run clean`        | Remove `dist/`                                              |
| `npm run ui`           | Build CLI and Studio, then start Studio with the local API  |
| `npm run ui:dev`       | Start Vite with hot reload and the local engine API         |
| `npm run ui:build`     | Build the Studio bundle into `web/dist`                     |
| `npm run ui:check`     | Type-check the Studio sources                               |
| `npm run ui:static`    | Build CLI and Studio, then serve static demo mode           |
| `npm run commitlint`   | Lint commit messages (also runs from the `commit-msg` hook) |
| `npm run changeset`    | Record a release note for a user-visible change             |
| `npm run version`      | Apply pending changesets and update `CHANGELOG.md`          |
| `npm run release`      | Publish the package and create the GitHub release           |

Prettier is the source of truth for formatting: single quotes, trailing commas,
100-column lines, LF endings. Do not hand-format around it. The template packs
under `templates/` are intentionally excluded from Prettier. Generated Windows
scripts (`.cmd`, `.bat`, `.ps1`, `.reg`, `.vbs`) are the exception: CleanStack
writes them with CRLF on every platform.

## Repository layout

```text
src/cli/         CLI entry point and command implementations
src/core/        configuration, entities, projects, metadata, merging, OpenAPI
src/templates/   template engine, manifest planning/rendering, helpers
src/utils/       filesystem service, path safety, errors, logger
src/web/         local HTTP API and server used by Studio
web/             React 19 Studio sources
templates/       built-in Spring Boot and Angular packs
tests/           Node test-runner suites
docs/            user and design documentation
```

See [Architecture](ARCHITECTURE.md) for the pipelines and data flow.

## Making a change

1. Branch from an up-to-date `main`. Use a descriptive prefix such as `feat/`,
   `fix/`, `test/`, or `docs/`.
2. Keep the change focused. Separate generator behavior changes from unrelated
   documentation or formatting churn.
3. Update or add tests before changing behavior. Most commands have a dedicated
   suite under `tests/`.
4. Run `npm run build`, `npm run lint`, `npm run format:check`, and `npm test`.
5. Update the affected documentation. User-facing behavior belongs in
   [GUIDE.md](GUIDE.md); internal behavior belongs in
   [ARCHITECTURE.md](ARCHITECTURE.md); template changes belong in
   [TEMPLATES.md](TEMPLATES.md).
6. Open a pull request against `main` with a short description of the behavior
   change and how it was verified.

## Commit messages

This repository follows [Conventional Commits](https://www.conventionalcommits.org/).
The format is `type(scope): subject`, for example:

```text
feat(cli): add --dry-run to the entity command
fix(templates): preserve CRLF line endings on Windows
docs: explain protected-region checksums
```

Use one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
`revert`, `style`, or `test`. Keep the subject imperative and under 100
characters; put context in the body. A `commit-msg` hook runs commitlint
locally, and CI lints every commit in a pull request.

## Changesets and releases

User-visible changes need a changeset. Run `npm run changeset`, choose the
semantic-version bump, and write the summary for users:

- `patch` for backwards-compatible fixes
- `minor` for backwards-compatible features
- `major` for breaking changes

Commit the generated `.changeset/*.md` file with the rest of the change. Do not
edit the version in `package.json` or `CHANGELOG.md` by hand; `changeset version`
owns both.

On every push to `main`, the release workflow opens or updates a
`chore(release): version packages` pull request. Merging it bumps the version,
regenerates `CHANGELOG.md`, publishes to npm, and creates the GitHub release.
The workflow can also be started manually from the Actions tab. Publishing
requires an `NPM_TOKEN` repository secret with publish access to the
`cleanstack-generator` package; provenance is enabled through `id-token: write`.
The release and CI workflows live in `.github/workflows/`.

## TypeScript conventions

- The project is ESM with `module: NodeNext`. Use `.js` extensions in relative
  imports, even when editing `.ts` files.
- The compiler is strict, including `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `noImplicitReturns`. Avoid non-null
  assertions unless the surrounding code proves the invariant.
- Validate external input with Zod at the boundary. Configuration and entity
  schemas live in `src/core/config.ts`; parse before using the data.
- Use `FileSystemService` and the path-safety helpers for generator I/O rather
  than importing `node:fs` directly. This keeps dry-run, confinement, and action
  logging consistent.
- Throw `CleanStackError` or `CliOptionError` with actionable suggestions for
  user-facing failures. Do not print and continue when a command cannot
  complete.
- Keep command parsers pure where possible, and keep usage text next to the
  command implementation.
- Prefer small functions with explicit types over broad utility abstractions.
  Public behavior is exported through `src/index.ts` and the package `exports`
  map.

## CLI conventions

Each command owns its argument parser and `USAGE` string. When adding an option:

- Parse both `--flag value` and `--flag=value` where the existing command does.
- Accept `--verbose` and `--quiet` before or after the command; global flag
  extraction already handles both positions.
- Reject unknown options with a targeted message and suggestions.
- Validate option combinations early, before touching the filesystem.
- Add the option to the command's help text and to the user guide.
- Cover the new branch in the command's test file.

Aliases are registered in `src/cli/program.ts`:
`generate entity`/`g e` for `entity`, `r` for `regenerate`, and `api` for
`openapi`.

## Generated files and protected regions

The generator owns generated files; users own code inside protected regions.
Keep that contract intact when changing templates or the writer:

- Use the canonical marker tag `<cleanstack:user-code id="...">` with the file's
  comment syntax. Do not write `checksum` values in templates; the writer adds
  them.
- Keep region ids stable. Renaming an id is a breaking change that looks like a
  removed region plus a new one.
- Keep regions focused: a method body, a list of actions, a migration seed block.
- Do not remove an existing region without checking the merge behavior. Removing
  a region orphans user content and causes a conflict.
- Files without protected regions are preserved on rerun unless `--force` is
  passed. If a template starts owning a previously unmarked file, document the
  migration path.
- Test both first generation and regeneration. A template that renders once but
  fails to merge is not finished.
- Use relative, portable paths in manifests. Template and destination paths use
  forward slashes; validation rejects absolute paths and `..` segments.

See [Protected regions](protected-regions.md) and
[Templates](TEMPLATES.md) for the full contract.

## Template changes

A template pack is a directory with `manifest.json`, `.hbs` templates, and an
optional `partials/` directory.

- Add a manifest entry for every new template, with a stable destination.
- Use `when` for option-dependent files and `forEach: "entities"` for
  entity-scoped files.
- Use `executable: true` only for files that must be executable on POSIX, such
  as `mvnw`. Windows ignores the mode bit; `mvnw.cmd` is generated separately.
- Destination interpolation is limited to `{{package}}`, `{{ApplicationName}}`,
  and `{{entity.<property>}}`. Handlebars helpers are not evaluated in
  `destination`.
- Rendering is strict: guard optional data with `{{#if}}`/`{{#unless}}`.
- Output must be deterministic. Do not use the clock, random values, environment
  variables, or network access in a template.
- Keep the built-in catalog in `docs/TEMPLATES.md` in sync with the manifests.

For a quick end-to-end template check:

```sh
cleanstack templates list
cleanstack new demo --yes --db h2 --auth none
cleanstack regenerate --all --dry-run
```

For an override-only test, create `.cleanstack/templates/<pack>/...` and use
`cleanstack templates diff` to confirm that the override resolves.

## Test strategy

`npm test` compiles the TypeScript sources first, then runs the Node test
runner. Tests import the compiled files from `dist/`, so a stale build can hide
a change; the npm script builds automatically for this reason.

| Suite                              | Focus                                                        |
| ---------------------------------- | ------------------------------------------------------------ |
| `config.test.js`                   | Zod schemas, defaults, validation refinements                |
| `config-loader.test.js`            | precedence, file discovery, CLI/environment parsing          |
| `config-command.test.js`           | `config show/path/validate` output and errors                |
| `new-command.test.js`              | project creation, options, layout, metadata, dry runs        |
| `entity-command.test.js`           | descriptor discovery, inline fields, generation, sides       |
| `relations.test.js`                | ownership, migrations, request/response relation shapes      |
| `regenerate-command.test.js`       | metadata/config inference, `--all`, migration preservation   |
| `template-engine.test.js`          | override resolution, helpers, partials, strict rendering     |
| `template-overrides.test.js`       | project/user overrides, manifest replacement, precedence     |
| `templates-command.test.js`        | `list`, `init`, `diff`, `reset`                              |
| `spring-boot-templates.test.js`    | Spring Boot template renderings and generated-source checks  |
| `protected-regions.test.js`        | marker parsing, checksums, languages, format errors          |
| `protected-region-manager.test.js` | merge decisions, strategies, orphans, line endings           |
| `openapi-command.test.js`          | input discovery, generator invocation, manifests, collisions |
| `web-api.test.js`                  | Studio API routes, workspace safety, loopback restrictions   |
| `ui-command.test.js`               | UI argument parsing, server startup, static mode             |
| `doctor-command.test.js`           | environment checks and exit behavior                         |
| `file-system.test.js`              | root confinement, dry runs, overwrite and backup behavior    |
| `cli-program.test.js`              | command tree, aliases, global flags, help/version            |
| `errors.test.js`                   | error formatting, suggestions, and exit-code helpers         |
| `logger.test.js`                   | log levels, tables, colors, and quiet/verbose output         |
| `e2e.test.js`                      | opt-in generated-project build, test, start, and API call    |

### Writing tests

- Use `node:test` and `node:assert/strict`.
- Create temporary directories with `mkdtemp` and clean them in `finally`.
- Prefer testing the compiled command functions (`dist/cli/...`) or public
  modules over spawning the CLI, except when testing the entry point itself.
- Inject filesystem adapters, loggers, command runners, and clocks where the
  code supports it. Tests must not depend on the host's installed Java, Maven,
  or network unless they are explicitly opt-in.
- Assert both the success path and the failure message. Error paths are part of
  the user experience.
- Keep tests platform-neutral. CI runs on Ubuntu, Windows, and macOS; use
  `path.join`, avoid shell-specific commands, normalize line endings before
  comparing text, and account for executable bits only on POSIX.
- Do not write into the repository during tests; use temporary workspaces.

### End-to-end test

`npm run test:e2e` builds the CLI and runs `tests/e2e.test.js`. It creates a
project with H2 and no authentication, adds three related entities, checks the
generated layout and migrations, runs the generated backend's Maven tests, starts
the application on a free port, waits for `/actuator/health`, and calls
`/api/greetings`.

It requires:

- JDK 21 or later (`JAVA_HOME` or the Java reported by `mvn -v`)
- Maven or the generated Maven wrapper's network access to download Maven and
  dependencies
- Network access for the first dependency download
- Up to ten minutes on a cold machine

The test is skipped during `npm test` unless `CLEANSTACK_E2E=1` is set or the
script is run through `npm run test:e2e`. It is not part of the standard CI
matrix because of the external toolchain and network requirements.

## Studio development

Studio is a React 19 + Vite app in `web/`. It talks to the local server in
`src/web/`, which delegates generation to the same command functions as the CLI.

```sh
npm run ui:dev     # Vite hot reload; the API starts with the dev server
npm run ui:check   # TypeScript check for web/src and shared contracts
npm run ui:build   # production bundle in web/dist
npm run ui         # built bundle with the local API
```

Shared request/response types live in `src/web/contracts.ts`; keep the React
client and server protocol in sync there. The Studio must not duplicate
generation logic. Add a route to `src/web/api.ts` only when the action cannot be
expressed through an existing command function.

Static mode (`--static`) intentionally has no API. Changes that require the
server should gracefully fall back to demo data or be disabled in that mode.

## Documentation

Documentation is part of the product:

- `README.md` is the landing page and quick start. Keep it short enough to
  scan.
- `docs/GUIDE.md` covers installation, everyday usage, and troubleshooting.
- `docs/ARCHITECTURE.md` explains generator internals and generated application
  design.
- `docs/TEMPLATES.md` is the template catalog and authoring reference.
- `docs/entity-descriptor.md`, `docs/protected-regions.md`, and
  `docs/OPENAPI.md` are focused reference documents.
- `docs/COMPARISON.md` positions CleanStack against other generators; keep
  claims fair, linked, and dated.
- `docs/CONTRIBUTING.md` is this document.

When behavior changes, update every document that describes it. Cross-check
command examples against the actual `--help` output and run the commands in a
temporary directory when possible. Fix broken relative links as part of the same
change.

## Pull request checklist

- [ ] The branch is up to date with `main`.
- [ ] `npm run build` succeeds.
- [ ] `npm test` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run format:check` passes.
- [ ] New behavior has tests, including a failure case.
- [ ] User-visible changes include a changeset; internal-only changes do not.
- [ ] Template changes still regenerate safely and preserve protected regions.
- [ ] Generated files were not committed by accident.
- [ ] User-facing docs and command help are updated.
- [ ] The change works with relative and absolute paths on Windows, macOS, and
      Linux (no shell-only assumptions), with CRLF-sensitive files checked too.
- [ ] No secrets, personal paths, or workspace-specific values are committed.

## Reporting issues

Include:

- CleanStack version (`cleanstack --version`)
- Operating system and Node.js version
- JDK, Maven/Gradle, and Angular CLI versions when relevant
- The exact command and configuration (redact secrets)
- Expected and actual behavior
- Output from `cleanstack doctor`
- Relevant output with `--verbose`, especially for filesystem or template errors

Use a minimal reproduction when possible: a small configuration, a descriptor,
or a single template override.

## License

By contributing, you agree that your contributions are licensed under the MIT
License in [LICENSE](../LICENSE).
