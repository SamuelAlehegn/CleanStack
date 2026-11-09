# Architecture

CleanStack is a local code generator with two front ends over one engine:

```text
┌────────────────────┐        ┌──────────────────────────┐
│ CLI (src/cli)      │        │ CleanStack Studio        │
│ commander commands │        │ React UI (web/)          │
└─────────┬──────────┘        └────────────┬─────────────┘
          │                                │ local HTTP API
          │                                ▼
          │                    ┌──────────────────────────┐
          │                    │ Local server (src/web)   │
          │                    └────────────┬─────────────┘
          └───────────────┬─────────────────┘
                          ▼
          ┌──────────────────────────────────────────────┐
          │ Shared engine                                │
          │  src/core      configuration, entities,      │
          │                projects, regeneration,       │
          │                OpenAPI ownership             │
          │  src/templates Handlebars engine, manifests  │
          │  src/utils     filesystem, paths, errors     │
          └──────────────────┬───────────────────────────┘
                             ▼
          ┌──────────────────────────────────────────────┐
          │ Template packs (templates/spring-boot,       │
          │ templates/angular) → generated project       │
          └──────────────────────────────────────────────┘
```

The CLI and Studio do not reimplement generation. The Studio calls the same
command functions (`runNewCommand`, `runEntityCommand`) and template engine, so
the same inputs produce the same files. Templates are data, not code; adding a
file is usually a manifest entry plus a `.hbs` template.

## Design principles

1. **Generate plain, readable code.** Generated projects are ordinary Spring
   Boot and Angular projects. There is no CleanStack runtime dependency in the
   output.
2. **The generator owns generated files; the user owns protected regions.**
   Regeneration is safe by default: checksums detect drift, conflicts stop
   writes, and `--force` is the explicit override.
3. **Strict inputs.** Configuration and entity descriptors are validated with
   Zod schemas. Unknown keys, bad identifiers, unresolved relation targets, and
   invalid option combinations fail with field paths and suggestions.
4. **Deterministic output.** Templates must not read the clock, environment, or
   network. The same configuration produces the same bytes.
5. **Local-first.** No hosted service, telemetry, or remote account. Studio's
   local API is loopback-only for generation and ZIP output is staged locally.
6. **Path safety.** Every generator write is constrained to a root directory;
   template names and OpenAPI outputs cannot escape it.

## Repository layout

| Path            | Responsibility                                                                |
| --------------- | ----------------------------------------------------------------------------- |
| `src/cli`       | CLI entry point, command parsers, human-readable reports                      |
| `src/core`      | Configuration, entity parsing/modeling, project discovery, metadata, merging  |
| `src/templates` | Template engine, manifest reading/planning/rendering, helpers                 |
| `src/utils`     | Filesystem service, path-safety helpers, errors, logger                       |
| `src/web`       | Local HTTP API and static/dev server used by Studio                           |
| `web`           | React 19 Studio sources and Vite build output                                 |
| `templates`     | Built-in Spring Boot and Angular template packs                               |
| `tests`         | Node test-runner suites for CLI, core, templates, web API, and the opt-in e2e |
| `docs`          | Architecture, guide, template, entity, region, OpenAPI, comparison material   |
| `entities`      | Example descriptor used during development                                    |
| `dist`          | Compiled CLI, library, and declarations (build output)                        |

The library entry point (`src/index.ts`) re-exports the public core:
configuration, config loading, entity input/model/parser, frontend updates,
OpenAPI client generation, project metadata/discovery, protected regions, the
template engine, filesystem, logger, and path-safety helpers.

## Command execution

`src/cli/index.ts` reads the package version, extracts global verbosity flags
from anywhere in `argv`, builds a `Logger`, and creates the commander program.
`src/cli/program.ts` defines the command tree:

| Command                             | Handler                |
| ----------------------------------- | ---------------------- |
| `new`                               | `runNewCommand`        |
| `entity`, `generate entity`, `g e`  | `runEntityCommand`     |
| `regenerate`, `r`                   | `runRegenerateCommand` |
| `openapi`, `api`                    | `runOpenApiCommand`    |
| `templates list\|init\|diff\|reset` | `runTemplatesCommand`  |
| `config [show\|path\|validate]`     | `runConfigCommand`     |
| `doctor`                            | `runDoctorCommand`     |
| `ui`                                | `runUiCommand`         |

