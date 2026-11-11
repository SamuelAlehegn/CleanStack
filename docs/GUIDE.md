# CleanStack user guide

This guide covers installation, project creation, the generated applications,
entity generation, safe regeneration, templates, OpenAPI, configuration,
CleanStack Studio, and troubleshooting.

If you are new to the project, start with the
[README quick start](../README.md#quick-start), then come back here for the
details.

## Contents

- [Installation](#installation)
- [Create a project](#create-a-project)
- [Run a generated project](#run-a-generated-project)
- [Databases and authentication](#databases-and-authentication)
- [Generate an entity](#generate-an-entity)
- [Regenerate a project](#regenerate-a-project)
- [AI coding agents](#ai-coding-agents)
- [Protected regions](#protected-regions)
- [Template overrides](#template-overrides)
- [OpenAPI integration](#openapi-integration)
- [Configuration](#configuration)
- [CleanStack Studio](#cleanstack-studio)
- [Check the environment](#check-the-environment)
- [Troubleshooting](#troubleshooting)

## Installation

### Requirements

| Tool                | Requirement                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| Node.js (generator) | 22 or later                                                             |
| npm                 | Bundled with Node.js 22 or later                                        |
| JDK                 | 21 or later for generated Spring Boot projects                          |
| Maven               | 3.9 or later for generated Maven projects (or use the generated `mvnw`) |
| Gradle              | 8.14 or later for generated Gradle projects                             |
| Node.js (Angular)   | 22.22.3+, 24.15.0+, or 26.0.0+ for the generated Angular application    |
| Java (OpenAPI)      | 11 or later when running openapi-generator                              |

### Install from the repository

The CLI is currently used from a checkout:

```sh
git clone https://github.com/SamuelAlehegn/CleanStack.git
cd CleanStack
npm install
npm run build
npm link

cleanstack --version
```

`npm link` makes `cleanstack` available on your `PATH`. If you do not want a
global link, run the built entry point directly:

```sh
node /absolute/path/to/CleanStack/dist/cli/index.js --version
```

The root package is the generator, not a generated application. Use the built
CLI (`node dist/cli/index.js`) or `cleanstack` after linking. Building is
required after source changes because the `bin` entry points at `dist/`.

### Check the installation

```sh
cleanstack doctor
```

Doctor verifies Node.js, Java, the build tool, optional Angular CLI, Git, free
disk space, configuration validity, and built-in template integrity. It exits
non-zero when a hard requirement fails.

## Create a project

```sh
cleanstack new <name> [options]
```

The project name must be a single directory name. It may contain hyphens and
spaces, but not path separators or characters Windows rejects (`< > : " | ? *`).
Names reserved by Windows, such as `con`, `nul`, or `com1`, and names ending in a
space or period are also rejected.
CleanStack creates `<name>/` under the current directory (or under
`--output-dir`).

The output directory may be relative or absolute. Relative paths must stay
inside the current directory; absolute paths are useful for automation and CI.

### Options

| Option                                               | Meaning                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `--package <name>`                                   | Java package, for example `com.acme.app`                       |
| `--db <postgresql\|h2\|mysql>`                       | Database (default: `postgresql`)                               |
| `--auth <jwt\|session\|oidc\|keycloak\|auth0\|none>` | Authentication (default: `jwt`)                                |
| `--build <maven\|gradle>`                            | Backend build tool (default: `maven`)                          |
| `--frontend <angular\|none>`                         | Generate the Angular app (default: `angular`) or skip it       |
| `--migrations <flyway\|liquibase>`                   | Schema migration tool (default: `flyway`)                      |
| `--seed` / `--no-seed`                               | Generate one sample seed row per entity (or suppress seeds)    |
| `--docker`                                           | Emit a backend `Dockerfile`, `.dockerignore`, and compose file |
| `--output-dir <path>`                                | Directory that receives the generated project                  |
| `--entities`                                         | Include entities from the configuration or `entities/`         |
| `--no-entities`                                      | Skip entities from both sources                                |
| `--interactive`                                      | Prompt for any settings that are not already provided          |
| `-y, --yes`                                          | Skip prompts and use defaults for missing settings             |
| `--git`                                              | Run `git init` in the generated project                        |
| `--force`                                            | Overwrite generated files completely, including regions        |
| `--dry-run`                                          | Report what would change without writing files                 |
| `-h, --help`                                         | Show command help                                              |

`cleanstack new` always generates the Spring Boot backend. Use
`--frontend none` to create a backend-only project; there is no option to skip
the backend.

### Defaults

| Setting        | Default           |
| -------------- | ----------------- |
| Package        | `com.example`     |
| Database       | `postgresql`      |
| Auth           | `jwt`             |
| Build tool     | `maven`           |
| Migration tool | `flyway`          |
| Seed data      | Off               |
| Frontend       | Angular           |
| Docker         | Off               |
| Output         | Current directory |

With defaults, the generated backend expects PostgreSQL on `localhost:5432` and
a JWT issuer at `http://localhost:9000`. For a first run without external
services, use H2 and no authentication:

```sh
cleanstack new demo --db h2 --auth none --no-entities --yes
```

### Interactive creation

Running `new` without enough options starts a prompt for the missing settings:

```sh
cleanstack new demo
```

`--interactive` forces the prompt flow; settings already supplied by options,
environment variables, or a configuration file are kept, and only missing
settings are asked for. `--yes` never prompts and uses defaults for anything
missing.

### Output layout

```text
demo/
├── demo-backend/
│   ├── .mvn/wrapper/...
│   ├── mvnw
│   ├── mvnw.cmd
│   ├── pom.xml
│   └── src/main/java/com/example/...
├── demo-ui/
│   ├── angular.json
│   ├── package.json
│   └── src/app/...
├── AGENTS.md
├── ARCHITECTURE.md
├── .ai/rules/...
├── .gitattributes
└── .cleanstack/
    └── project.json
```

The top-level folder uses the name exactly as provided. The backend and frontend
folders use the kebab-case name plus `-backend` and `-ui`. Gradle projects get
`build.gradle.kts` and `settings.gradle.kts` instead of the Maven files. Maven
projects include a wrapper; Gradle projects use an installed Gradle 8.14+.

The generated `.gitattributes` keeps source files LF in Git checkouts and
Windows scripts CRLF, so the project behaves the same on Windows, macOS, and
Linux. The `.cleanstack/project.json` file records the normalized project
configuration and known entities. `cleanstack entity` and `cleanstack regenerate` use it to
recover settings when no nearby configuration file exists. Commit it with the
project.

### Include entities during creation

`new` can render entities immediately. It looks in two places:

1. The `entities` array in the resolved configuration file.
2. YAML/JSON descriptors in the workspace `entities/` directory.

When definitions exist, `new` asks whether to include them; `--yes` includes
them automatically, and `--entities` / `--no-entities` answer explicitly. If no
definitions are found, generation continues without entities.

```sh
cleanstack new shop --db h2 --auth none --entities --yes
```

Descriptors are read from the workspace and are not copied into the generated
project. Keep them in version control next to the project.

### Team defaults

A configuration file in the current directory or an ancestor supplies defaults
for every command. This lets a repository define its standard package, database,
and build tool:

```yaml
# .cleanstackrc.yml
packageName: com.acme
options:
  database: postgresql
  auth: jwt
  buildTool: maven
  docker: false
```

```sh
cleanstack new orders
```

See [Configuration](#configuration) for the complete search order and
precedence.

## Run a generated project

### Backend

Maven on macOS or Linux:

```sh
cd demo-backend
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
```

Maven on Windows (Command Prompt or PowerShell):

```powershell
cd demo-backend
.\mvnw.cmd spring-boot:run -Dspring-boot.run.profiles=dev
```

If the wrapper is unavailable or you prefer a local Maven installation:

```sh
mvn spring-boot:run -Dspring-boot.run.profiles=dev
```

Gradle (the quoted argument works in POSIX shells, Command Prompt, and
PowerShell):

```sh
cd demo-backend
gradle bootRun "--args=--spring.profiles.active=dev"
```

The service listens on <http://localhost:8080>. Set `SERVER_PORT` to change the
port. The development profile enables SQL logging and, for H2, configures the H2
console at `/h2-console`. The generated security configuration permits only the
health and documentation endpoints, so the console is reachable as generated
only with `--auth none`. For any authenticated mode, add a `/h2-console/**`
permit rule and allow frames before using it.

Useful endpoints:

| Endpoint                         | Purpose                  |
| -------------------------------- | ------------------------ |
| `/api/greetings?name=CleanStack` | Sample greeting endpoint |
| `/actuator/health`               | Health check             |
| `/swagger-ui.html`               | Swagger UI               |
| `/v3/api-docs`                   | OpenAPI JSON             |
| `/v3/api-docs.yaml`              | OpenAPI YAML             |

With authentication enabled, every application endpoint is protected. JWT and
OIDC modes require a bearer token; session mode requires a signed-in browser
session. The health and documentation endpoints are explicitly permitted.

### Frontend

```sh
cd demo-ui
npm install
npm start
```

The Angular dev server listens on <http://localhost:4200>. Requests under
`/api` are proxied to `http://localhost:8080` by `src/proxy.conf.json`. The
production build is written to `dist/<kebab-name>/browser`:

```sh
npm run build
```

The generated Angular app requires the Node version declared in its
`package.json`: `^22.22.3 || ^24.15.0 || ^26.0.0`.

### Docker

Generate with `--docker` and start the backend stack:

```sh
cd demo-backend
docker compose up --build
```

The compose file starts the application and, for PostgreSQL or MySQL, a
database container. `APP_PORT` and `DB_PORT` override the published ports. H2
projects start only the app container. The image expects a multi-stage Docker
build and exposes `/actuator/health` as its health check.

## Databases and authentication

### Databases

| Value        | Default datasource                                                        |
| ------------ | ------------------------------------------------------------------------- |
| `postgresql` | `jdbc:postgresql://localhost:5432/<snake_name>`, user/password `postgres` |
| `mysql`      | `jdbc:mysql://localhost:3306/<snake_name>`, user/password `root`          |
| `h2`         | In-memory PostgreSQL-compatible H2 database; user `sa`, empty password    |

The database name is the project name in snake case. Change the datasource in
`src/main/resources/application.yml` or with standard Spring Boot environment
variables. The selected migration tool runs at startup and validates the schema.

### Migrations and seed data

Choose the migration tool when the project is created:

```sh
cleanstack new shop --migrations flyway
cleanstack new shop --migrations liquibase
```

Flyway projects keep SQL migrations in
`src/main/resources/db/migration`. Liquibase projects keep changelogs in
`src/main/resources/db/changelog/changes`, included by
`db.changelog-master.xml`. Entity and regeneration commands use the tool stored
in `.cleanstack/project.json`, so the choice is stable for the life of the
project. An existing project without metadata is detected from the presence of
the Liquibase master changelog.

Migrations are append-only and descriptively named:

| Action | Flyway                            | Liquibase                         |
| ------ | --------------------------------- | --------------------------------- |
| Create | `V2__create_products_table.sql`   | `V2__create_products_table.xml`   |
| Update | `V3__update_products_add_sku.sql` | `V3__update_products_add_sku.xml` |
| Seed   | `V4__seed_products.sql`           | `V4__seed_products.xml`           |

When a descriptor changes, CleanStack compares it with the definition stored in
`.cleanstack/project.json` and writes a new update migration instead of editing
one that may already have run. Updates cover table renames, added and dropped
columns, SQL type changes, nullability, unique constraints, defaults, foreign
keys, and many-to-many join tables. Field renames are treated as a drop plus an
add because a rename cannot be inferred safely from names alone; edit the
generated update migration if you want to preserve the data. Re-running
`cleanstack new` for an existing project performs the same comparison, so a
changed entity in the configuration or `entities/` appends an update migration.

Seed migrations are generated in three ways:

```sh
cleanstack new shop --seed                    # sample row for every entity
cleanstack entity Product --seed              # sample row for one entity
cleanstack entity Product --no-seed           # suppress descriptor/project seeds
```

An entity can opt in with `seed: true` or provide explicit rows with
`seedData`:

```yaml
name: Product
fields:
  - name: name
    type: String
    required: true
  - name: price
    type: BigDecimal
    required: true
  - name: active
    type: boolean
    default: true
relations:
  - field: category
    type: many-to-one
    target: Category
    required: true
seedData:
  - id: 11111111-1111-4111-8111-111111111111
    name: Demo product
    price: 19.99
    active: true
    categoryId: 22222222-2222-4222-8222-222222222222
```

Keys are field names. Use `<relation>Id` for a to-one relation and `<relation>Ids`
for a to-many relation. Omit `id` to get a deterministic UUID, which keeps
regeneration snapshots stable. A required relation without an explicit id cannot
be seeded safely; CleanStack warns and skips that row. Only one seed migration is
created per table; later descriptor changes do not rewrite an applied seed
migration, so add a new migration when you need more rows.

### Authentication modes

| Mode       | Generated behavior                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `none`     | No Spring Security configuration or authentication dependency.                                                              |
| `jwt`      | Stateless JWT resource server; issuer from `JWT_ISSUER_URI` (default `http://localhost:9000`).                              |
| `session`  | Cookie-based login form at `/api/auth/login`; starter account `demo` / `demo`; CSRF protection for state-changing requests. |
| `oidc`     | Generic OIDC resource server; issuer from `OIDC_ISSUER_URI`; Angular uses authorization code with PKCE.                     |
| `keycloak` | OIDC resource server with Keycloak defaults; issuer from `KEYCLOAK_ISSUER_URI`.                                             |
| `auth0`    | OIDC resource server with Auth0 placeholders; issuer from `AUTH0_ISSUER_URI`.                                               |

All authenticated modes permit `/actuator/health`, `/actuator/health/**`,
`/v3/api-docs/**`, `/swagger-ui.html`, and `/swagger-ui/**`. All other requests
need a valid bearer token or, in session mode, a signed-in session.

CleanStack configures token _validation_, not token _issuance_, for JWT and OIDC
modes. Point the issuer at your provider, obtain a token from it, and send it
explicitly:

```sh
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/products
```

The generated Angular app includes a login page, profile page, route guard, and
HTTP interceptor for every authenticated mode. JWT mode accepts a pasted access
token for local development. Session mode signs in with the starter account and
sends the `JSESSIONID` cookie. OIDC modes redirect to the provider and use the
authorization-code flow with PKCE. Provider settings live in
`src/environments/environment.ts`; backend issuer settings live in
`src/main/resources/application.yml`.

## Generate an entity

The `entity` command adds an entity to a project created by `cleanstack new`:

```sh
cleanstack entity Product
cleanstack generate entity Product
cleanstack g e Product
```

Run it from the project root, from `demo-backend` or `demo-ui`, or from a
directory that contains exactly one generated project.

### Descriptor discovery

`cleanstack entity Product` looks for a matching descriptor in:

1. `entities/` in the current directory
2. `entities/` in the generated project root
3. `entities/` next to the generated project root

Files may be `.yaml`, `.yml`, or `.json`. A file matches when its name is the
entity name in PascalCase, kebab-case, camelCase, or snake_case, or when the
descriptor's `name` matches. Use `--descriptor <path>` for an explicit file.

### Descriptor format

```yaml
name: Product
fields:
  - name: name
    type: String
    required: true
    minLength: 2
    maxLength: 120
  - name: price
    type: BigDecimal
    required: true
    min: 0
    validations:
      - PositiveOrZero
  - name: active
    type: boolean
    default: true
relations:
  - type: ManyToOne
    target: Category
    field: category
    required: true
```

The descriptor supports:

- Java-style identifiers for entity, field, and relation names
- `String`, boolean, numeric, `BigDecimal`, `UUID`, and `java.time` field types
- `required`, `unique`, `default`, and `generated` flags
- `minLength`, `maxLength`, `min`, `max`, `pattern`, and named Bean Validation
  constraints
- `OneToOne`, `OneToMany`, `ManyToOne`, and `ManyToMany` relations

See [Entity descriptors](entity-descriptor.md) for the complete field and
relation reference, including owning/inverse rules and request/response shapes.

### Inline fields

If no descriptor exists, define fields on the command line:

```sh
cleanstack entity Product \
  --field 'name:String:required:maxLength=120' \
  --field 'price:BigDecimal:required:min=0' \
  --field 'active:boolean:default=true' \
  --table products
```

The shorthand is `name:type[:modifier...]`. Supported modifiers:

| Modifier                      | Meaning                                              |
| ----------------------------- | ---------------------------------------------------- |
| `required`                    | Value must be present                                |
| `unique`                      | Unique constraint                                    |
| `generated`                   | Persistence generates the value                      |
| `minLength=<n>`               | Minimum string length                                |
| `maxLength=<n>`               | Maximum string length                                |
| `min=<n>` / `max=<n>`         | Numeric bounds                                       |
| `pattern=<regex>`             | String regular-expression constraint                 |
| `validations=NotBlank\|Email` | Additional Bean Validation constraints               |
| `default=<value>`             | Default value; booleans, `null`, and numbers convert |

Use a JSON object for options without a shorthand:

```sh
cleanstack entity Product \
  --field '{"name":"price","type":"BigDecimal","required":true,"min":0}'
```

### Options

| Option                    | Meaning                              |
| ------------------------- | ------------------------------------ |
| `-d, --descriptor <path>` | Use a specific entity descriptor     |
| `--field <spec>`          | Inline field definition; repeatable  |
| `--table <name>`          | Table name for an inline entity      |
| `--package <name>`        | Override the detected Java package   |
| `--backend`               | Generate backend artifacts only      |
| `--no-backend`            | Skip backend artifacts               |
| `--frontend`              | Generate frontend artifacts only     |
| `--no-frontend`           | Skip frontend artifacts              |
| `--seed`                  | Generate a sample seed migration     |
| `--no-seed`               | Skip descriptor and project seeds    |
| `--force`                 | Overwrite generated files completely |
| `--dry-run`               | Report changes without writing files |

Without a side flag, both sides are generated when both exist. A missing target
side is an error, so `--frontend` fails in a backend-only project rather than
silently doing nothing.

### Generated artifacts

Backend:

- JPA entity in `domain`
- Spring Data repository
- Transactional service with CRUD use cases
- REST controller at `/api/<route-name>`
- Request and response DTOs plus a mapper
- Not-found exception mapped to HTTP 404
- Flyway migration or Liquibase changelog with columns, constraints, foreign
  keys, and join tables (plus an optional seed migration)

Frontend:

- Model interface and typed HTTP service
- List, detail, and create/edit form pages
- Lazy routes in `app.routes.ts`
- Navigation link in the application shell

Routes are `/products`, `/products/new`, `/products/:id`, and
`/products/:id/edit` for a `Product` entity. The generator inserts routes and
navigation at the `<cleanstack:entity-routes>` and `<cleanstack:entity-nav>`
markers, falling back to the route array and `<nav>` element if a custom
template removes them.

### Relations and generation order

Every relation target must exist in the descriptor set when the entity is
generated. For relations that own a foreign key or join table, generate the
target first:

```sh
cleanstack entity Category
cleanstack entity Tag
cleanstack entity Product
```

`ManyToOne` is always owning. `OneToMany` is always inverse and requires
`mappedBy` or an inferable `ManyToOne` on the target. `OneToOne` and
`ManyToMany` are owning by default; use `inverse: true` or `mappedBy` on the
other side.

To keep the first version simple, to-many relations are fetched eagerly. The
mapper includes labels so list and detail pages do not need extra requests.
Requests accept `<field>Id` for a single relation and `<field>Ids` for a
collection; responses include both ids and labels. Inverse relations are
read-only.

### Re-running the command

Running `entity` again merges the newly rendered files with protected regions in
the existing files. Custom code inside a region survives. Conflicts leave the
file untouched and are reported with region ids. The command compares the
descriptor with the definition stored in `.cleanstack/project.json`; when the
schema changed it appends an update migration, and when seeding is newly enabled
it appends a seed migration. Existing create migrations keep their versions and
are never edited.

Every generated entity is recorded in `.cleanstack/project.json`, so entities
created from inline fields can be regenerated later:

```sh
cleanstack regenerate entity Product
```

## Regenerate a project

`regenerate` re-renders files without losing code inside protected regions:

```sh
cleanstack regenerate                    # project skeleton only
cleanstack regenerate entity Product    # one entity
cleanstack regenerate --all              # skeleton and every known entity
```

It resolves settings from, in order:

1. `.cleanstack/project.json`
2. A configuration file near the generated project
3. Files already in the generated backend and frontend

Entities come from project metadata, the configuration file, and descriptors in
`entities/`. When metadata is missing, options are inferred from the generated
files: database from the datasource URL, authentication from the security
configuration, build tool from the build file, and Docker from the presence of
Docker files.

### Options

| Option                         | Meaning                                        |
| ------------------------------ | ---------------------------------------------- |
| `--all`                        | Regenerate the skeleton and all known entities |
| `--backend` / `--no-backend`   | Include or skip backend artifacts              |
| `--frontend` / `--no-frontend` | Include or skip frontend artifacts             |
| `--force`                      | Overwrite generated files completely           |
| `--dry-run`                    | Report what would change without writing files |

Existing Flyway migrations and Liquibase changelogs keep their `V<n>` numbers
during `--all`. Only files that changed are rewritten; schema changes since the
last metadata update are appended as new update migrations. Conflicts are
reported with region ids and stop the command unless you resolve them or pass
`--force`.

Use dry runs before a large regeneration:

```sh
cleanstack regenerate --all --dry-run
cleanstack regenerate --all
```

## AI coding agents

Generated projects include an agent documentation layer: `AGENTS.md` at the
workspace root (the file most AI coding tools read automatically), a
workspace-wide `ARCHITECTURE.md`, and a `.ai/` folder with binding rules for
architecture, naming conventions, protected regions, and the entity workflow.
The rules are regenerated with the project skeleton; extend each file inside
its `<cleanstack:user-code>` region to keep team-specific conventions.

See [AI-friendly conventions](ai-conventions.md) for the file list and
customization through template overrides.

## Protected regions

Protected regions make generated files safe to edit. A region is a pair of
comment markers; the generator owns everything outside the region and you own
everything inside it.

```java
// <cleanstack:user-code id="service.product.custom">
public void archive(Product product) {
    product.setArchived(true);
}
// </cleanstack:user-code>
```

Each start marker stores a SHA-256 checksum of the template body it was generated
from. On the next run, CleanStack compares the stored checksum with the current
body and the new template:

- Only the template changed: the new template body is written.
- Only you changed the region: your body is preserved.
- Both changed: a conflict is reported and the file is not written.
- The template removed the region: it is orphaned and reported, never silently
  deleted.

The default merge strategy is `manual`, which stops at a conflict. `--force`
replaces the entire file, including protected regions, and is the explicit
escape hatch. Files that contain no protected regions are preserved on rerun
unless `--force` is passed, because CleanStack cannot prove it owns their
content.

The canonical tag is `<cleanstack:user-code>`. Older files using
`<cleanstack:protected>` are accepted and upgraded on the next successful
write.

See [Protected regions](protected-regions.md) for marker syntax, checksum
semantics, per-region strategies, and error codes.

## Template overrides

Every generated file comes from a Handlebars template. Templates resolve
through three levels, per file:

1. `<project>/.cleanstack/templates/`
2. `~/.cleanstack/templates/`
3. Built-in templates shipped with CleanStack

The first file that exists wins. The layout mirrors the built-in packs:

```text
.cleanstack/templates/spring-boot/root/README.md.hbs
.cleanstack/templates/angular/src/app/models/Entity.ts.hbs
```

Override only the files you need. Everything else keeps using the built-in
templates, so upstream fixes continue to apply.

Which directory is "the project" depends on the command:

| Command                           | Project override location                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `cleanstack new`                  | `.cleanstack/templates/` in the directory it runs in                                                                    |
| `cleanstack entity`, `regenerate` | `.cleanstack/templates/` in the command's workspace root: the generated project root, or the subdirectory where it runs |

A `manifest.json` in an override pack replaces that pack's file list. Files not
listed in the override manifest are not generated; they are not inherited from
the built-in manifest.

### Managing overrides

```sh
cleanstack templates list            # every template and its effective source
cleanstack templates list spring-boot
cleanstack templates init            # copy built-in templates into the project
cleanstack templates diff            # compare overrides with built-ins
cleanstack templates reset <name>    # remove one override
```

`init` keeps existing override files unless `--force` is passed. `templates
reset` accepts a pack-qualified path with or without `.hbs`, for example
`spring-boot/root/README.md`. `--dry-run` reports changes without writing.

Keep protected-region markers in overridden templates. If a custom template
removes a region, that region becomes an orphan; under the default `manual`
strategy CleanStack reports a conflict and leaves the file unchanged, so the
template change can look ignored. Re-add the region or rerun with `--force`.
See [Templates](TEMPLATES.md) for the catalog, context variables, helpers,
manifest format, and authoring rules.

## OpenAPI integration

Generated backends publish their contract with springdoc while running:

- `http://localhost:8080/v3/api-docs` (JSON)
- `http://localhost:8080/v3/api-docs.yaml` (YAML)
- `http://localhost:8080/swagger-ui.html` (Swagger UI)

Generate a typed Angular client from the workspace root:

```sh
cleanstack openapi --input http://localhost:8080/v3/api-docs
cleanstack api --input openapi/openapi.json
```

Without `--input`, CleanStack searches common locations such as
`openapi/openapi.yaml`, `openapi.yaml`, `docs/openapi.yaml`, and the backend
resources. The default output is `src/app/api/generated` inside the Angular
project.

| Option                      | Meaning                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `-i, --input <path\|url>`   | OpenAPI 3 document or URL                                         |
| `-o, --output <path>`       | Angular output directory inside the frontend project              |
| `-g, --generator <name>`    | openapi-generator client generator (default `typescript-angular`) |
| `--contract-first`          | Also generate Spring API interfaces and models                    |
| `--backend-output <path>`   | Spring output under `src/main/java`; defaults to the package      |
| `--spring-generator <name>` | Spring generator (default `spring`)                               |
| `--force`                   | Replace collisions with unmanaged files                           |
| `--dry-run`                 | Generate in a temporary directory and report without writing      |

Client regeneration is manifest-based. openapi-generator writes to a temporary
directory first; only files recorded in `.cleanstack-openapi.json` are replaced
or removed, and custom files in the generated directory are preserved. The spec
is validated as OpenAPI 3 before generation. If a tracked file was edited after
generation, CleanStack warns before replacing it.

Contract-first mode generates both sides from one document:

```sh
cleanstack openapi --contract-first --input openapi/openapi.yaml
```

The Spring pass uses `interfaceOnly=true`; implement each generated interface in
a normal `@RestController` without repeating the class-level `@RequestMapping`.
Both outputs are planned before either is written.

openapi-generator needs Java 11 or later and network access if the generated
Angular app has not installed `@openapitools/openapi-generator-cli`. Use
`cleanstack doctor` to check Java. See [OpenAPI integration](OPENAPI.md) for
manifest details and troubleshooting.

## Configuration

### Configuration files

CleanStack reads the first supported file found in the current directory or up
to four parent directories:

- `cleanstack.config.ts`, `.mts`, `.js`, `.mjs`
- `cleanstack.config.json`, `.yml`, `.yaml`
- `.cleanstackrc`, `.cleanstackrc.json`, `.cleanstackrc.yml`,
  `.cleanstackrc.yaml`

TypeScript and JavaScript files default-export an object. JSON and YAML files
contain the same object. Set `CLEANSTACK_CONFIG` to use a specific file.

```ts
// cleanstack.config.ts
export default {
  packageName: 'com.acme',
  options: {
    database: 'postgresql',
    auth: 'jwt',
    buildTool: 'maven',
    migrationTool: 'flyway',
    seed: false,
    docker: false,
  },
};
```

```yaml
# .cleanstackrc.yml
packageName: com.acme
options:
  database: postgresql
  auth: jwt
  buildTool: maven
  migrationTool: flyway
  seed: false
```

A team defaults file may omit `name`; `cleanstack new <name>` supplies it. A
generated project's `name` comes from its root directory when settings are
resolved for `entity` or `regenerate`.

### Precedence

Highest priority first:

1. Command-line options
2. `CLEANSTACK_*` environment variables
3. Configuration file
4. Built-in defaults

Setting two aliases for the same value (for example `CLEANSTACK_DB` and
`CLEANSTACK_DATABASE`, or passing both `--package` and `--package-name`) is an
error rather than a silent choice.

### Environment variables

| Variable                                             | Setting                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `CLEANSTACK_NAME`                                    | Project name                                             |
| `CLEANSTACK_PACKAGE`, `CLEANSTACK_PACKAGE_NAME`      | Java package                                             |
| `CLEANSTACK_BACKEND`                                 | Generate backend files                                   |
| `CLEANSTACK_FRONTEND`                                | Generate frontend files                                  |
| `CLEANSTACK_DATABASE`, `CLEANSTACK_DB`               | `postgresql`, `mysql`, or `h2`                           |
| `CLEANSTACK_AUTH`                                    | `jwt`, `session`, `oidc`, `keycloak`, `auth0`, or `none` |
| `CLEANSTACK_BUILD`, `CLEANSTACK_BUILD_TOOL`          | `maven` or `gradle`                                      |
| `CLEANSTACK_MIGRATIONS`, `CLEANSTACK_MIGRATION_TOOL` | `flyway` or `liquibase`                                  |
| `CLEANSTACK_SEED`                                    | Generate seed migrations                                 |
| `CLEANSTACK_DOCKER`                                  | Emit Docker files                                        |
| `CLEANSTACK_DRY_RUN`                                 | Report changes without writing                           |
| `CLEANSTACK_OUTPUT_DIR`                              | Output directory                                         |
| `CLEANSTACK_CONFIG`                                  | Explicit configuration file                              |

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. Empty
variables are ignored.

```sh
CLEANSTACK_DATABASE=h2 cleanstack new demo
CLEANSTACK_CONFIG=./ci/team.yml cleanstack config validate
```

### Inspecting configuration

```sh
cleanstack config             # effective configuration (alias: show)
cleanstack config show --json # full configuration as JSON
cleanstack config path        # configuration file path
cleanstack config validate    # validate and report problems
```

`config` requires an existing configuration file; it does not invent one. Its
output includes environment overrides. Validation errors name the field path,
the expected values, and a suggested fix.

### Configuration shape

| Key                     | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| `name`                  | Project name (optional for team defaults)                |
| `packageName`           | Java package (default `com.example`)                     |
| `entities`              | Entity descriptors, same format as YAML descriptors      |
| `options.backend`       | Generate backend files                                   |
| `options.frontend`      | Generate the Angular app                                 |
| `options.database`      | `postgresql`, `mysql`, or `h2`                           |
| `options.auth`          | `jwt`, `session`, `oidc`, `keycloak`, `auth0`, or `none` |
| `options.buildTool`     | `maven` or `gradle`                                      |
| `options.migrationTool` | `flyway` or `liquibase`                                  |
| `options.seed`          | Generate a sample seed row for every entity              |
| `options.docker`        | Emit Docker files                                        |
| `options.dryRun`        | Report changes without writing                           |
| `options.outputDir`     | Output root for `new`                                    |

The schema is strict: unknown keys are rejected so typos surface immediately.

## CleanStack Studio

Start the local web UI:

```sh
cleanstack ui
```

The server listens on <http://127.0.0.1:5173> and discovers projects in the
current directory by default.

| Option               | Meaning                                      |
| -------------------- | -------------------------------------------- |
| `--port <number>`    | Port to listen on; `0` chooses any free port |
| `--host <name>`      | Host to bind (default `127.0.0.1`)           |
| `--workspace <path>` | Workspace for discovery and generation       |
| `--dev`              | Serve through Vite with hot reload           |
| `--static`           | Serve the built UI with demo data and no API |

The workspace comes from `--workspace`, then `CLEANSTACK_WEB_WORKSPACE`, then
the current directory. Studio uses the same engine as the CLI: project creation
calls `runNewCommand`, entity generation calls `runEntityCommand`, and previews
render the shared templates. Nothing is duplicated in the UI.

Studio provides:

- A four-step project wizard (project, stack, options, review) with **Download
  ZIP** and **Generate into workspace**
- A visual entity editor with fields, validation constraints, and relations
- Live previews of the YAML descriptor and representative generated files
- YAML save to `entities/<Name>.yaml`
- Project and entity discovery in the workspace

Local generation is only offered to loopback clients. ZIP downloads are built in
a temporary workspace folder and streamed as `<project>.zip`; the workspace is
left untouched. `--static` serves the built UI with bundled demo data and does
not access project files.

UI development scripts:

```sh
npm run ui        # build CLI + UI and start Studio with the API
npm run ui:dev    # Vite hot reload plus the local API
npm run ui:build  # build web/dist
npm run ui:check  # type-check the Studio sources
npm run ui:static # build and serve static demo mode
```

The same built bundle can be hosted on a static file server. Relative asset paths
let it run under a subpath; opening `index.html` from disk falls back to demo
data.

## Check the environment

```sh
cleanstack doctor
```

Doctor checks:

- Node.js 22+
- Java 21+
- Maven or Gradle, matching the detected project
- Angular CLI (optional, for frontend work)
- Git
- Free disk space
- Configuration file validity
- Built-in template integrity (manifests and referenced files)

Failures set a non-zero exit code. Warnings, such as a missing optional tool, do
not block generation but may prevent a generated project from building.

## Troubleshooting

| Symptom                                         | Cause and fix                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cleanstack: command not found`                 | Run `npm run build && npm link`, or invoke `node dist/cli/index.js`.                                                                                                   |
| Generated app fails on `npm install`            | Use a Node version allowed by the generated `package.json` (`^22.22.3`, `^24.15.0`, or `^26.0.0`).                                                                     |
| `No generated CleanStack project was found`     | Run the command inside a project created by `cleanstack new`, or in a directory containing exactly one such project.                                                   |
| `contains multiple generated projects`          | Change into the specific project directory; CleanStack will not guess.                                                                                                 |
| Backend fails to connect to PostgreSQL or MySQL | Start the database, use `--docker` with `docker compose up`, or regenerate with `--db h2` for local work.                                                              |
| Every API call returns 401                      | Authentication is enabled. Sign in through the Angular login page, or send a valid bearer token for JWT/OIDC modes.                                                    |
| Backend cannot reach the JWT issuer             | Set `JWT_ISSUER_URI`, `OIDC_ISSUER_URI`, `KEYCLOAK_ISSUER_URI`, or `AUTH0_ISSUER_URI` to an issuer that publishes OIDC metadata and signing keys.                      |
| Port 8080 or 4200 is busy                       | Set `SERVER_PORT` for the backend; pass `--port` to `ng serve` for the frontend.                                                                                       |
| Flyway or Liquibase rejects the schema          | Keep migrations append-only. Do not edit applied migrations; generate a new update migration or add a new `V<n>__*.sql` / changelog file.                              |
| `Protected region conflict`                     | Resolve the reported region ids, then rerun. Use `--force` only when you intend to discard region contents.                                                            |
| A custom template is ignored                    | The new template dropped an existing protected region. The merge reported an orphaned-region conflict and left the file unchanged; re-add the region or use `--force`. |
| `TemplateNotFoundError`                         | Check the pack-relative path (`<pack>/<template>.hbs`) and run `cleanstack templates list`.                                                                            |
| `No OpenAPI document was found`                 | Pass `--input`, or save the contract under `openapi/`. Start the backend first for the live URL.                                                                       |
| openapi-generator fails                         | Check Java 11+, network access for `npx`, and rerun with `--verbose`.                                                                                                  |
| Unexpected failure                              | Rerun with `--verbose` for stack traces and filesystem operations. Use `--dry-run` to inspect decisions without writing.                                               |

For deeper detail:

- [Architecture](ARCHITECTURE.md) — how the generator and generated applications fit together
- [Templates](TEMPLATES.md) — template catalog and override authoring
- [Protected regions](protected-regions.md) — merge rules and error codes
- [Entity descriptors](entity-descriptor.md) — complete descriptor reference
- [Extensions](EXTENSIONS.md) — adding field types and frontend frameworks
- [OpenAPI integration](OPENAPI.md) — client manifests and contract-first details
- [Comparison](COMPARISON.md) — how CleanStack differs from other generators
