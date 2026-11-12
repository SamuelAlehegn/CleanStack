# Changelog

## [0.1.0] - 2026-11-12

First public release.

### Added

- **Project generator.** `cleanstack new` creates a Spring Boot 4.1 / Java 21
  backend and an Angular 22 frontend from one command, with options for
  PostgreSQL, MySQL, or H2; JWT, session, OIDC (Keycloak/Auth0), or no
  authentication; Maven or Gradle; Flyway or Liquibase; Docker files; seed
  data; and Git initialization.
- **Entity generation.** `cleanstack entity` (also `generate entity` and
  `g e`) produces the JPA model, repository, service, controller, DTOs,
  mapper, migration, Angular model, HTTP service, and list/detail/form pages
  from a YAML descriptor or inline `--field` flags. Includes relations,
  validation, seed rows, and append-only update migrations. Server-owned
  fields such as timestamps stay under server control.
- **Safe regeneration.** Generated files carry protected regions with
  checksums; `cleanstack regenerate` merges template updates without
  overwriting hand-written code. Supports targeted or `--all` runs, dry runs,
  and explicit `--force`.
- **Template overrides.** Project- and user-level overrides replace individual
  templates or whole packs, with `cleanstack templates` commands to list, copy,
  diff, and reset them.
- **Configuration.** `.cleanstackrc.yml` team defaults and environment
  variables, inspectable and validated with `cleanstack config`.
- **OpenAPI integration.** `cleanstack openapi` generates a typed Angular
  client from a live backend or saved contract, optionally with Spring API
  interfaces.
- **CleanStack Studio.** A local web UI (`cleanstack ui`) over the same
  generator engine, with a project wizard, visual entity editor, previews, ZIP
  downloads, and a static mode.
- **Extensions.** A light extension API for community field types and frontend
  frameworks, discoverable with `cleanstack extensions`.
- **AI coding agent support.** Every project includes `AGENTS.md`, a workspace
  `ARCHITECTURE.md`, and a `.ai/` rules folder covering architecture, naming,
  protected regions, and the entity workflow.
- **Doctor.** `cleanstack doctor` checks Node.js, Java, build tools, Angular
  CLI, Git, disk space, configuration, and built-in template integrity.
- **Cross-platform support.** Consistent Windows, macOS, and Linux behavior:
  portable line endings, BOM acceptance, Windows path-safety checks,
  `cmd.exe`/`PATHEXT` command resolution, platform-specific shell hints, and a
  generated `.gitattributes`.
- **Documentation and tests.** User, architecture, template, entity,
  protected-region, OpenAPI, extension, and comparison documentation, plus
  unit and full-stack end-to-end tests on Java 21.

### Changed

- Angular templates use a page-first layout with lazy-loaded routes, standalone
  components, signals, and zoneless change detection.
- CLI commands are organized as Commander subcommands with global flags,
  consistent errors, and on-demand module loading for faster startup.
- Template compilation is cached per engine and manifest writes run in parallel
  with bounded concurrency while preserving deterministic output.
- Generated files are installed atomically, and per-file output is quiet by
  default.

### Fixed

- Accept UTF-8 BOMs in configuration, entity, and OpenAPI files.
- Reject unsafe entity relation ordering before generating code.
- Preserve protected regions and server-generated fields during regeneration.
- Normalize generated line endings and Windows script line endings.
- Harden doctor checks and make CLI paths, commands, and hints portable.

[0.1.0]: https://github.com/SamuelAlehegn/CleanStack/releases/tag/v0.1.0