Commander deliberately allows unknown options for leaf commands, because each
command keeps its own parser and usage text as the source of truth for its
flags. Parse errors become `CliOptionError`s with suggestions. At the entry
point, unexpected errors are formatted (with stack traces under `--verbose`) and
set exit code 1; commander errors keep their own exit code.

## Generation pipelines

### `new`

1. Parse control flags (`--interactive`, `--yes`, `--git`, `--entities`,
   `--force`, `--dry-run`) separately from configuration flags.
2. Resolve configuration from CLI, environment, file, and defaults, without
   applying schema defaults yet, so the command can tell which settings are
   missing.
3. Prompt for missing settings when appropriate. `--yes` skips prompts.
4. Validate the project name (single directory name, no path separators).
5. Load and validate the complete `ProjectConfig`.
6. Discover entity descriptors in the workspace `entities/` directory and
   decide whether to include entities. Descriptors may come from the
   configuration `entities` array or from files.
7. Create `<outputDir>/<name>/`, then render the `spring-boot` manifest into
   `<kebab-name>-backend` and, when enabled, the `angular` manifest into
   `<kebab-name>-ui`.
8. Report file outcomes. Any protected-region conflict stops the command with a
   non-zero status.
9. Write `.cleanstack/project.json` for later regeneration.
10. Optionally run `git init` and print next steps.

`new` always renders the backend pack; only the frontend is optional. Project
template overrides resolve from the directory where `new` runs, because the
generated project's own `.cleanstack` directory does not exist yet.

### `entity`

1. Locate the generated project by walking upward and inspecting the current
   directory and its direct children when needed.
2. Resolve the project configuration from `.cleanstack/project.json`, a nearby
   configuration file, or inference from generated files.
3. Find a descriptor (`--descriptor`, `entities/` near the workspace/project,
   or an exact/fuzzy name match) or build an inline entity from `--field`
   options.
4. Parse and validate the descriptor set so relation targets resolve. Build
   normalized entity models.
5. Diff the descriptor against the entity stored in `.cleanstack/project.json`
   and plan a create, update, or seed migration with the next free `V<n>`
   version in the project's Flyway or Liquibase directory.
6. Render the entity-scoped backend entries and, when the frontend exists, the
   frontend entries. Backend and frontend template contexts use the generated
   subproject names for package/artifact naming.
7. Add Angular routes and navigation links if they are not already present.
8. Write the planned migrations and merge all rendered files with protected
   regions. Conflicts stop the command.
9. Update `.cleanstack/project.json` with the entity definition.

### `regenerate`

1. Locate the project and resolve configuration from metadata, a nearby file,
   or inference.
2. Discover entities from metadata, configuration, and `entities/` descriptors.
3. For `regenerate entity <name>`, reuse the entity path of the `entity`
   command.
4. For the project target, render the skeleton manifests. `--all` also
   regenerates every discovered entity and appends update migrations for
   descriptor changes.
5. Preserve existing migration numbers during `--all`, so applied migrations do
   not get renamed.
6. Report created/updated/unchanged/preserved/conflict outcomes and stop on
   unresolved conflicts.

### `openapi`

1. Locate a project with an Angular frontend; contract-first also requires a
   backend.
2. Resolve the input from `--input` (a path or a running springdoc URL) or the
   discovery paths. Download URLs to a temporary file and validate OpenAPI 3.
3. Invoke openapi-generator into a temporary directory. The Angular pass uses
   `typescript-angular`; the optional Spring pass uses `spring` in
   interface-only mode.
4. Read the generator output, compute hashes, and compare with the existing
   `.cleanstack-openapi.json` ownership manifest.
5. Plan creations, replacements, stale deletions, and collisions before
   writing. Unknown files inside the generated directory are preserved; an
   unmanaged non-empty directory requires `--force`.
6. Write only tracked/generated paths. Contract-first plans both outputs before
   either write, so a collision in one target does not leave the other half
   updated.

### `templates`

`templates list` resolves every manifest entry through the override chain and
annotates the source (`project`, `user`, or `built-in`). `init` copies the
built-in pack into `.cleanstack/templates`, refusing to overwrite unless
`--force`. `diff` compares override files with their built-in counterparts.
`reset` deletes one override so the built-in wins again.

### `config`, `doctor`, and `ui`

`config` resolves the effective configuration from the first discovered file
plus environment variables and validates it with the same schema used by
generation. `doctor` runs independent environment checks, optionally against a
detected project, and reports suggestions. `ui` starts the local HTTP server,
which exposes the shared engine to the React app.

## Configuration model

`src/core/config.ts` defines the schemas:

- `FieldConfigSchema` — field name, type, required/legacy nullable, unique,
  default, generated, length/numeric bounds, regex pattern, and named Bean
  Validation constraints. Cross-field checks enforce string-only length
  constraints, numeric-only min/max, ordered bounds, and required/nullable
  consistency.
- `RelationConfigSchema` — field/name aliases, type in camel or kebab case,
  target, required, mappedBy, inverse. The transform normalizes to kebab-case.
- `EntityConfigSchema` — name, optional table name, fields, relations. Strict.
- `GenerationOptionsSchema` — backend, frontend, database, auth, build tool,
  Docker, dry-run, output directory. Strict, with defaults.
- `ProjectConfigSchema` — name, package name, entities, options, plus uniqueness
  and relation-target refinements.
- `ProjectDefaultsSchema` — the same shape with an optional name for team
  defaults files.

`ConfigLoader` merges sources in precedence order: CLI, environment, file,
schema defaults. Configuration files are discovered in the current directory
and up to four parents, in this order:

```text
cleanstack.config.ts  .mts  .js  .mjs  .json  .yml  .yaml
.cleanstackrc  .cleanstackrc.json  .cleanstackrc.yml  .cleanstackrc.yaml
```

TypeScript/JavaScript files are imported with `tsx`; JSON/YAML are parsed
directly. `CLEANSTACK_CONFIG` forces a specific file. Environment variables use
the `CLEANSTACK_*` names documented in the [user guide](GUIDE.md#configuration);
duplicate aliases are errors.

## Project discovery and metadata

`locateGeneratedProject` walks upward from the current directory, recognizing:

- a backend directory with `pom.xml` or `build.gradle.kts` plus
  `src/main/java`
- a frontend directory with `angular.json` plus `src/app`

A directory may contain both. If the current directory itself has no project,
its direct children are inspected as a fallback. More than one matching project
is an error rather than a guess. The resulting `workspaceRoot` is the current
directory when it is inside the project, including a backend or frontend
subdirectory; otherwise it is the project root. Template overrides resolve from
that root.

`.cleanstack/project.json` stores the normalized project configuration and
entities. It is written after generation and updated after each entity. Stored
metadata uses a lenient schema for relation targets, because entities are added
one at a time and a forward reference may exist temporarily; the strict schema
is applied when the project is next used for generation. When metadata is
missing, `resolveProjectConfig` falls back to a nearby configuration file and
then infers options from the generated files (datasource URL, security config,
build files, Docker files).

## Entity modeling

`EntityParser` reads YAML/JSON descriptors through `FileSystemService`, validates
them with `EntityConfigSchema`, rejects duplicate entities and unresolved
relation targets, and returns normalized models. `buildEntityModels` enriches
each entity with:

- `className` (PascalCase), `variableName` (camelCase)
- `pluralClassName`, `pluralVariableName`, `routeName` (kebab-case)
- `tableName` (explicit or plural snake case)
- a display field chosen from `name`, `title`, `label`, `code`, or `slug`
- relation metadata: owning side, `mappedBy`, join columns, join tables,
  target labels, request id fields, and form option sources

The migration planner orders entities so referenced tables exist before foreign
keys and join tables. `orderEntitiesForMigrations` walks owning relations
depth-first, and `generateEntityMigrations` assigns `V2`, `V3`, and so on after
the baseline. Create, update, and seed migrations share the same version
sequence, so applied files are never renumbered. Flyway SQL files and Liquibase
changesets are both produced from the same diff model; the tool is chosen by
`options.migrationTool` at project creation and stored in `.cleanstack/project.json`.

Descriptors support `OneToOne`, `OneToMany`, `ManyToOne`, and `ManyToMany`.
`ManyToOne` is owning; `OneToMany` is inverse and requires `mappedBy` or an
inferable matching relation. `OneToOne`/`ManyToMany` are owning by default and
become inverse with `inverse: true` or `mappedBy`. To-many relations are fetched
eagerly to keep the mapper simple for the first version.

## Templates and manifests

A template pack is a directory with a `manifest.json` and `.hbs` files. The
manifest maps templates to destinations and declares conditions:

```json
{
  "files": [
    { "template": "root/README.md.hbs", "destination": "README.md" },
    { "template": "build/pom.xml.hbs", "destination": "pom.xml", "when": { "buildTool": "maven" } },
    {
      "template": "java/domain/Entity.java.hbs",
      "destination": "src/main/java/{{package}}/domain/{{entity.className}}.java",
      "forEach": "entities"
    }
  ]
}
```

- `when` is an equality check against `options` or a top-level project field.
- `forEach: "entities"` renders the entry once per entity with `entity` added to
  the context.
- `executable: true` marks a generated file for mode `0755` (used by `mvnw`).
- Destination interpolation is limited to `{{package}}`, `{{ApplicationName}}`,
  and `{{entity.<ownProperty>}}`. Handlebars helpers are intentionally not
  evaluated in destinations.

`TemplateEngine` resolves a template per file through the override chain
(project, user, built-in), reads it, and renders with Handlebars `strict: true`
and `noEscape: true`. Strict mode turns missing variables into errors; values
are emitted verbatim, so template authors own HTML/JS escaping decisions.
Partials are registered from each pack's `partials/` directory, with the first
registration winning along the same chain. Manifest overrides replace the
pack's file list entirely.

`templateContext` supplies `project`, top-level project fields, `entities`,
`ApplicationName`, and, for entity-scoped renders, `entity`. Helpers include
casing (`camelCase`, `pascalCase`, `kebabCase`, `snakeCase`, `capitalize`,
`lowercase`, `uppercase`, `pluralize`), `packagePath`, `eq`, and `json`.

## Safe writes and protected regions

`renderManifest` renders each planned file and passes it to
`writeGeneratedFile`, which decides the outcome:

| Condition                                 | Result                                  |
| ----------------------------------------- | --------------------------------------- |
| File does not exist                       | Create, adding checksums to markers     |
| `--force`                                 | Overwrite completely                    |
| File type has no supported comment syntax | Preserve unless `--force`               |
| Template has no protected regions         | Preserve unless identical, or `--force` |
| Existing file has no protected regions    | Preserve unless `--force`               |
| Both have regions                         | Merge region by region                  |
| Merge has unresolved conflicts            | Report `conflict`, do not write         |

A protected region is a start/end marker pair in the file's comment syntax:

```text
// <cleanstack:user-code id="service.product.custom" checksum="sha256:...">
...user code...
// </cleanstack:user-code>
```

The checksum covers the normalized region body (LF line endings, one trailing
newline removed) and records the template body last generated. Comparing the
stored base, the current user body, and the new template body distinguishes
template-only changes, user-only changes, and conflicts. The default strategy is
`manual`; the manager also supports `keep-user` and `keep-template`, including
per-region overrides. Under `manual`, an orphaned region is a conflict rather
than a silent deletion; `keep-template` explicitly drops it. `--force` bypasses
the merge entirely. See [Protected regions](protected-regions.md) for the
decision table and error codes.

The merge manager is pure: it receives existing and generated text and returns
the merged text plus decisions/conflicts. `FileSystemService` separately handles
dry-run behavior, overwrite protection, structured action logging, and optional
backups.

## Path safety

`src/utils/path-safety.ts` and `FileSystemService` enforce that every operation
stays under a root:

- Paths must be relative and cannot contain `..` segments or NUL bytes.
- Absolute POSIX/Windows paths are rejected.
- Real paths are resolved through symlinks and checked again before access.
- Destructive operations refuse the filesystem root.
- Template names are normalized, must be relative, and cannot escape the pack.
- OpenAPI output paths must stay inside the frontend/backend project, and the
  backend output must be a valid package directory under `src/main/java`.

Dry-run mode uses the same planning and merge code but skips writes; reports
still include created, updated, overwritten, unchanged, preserved, and conflict
counts.

## Generated backend architecture

```text
com.example.demo/
  DemoApplication.java
  config/          ApplicationConfig, OpenApiConfig, package docs
  controller/      GreetingController, <Entity>Controller
  domain/          Greeting record, JPA entities
  exception/       <Entity>NotFoundException (+ package docs)
  repository/      Spring Data repositories
  security/        SecurityConfig for the selected authentication mode
  service/         GreetUseCase, GreetingService, <Entity>Service
  web/
    dto/           GreetingResponse, <Entity>Request/Response
    mapper/        <Entity>Mapper
  api/generated/   Contract-first interfaces and models (optional)
```

### Request flow

1. Spring MVC deserializes and validates a request record (`@Valid`).
2. The controller calls a mapper to build a domain entity.
3. The service applies the use case inside a transaction and calls a
   repository.
4. The controller maps the result to a response record and returns it.

Entity endpoints are:

| Method   | Path                | Result                       |
| -------- | ------------------- | ---------------------------- |
| `GET`    | `/api/<route>`      | List responses               |
| `GET`    | `/api/<route>/{id}` | One response or 404          |
| `POST`   | `/api/<route>`      | 201 with `Location` and body |
| `PUT`    | `/api/<route>/{id}` | Updated response             |
| `DELETE` | `/api/<route>/{id}` | 204                          |

The sample `GET /api/greetings?name=...` demonstrates the controller → use case
→ service path.

### Persistence

- UUID identifiers generated by JPA.
- `spring.jpa.hibernate.ddl-auto=validate`; Flyway or Liquibase owns the schema.
- A `V1` baseline is generated for every project. Entity migrations start at
  `V2` and include columns, primary keys, foreign keys, join tables, and
  optional seed rows. Descriptor changes append update migrations.
- Hibernate uses UTC for JDBC timestamps.
- `open-in-view` is disabled.

### Security

`jwt`, `oidc`, `keycloak`, and `auth0` generate a stateless `SecurityFilterChain`
with CSRF disabled, `SessionCreationPolicy.STATELESS`, JWT resource-server
support, and permit rules for health and documentation endpoints. The issuer
differs by mode: `JWT_ISSUER_URI`, `OIDC_ISSUER_URI`, `KEYCLOAK_ISSUER_URI`, or
`AUTH0_ISSUER_URI`. `session` instead generates a cookie-based login form with
CSRF protection, a starter in-memory user, and `/api/auth/csrf` and
`/api/auth/me` endpoints. `none` omits the security configuration and
authentication dependency. Token acquisition is outside the generator's scope,
but authenticated Angular apps include a login page, profile page, route guard,
and HTTP interceptor.

### Operations

- Virtual threads are enabled.
- Actuator exposes `health` and `info`; health probes are enabled.
- Graceful shutdown has a 20-second timeout.
- springdoc serves `/v3/api-docs`, `/v3/api-docs.yaml`, and `/swagger-ui.html`.
- The server port is `${SERVER_PORT:8080}`.
- Optional Docker files build a multi-stage image and a Compose stack with the
  selected database.

## Generated frontend architecture

```text
src/app/
  app.component.*        Root component
  app.config.ts          HttpClient, router, scrolling providers
  app.routes.ts          Lazy routes; entity routes are inserted here
  layout/app-layout/     Shell, navigation, responsive menu
  pages/home/            Landing page
  pages/settings/        Settings page
  pages/<route>/         Generated list, detail, and form pages
  models/                Entity interfaces
  services/              Typed HTTP services
  api/generated/         Optional OpenAPI client
  core/, directives/, guards/, interceptors/, shared/  Placeholders
```

- Angular 22 standalone components, signals, and zoneless change detection.
- Lazy `loadComponent` routes under the layout shell.
- `provideHttpClient(withFetch())` and router scrolling restoration.
- The dev server proxies `/api/**` to `http://localhost:8080`.
- `environment.apiBaseUrl` is `/api`; production builds can serve behind the
  same origin or override the value.
- Entity pages use signals for loading/error/selected state and subscribe to
  HTTP services for CRUD operations.
- Authenticated apps generate `core/auth/` (service, guard, interceptor) plus
  login and profile pages under `pages/auth/`. The login page adapts to the
  selected mode: JWT token entry, session username/password, or OIDC redirect.

## Studio architecture

Studio has two parts:

- `web/` — a React 19 + Vite application with a project wizard, entity editor,
  previews, and workspace pages.
- `src/web/` — a Node HTTP server that serves the built assets (or Vite in
  `--dev`) and exposes a JSON API.

The API routes include:

| Method | Route                    | Purpose                             |
| ------ | ------------------------ | ----------------------------------- |
| `GET`  | `/api/health`            | Server liveness                     |
| `GET`  | `/api/meta`              | Field types, defaults, capabilities |
| `GET`  | `/api/workspace`         | Workspace and project summaries     |
| `GET`  | `/api/projects`          | Project list                        |
| `GET`  | `/api/projects/detail`   | One project                         |
| `GET`  | `/api/projects/files`    | Project file inventory              |
| `GET`  | `/api/projects/file`     | One file's contents                 |
| `POST` | `/api/projects`          | Generate into the workspace         |
| `POST` | `/api/projects/download` | Generate and stream a ZIP           |
| `POST` | `/api/entities`          | Generate an entity                  |
| `POST` | `/api/entities/preview`  | Render previews without writing     |
| `POST` | `/api/entities/yaml`     | Save a descriptor                   |

Mutating routes delegate to the CLI command functions with a captured logger,
so messages and command arguments can be returned to the UI. Local generation
is rejected for non-loopback clients; ZIP downloads are allowed for any client
that can reach the server. Downloads are generated in a temporary staging
directory and streamed with `fflate`; the workspace is not written.

`--static` serves only the built UI and bundled demo data. The API is absent, so
generation, preview, ZIP, and YAML routes are disabled; the editor still renders
descriptors in the browser. The static bundle uses relative asset paths so it
can be hosted under a subpath.

## Error handling

- `CleanStackError` carries a message, optional suggestions, and an optional
  cause; `CliOptionError` is the command-line validation variant.
- `formatError` adds suggestions and stack traces for verbose output.
- Zod errors are formatted into field-by-field messages with paths.
- `ProtectedRegionFormatError` exposes stable codes for malformed markers,
  unclosed regions, nesting, tag mismatches, duplicate ids, and unsupported
  file types.
- Generation conflicts are reported per file and per region id; the command
  exits non-zero instead of writing a partial merge.

## Extension points

- **New CLI command:** add a `src/cli/<command>.ts` handler, register it in
  `src/cli/program.ts`, and export shared types if needed.
- **New template pack:** add `templates/<pack>/manifest.json` and `.hbs` files,
  then call `renderManifest` from the relevant command.
- **New field type or validation:** extend `FIELD_TYPES`/`FIELD_VALIDATIONS`,
  the entity model mappings, templates, SQL type mapping, and tests.
- **Custom output:** override one template or a manifest under
  `.cleanstack/templates`; no generator change is required.
- **Contract-first APIs:** use the `openapi` command rather than extending the
  entity templates.

## Deliberate tradeoffs

- The backend is always generated; only the Angular frontend is optional.
- One frontend stack (Angular) and one backend stack (Spring Boot) are
  supported. This keeps templates and generated code coherent.
- DTO mapping is explicit Java, not a mapping framework. Generated code stays
  readable and dependency-light.
- To-many relations are eager in the first version. This favors simple mapper
  code over large-collection performance tuning.
- The generator does not reverse-engineer databases or infer entities from an
  existing schema.
- Generated authentication is resource-server validation only; token issuance,
  login UI, and frontend authorization are application decisions.
- Generated projects can be used and modified without CleanStack. Regeneration
  is optional tooling, not a runtime requirement.
