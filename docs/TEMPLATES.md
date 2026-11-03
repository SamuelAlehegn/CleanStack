# Templates

CleanStack generates every file from a Handlebars template. Templates are
grouped into **packs** (`spring-boot` and `angular` today), and each pack ships
a `manifest.json` that maps templates to output paths.

This document covers:

- where templates are loaded from and how overrides resolve
- every template in the built-in packs
- the variables, entity fields, and helpers available to templates
- how to create a custom template pack
- best practices for writing safe, maintainable templates

See also:

- [README: Template overrides](../README.md#template-overrides) — user-facing
  override behavior and the `templates` commands
- [Protected regions](protected-regions.md) — the merge contract referenced
  throughout this document

## How templates are loaded

Templates resolve through a three-level priority chain. The first file that
exists wins, per template file:

| Priority | Root                              | Scope                                  |
| -------- | --------------------------------- | -------------------------------------- |
| 1        | `<project>/.cleanstack/templates` | Project override                       |
| 2        | `~/.cleanstack/templates`         | User override, shared between projects |
| 3        | `<package>/templates`             | Built-in templates                     |

The same chain applies to `manifest.json` and to partials, so a project can
replace one file, one manifest, or an entire pack.

Which directory is "the project" depends on the command:

- `cleanstack new` uses the directory it runs in (the workspace that contains
  the generated `<name>-backend` and `<name>-ui` folders).
- `cleanstack entity` and `cleanstack regenerate` use the generated project
  root, so their overrides live inside the generated project.

Inspect and manage overrides with:

```sh
cleanstack templates list [pack]      # template → effective source
cleanstack templates init             # copy built-ins into .cleanstack/templates
cleanstack templates diff [pack]      # override vs. built-in, line by line
cleanstack templates reset <name>     # drop one override, fall back to built-in
```

All paths inside a pack are relative to the pack root and always use forward
slashes. Template names on disk keep their `.hbs` suffix; the engine appends
`.hbs` automatically when a lookup name has no extension.

## Built-in packs

| Pack          | Generated into   | When generated             | Description                                                      |
| ------------- | ---------------- | -------------------------- | ---------------------------------------------------------------- |
| `spring-boot` | `<name>-backend` | `options.backend` is true  | Spring Boot service with layered packages, JPA, Flyway, and auth |
| `angular`     | `<name>-ui`      | `options.frontend` is true | Standalone Angular app with routing, signals, and entity screens |

Individual manifest entries can be disabled by project options. Entries marked
**entity** are rendered once per configured entity (`forEach: "entities"`).

## Spring Boot templates

Manifest: `templates/spring-boot/manifest.json`.

### Build and project files

| Template                        | Destination           | Condition | Purpose                                             |
| ------------------------------- | --------------------- | --------- | --------------------------------------------------- |
| `build/pom.xml.hbs`             | `pom.xml`             | Maven     | Spring Boot, JPA, Flyway, validation, and auth deps |
| `build/build.gradle.kts.hbs`    | `build.gradle.kts`    | Gradle    | Kotlin DSL build file with the same dependencies    |
| `build/settings.gradle.kts.hbs` | `settings.gradle.kts` | Gradle    | Gradle project name and repositories                |
| `root/.gitignore.hbs`           | `.gitignore`          | —         | Java/Maven/Gradle ignore rules                      |
| `root/README.md.hbs`            | `README.md`           | —         | Stack, run/build commands, configuration, structure |
| `root/ARCHITECTURE.md.hbs`      | `ARCHITECTURE.md`     | —         | Layering rules and package conventions              |

### Local infrastructure

| Template                                      | Destination                                        | Condition         | Purpose                            |
| --------------------------------------------- | -------------------------------------------------- | ----------------- | ---------------------------------- |
| `docker/Dockerfile.maven.hbs`                 | `Dockerfile`                                       | `docker` + Maven  | Multi-stage Maven image            |
| `docker/Dockerfile.gradle.hbs`                | `Dockerfile`                                       | `docker` + Gradle | Multi-stage Gradle image           |
| `docker/.dockerignore.hbs`                    | `.dockerignore`                                    | `docker`          | Build-context exclusions           |
| `docker/docker-compose.yml.hbs`               | `docker-compose.yml`                               | `docker`          | Service plus database container    |
| `resources/application.yml.hbs`               | `src/main/resources/application.yml`               | —                 | Base datasource/auth configuration |
| `resources/application-dev.yml.hbs`           | `src/main/resources/application-dev.yml`           | —                 | Local development profile          |
| `resources/db/migration/V1__baseline.sql.hbs` | `src/main/resources/db/migration/V1__baseline.sql` | —                 | Baseline Flyway migration          |

### Application and domain

| Template                                            | Destination                                                                      | Condition | Purpose                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | --------- | ------------------------------------------------- |
| `java/Application.java.hbs`                         | `src/main/java/{{package}}/{{ApplicationName}}Application.java`                  | —         | Spring Boot entry point                           |
| `java/domain/package-info.java.hbs`                 | `src/main/java/{{package}}/domain/package-info.java`                             | —         | Domain package documentation                      |
| `java/domain/Greeting.java.hbs`                     | `src/main/java/{{package}}/domain/Greeting.java`                                 | —         | Sample domain record used by the greeting API     |
| `java/domain/Entity.java.hbs`                       | `src/main/java/{{package}}/domain/{{entity.className}}.java`                     | entity    | JPA entity with fields, relations, and validation |
| `java/application/package-info.java.hbs`            | `src/main/java/{{package}}/service/package-info.java`                            | —         | Service package documentation                     |
| `java/application/GreetUseCase.java.hbs`            | `src/main/java/{{package}}/service/GreetUseCase.java`                            | —         | Greeting use case                                 |
| `java/application/GreetingService.java.hbs`         | `src/main/java/{{package}}/service/GreetingService.java`                         | —         | Greeting service implementation                   |
| `java/application/EntityService.java.hbs`           | `src/main/java/{{package}}/service/{{entity.className}}Service.java`             | entity    | Entity service                                    |
| `java/application/EntityRepository.java.hbs`        | `src/main/java/{{package}}/repository/{{entity.className}}Repository.java`       | entity    | Spring Data repository                            |
| `java/application/EntityNotFoundException.java.hbs` | `src/main/java/{{package}}/exception/{{entity.className}}NotFoundException.java` | entity    | Not-found exception for the entity                |

### Infrastructure and web

| Template                                                | Destination                                                                | Condition           | Purpose                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------- | ------------------------------------- |
| `java/infrastructure/config/package-info.java.hbs`      | `src/main/java/{{package}}/config/package-info.java`                       | —                   | Config package documentation          |
| `java/infrastructure/config/ApplicationConfig.java.hbs` | `src/main/java/{{package}}/config/ApplicationConfig.java`                  | —                   | Shared beans (clock, etc.)            |
| `java/infrastructure/security/package-info.java.hbs`    | `src/main/java/{{package}}/security/package-info.java`                     | —                   | Security package documentation        |
| `java/infrastructure/security/SecurityConfig.java.hbs`  | `src/main/java/{{package}}/security/SecurityConfig.java`                   | `auth` jwt/keycloak | HTTP security and JWT/keycloak wiring |
| `java/infrastructure/web/package-info.java.hbs`         | `src/main/java/{{package}}/controller/package-info.java`                   | —                   | Controller package documentation      |
| `java/infrastructure/web/GreetingController.java.hbs`   | `src/main/java/{{package}}/controller/GreetingController.java`             | —                   | Sample greeting endpoint              |
| `java/infrastructure/web/GreetingResponse.java.hbs`     | `src/main/java/{{package}}/web/dto/GreetingResponse.java`                  | —                   | Greeting response DTO                 |
| `java/infrastructure/web/EntityController.java.hbs`     | `src/main/java/{{package}}/controller/{{entity.className}}Controller.java` | entity              | CRUD controller                       |
| `java/infrastructure/web/EntityRequest.java.hbs`        | `src/main/java/{{package}}/web/dto/{{entity.className}}Request.java`       | entity              | Create/update request DTO             |
| `java/infrastructure/web/EntityResponse.java.hbs`       | `src/main/java/{{package}}/web/dto/{{entity.className}}Response.java`      | entity              | Read response DTO                     |
| `java/infrastructure/web/EntityMapper.java.hbs`         | `src/main/java/{{package}}/web/mapper/{{entity.className}}Mapper.java`     | entity              | Request/response/entity mapping       |
| `java/exception/package-info.java.hbs`                  | `src/main/java/{{package}}/exception/package-info.java`                    | —                   | Exception package documentation       |
| `java/web/dto/package-info.java.hbs`                    | `src/main/java/{{package}}/web/dto/package-info.java`                      | —                   | DTO package documentation             |
| `java/web/mapper/package-info.java.hbs`                 | `src/main/java/{{package}}/web/mapper/package-info.java`                   | —                   | Mapper package documentation          |

Entity SQL is generated by the migration template in the resources group:

| Template                                | Destination                                                                                           | Condition | Purpose                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------- |
| `resources/db/migration/Entity.sql.hbs` | `src/main/resources/db/migration/V{{entity.migrationVersion}}__create_{{entity.tableName}}_table.sql` | entity    | Table, constraints, foreign keys, join tables |

## Angular templates

Manifest: `templates/angular/manifest.json`.

### Project scaffold

| Template                                          | Destination                                   | Purpose                                      |
| ------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `root/package.json.hbs`                           | `package.json`                                | Angular and tooling dependencies and scripts |
| `root/angular.json.hbs`                           | `angular.json`                                | Workspace and build configuration            |
| `root/tsconfig.json.hbs`                          | `tsconfig.json`                               | Base TypeScript configuration                |
| `root/tsconfig.app.json.hbs`                      | `tsconfig.app.json`                           | Application TypeScript configuration         |
| `root/.gitignore.hbs`                             | `.gitignore`                                  | Node/Angular ignore rules                    |
| `root/README.md.hbs`                              | `README.md`                                   | Stack, run instructions, project structure   |
| `src/index.html.hbs`                              | `src/index.html`                              | HTML shell                                   |
| `src/main.ts.hbs`                                 | `src/main.ts`                                 | Bootstrap entry point                        |
| `src/styles.scss.hbs`                             | `src/styles.scss`                             | Global styles                                |
| `src/environments/environment.ts.hbs`             | `src/environments/environment.ts`             | Production environment                       |
| `src/environments/environment.development.ts.hbs` | `src/environments/environment.development.ts` | Development environment                      |
| `src/proxy.conf.json.hbs`                         | `src/proxy.conf.json`                         | Dev-server proxy to the backend              |

### Application shell and pages

| Template                                                  | Destination                                           | Purpose                                    |
| --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `src/app/app.config.ts.hbs`                               | `src/app/app.config.ts`                               | Application providers (router, HTTP)       |
| `src/app/app.routes.ts.hbs`                               | `src/app/app.routes.ts`                               | Route table (entity routes are added here) |
| `src/app/app.component.ts.hbs`                            | `src/app/app.component.ts`                            | Root component                             |
| `src/app/app.component.html.hbs`                          | `src/app/app.component.html`                          | Root template                              |
| `src/app/app.component.scss.hbs`                          | `src/app/app.component.scss`                          | Root styles                                |
| `src/app/app.component.spec.ts.hbs`                       | `src/app/app.component.spec.ts`                       | Root component test                        |
| `src/app/layout/app-layout/app-layout.component.ts.hbs`   | `src/app/layout/app-layout/app-layout.component.ts`   | Navigation shell                           |
| `src/app/layout/app-layout/app-layout.component.html.hbs` | `src/app/layout/app-layout/app-layout.component.html` | Navigation shell template                  |
| `src/app/layout/app-layout/app-layout.component.scss.hbs` | `src/app/layout/app-layout/app-layout.component.scss` | Navigation shell styles                    |
| `src/app/pages/home/home.component.ts.hbs`                | `src/app/pages/home/home.component.ts`                | Landing page                               |
| `src/app/pages/home/home.component.html.hbs`              | `src/app/pages/home/home.component.html`              | Landing page template                      |
| `src/app/pages/home/home.component.scss.hbs`              | `src/app/pages/home/home.component.scss`              | Landing page styles                        |
| `src/app/pages/settings/settings.component.ts.hbs`        | `src/app/pages/settings/settings.component.ts`        | Settings page                              |
| `src/app/pages/settings/settings.component.html.hbs`      | `src/app/pages/settings/settings.component.html`      | Settings page template                     |
| `src/app/pages/settings/settings.component.scss.hbs`      | `src/app/pages/settings/settings.component.scss`      | Settings page styles                       |

### Folder placeholders

These files document the intended layering and keep empty folders in version
control:

| Template                                      | Destination                               |
| --------------------------------------------- | ----------------------------------------- |
| `src/app/core/README.md.hbs`                  | `src/app/core/README.md`                  |
| `src/app/directives/README.md.hbs`            | `src/app/directives/README.md`            |
| `src/app/guards/README.md.hbs`                | `src/app/guards/README.md`                |
| `src/app/interceptors/README.md.hbs`          | `src/app/interceptors/README.md`          |
| `src/app/shared/README.md.hbs`                | `src/app/shared/README.md`                |
| `src/app/models/README.md.hbs`                | `src/app/models/README.md`                |
| `src/app/services/README.md.hbs`              | `src/app/services/README.md`              |
| `src/app/services/api/README.md.hbs`          | `src/app/services/api/README.md`          |
| `src/app/services/api/generated/.gitkeep.hbs` | `src/app/services/api/generated/.gitkeep` |

### Entity screens (rendered per entity)

| Template                                                     | Destination                                                       | Purpose                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------- |
| `src/app/models/Entity.ts.hbs`                               | `src/app/models/{{entity.variableName}}.ts`                       | Model interface            |
| `src/app/services/EntityService.ts.hbs`                      | `src/app/services/{{entity.variableName}}.service.ts`             | HTTP service               |
| `src/app/pages/entity/list/EntityListComponent.ts.hbs`       | `src/app/pages/{{entity.routeName}}/list/list.component.ts`       | List page component        |
| `src/app/pages/entity/list/EntityListComponent.html.hbs`     | `src/app/pages/{{entity.routeName}}/list/list.component.html`     | List page template         |
| `src/app/pages/entity/list/EntityListComponent.scss.hbs`     | `src/app/pages/{{entity.routeName}}/list/list.component.scss`     | List page styles           |
| `src/app/pages/entity/detail/EntityDetailComponent.ts.hbs`   | `src/app/pages/{{entity.routeName}}/detail/detail.component.ts`   | Detail page component      |
| `src/app/pages/entity/detail/EntityDetailComponent.html.hbs` | `src/app/pages/{{entity.routeName}}/detail/detail.component.html` | Detail page template       |
| `src/app/pages/entity/detail/EntityDetailComponent.scss.hbs` | `src/app/pages/{{entity.routeName}}/detail/detail.component.scss` | Detail page styles         |
| `src/app/pages/entity/form/EntityFormComponent.ts.hbs`       | `src/app/pages/{{entity.routeName}}/form/form.component.ts`       | Create/edit form component |
| `src/app/pages/entity/form/EntityFormComponent.html.hbs`     | `src/app/pages/{{entity.routeName}}/form/form.component.html`     | Form template              |
| `src/app/pages/entity/form/EntityFormComponent.scss.hbs`     | `src/app/pages/{{entity.routeName}}/form/form.component.scss`     | Form styles                |

## Template context

The context passed to every template has three layers:

- `project` — the full project configuration (`name`, `packageName`,
  `entities`, `options`)
- project fields spread at the top level — `name`, `packageName`, `entities`,
  and `options` are also reachable without the `project.` prefix
- `entities` — normalized entity models (the same array as
  `project.entities`, enriched for templates)
- `ApplicationName` — the project name in PascalCase (a legacy alias kept for
  the Spring Boot templates)

Entity-scoped templates additionally receive `entity` for the current entity.

### Project options

| Variable            | Type                            | Default      | Meaning                          |
| ------------------- | ------------------------------- | ------------ | -------------------------------- |
| `options.backend`   | boolean                         | `true`       | Generate the Spring Boot project |
| `options.frontend`  | boolean                         | `true`       | Generate the Angular app         |
| `options.database`  | `postgresql` \| `mysql` \| `h2` | `postgresql` | Database configuration           |
| `options.auth`      | `jwt` \| `none` \| `keycloak`   | `jwt`        | Authentication mode              |
| `options.buildTool` | `maven` \| `gradle`             | `maven`      | Backend build tool               |
| `options.docker`    | boolean                         | `false`      | Emit Docker files                |
| `options.dryRun`    | boolean                         | `false`      | Generation reporting mode        |
| `options.outputDir` | string                          | `.`          | Output root for generated files  |

### Entity model

| Variable                      | Example            | Meaning                                            |
| ----------------------------- | ------------------ | -------------------------------------------------- |
| `entity.name`                 | `Product`          | Name exactly as configured                         |
| `entity.className`            | `Product`          | PascalCase class name                              |
| `entity.variableName`         | `product`          | camelCase variable, file, and field prefix         |
| `entity.pluralName`           | `Products`         | Plural PascalCase name                             |
| `entity.pluralClassName`      | `Products`         | Alias of `pluralName`                              |
| `entity.pluralVariableName`   | `products`         | Plural camelCase variable                          |
| `entity.routeName`            | `products`         | kebab-case route and folder name                   |
| `entity.tableName`            | `products`         | Snake-case table name (or `tableName` override)    |
| `entity.fields`               | array              | Field models (see below)                           |
| `entity.relations`            | array              | Resolved relations (see below)                     |
| `entity.owningRelations`      | array              | Relations whose owning side this entity holds      |
| `entity.displayField`         | field or undefined | Field used for human-readable labels               |
| `entity.hasRelations`         | boolean            | Any relations                                      |
| `entity.hasCollections`       | boolean            | Any to-many relations                              |
| `entity.hasOwningCollections` | boolean            | To-many relations owned by this entity             |
| `entity.hasOwningSingles`     | boolean            | To-one relations owned by this entity              |
| `entity.persistenceImports`   | string[]           | Imports required for relations (persistence layer) |
| `entity.domainImports`        | string[]           | Imports for the JPA entity                         |
| `entity.requestImports`       | string[]           | Imports for the request DTO                        |
| `entity.responseImports`      | string[]           | Imports for the response DTO                       |
| `entity.relationColumns`      | array              | Foreign-key columns for migrations                 |
| `entity.joinTables`           | array              | Join tables for many-to-many ownership             |
| `entity.mapperRepositories`   | array              | Repositories the mapper needs                      |
| `entity.formOptionSources`    | array              | Relation option sources for Angular forms          |
| `entity.migrationVersion`     | number             | `V<n>` number assigned by the generator            |

### Field model

| Variable                        | Example      | Meaning                                          |
| ------------------------------- | ------------ | ------------------------------------------------ |
| `field.name`                    | `price`      | Field name                                       |
| `field.type`                    | `BigDecimal` | Declared field type                              |
| `field.required`                | `true`       | Required when saving                             |
| `field.unique`                  | `false`      | Unique constraint                                |
| `field.default`                 | `0`          | Default value, if any                            |
| `field.generated`               | `false`      | Generated by the database/application            |
| `field.minLength` / `maxLength` | `2` / `120`  | Length constraints                               |
| `field.min` / `max`             | `0`          | Numeric bounds                                   |
| `field.pattern`                 | `^[A-Z]+$`   | Regular-expression constraint                    |
| `field.validations`             | `['email']`  | Extra named validations                          |
| `field.javaType`                | `BigDecimal` | Java type used by backend templates              |
| `field.typescriptType`          | `number`     | TypeScript type used by Angular templates        |
| `field.typescriptDefault`       | `0`          | TypeScript literal used when the value is absent |
| `field.columnName`              | `price`      | Snake-case database column                       |
| `field.validationAnnotations`   | string[]     | Fully qualified Jakarta validation annotations   |

### Relation model

Each entry in `entity.relations` is a resolved relation:

| Variable                                                  | Meaning                                                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `relation.type`                                           | `OneToOne`, `OneToMany`, `ManyToOne`, or `ManyToMany`                                                                                           |
| `relation.target`                                         | Target entity name, as configured                                                                                                               |
| `relation.field`                                          | Field name on this entity                                                                                                                       |
| `relation.required`                                       | Whether the relation is mandatory                                                                                                               |
| `relation.inverse`                                        | Whether this is the inverse side                                                                                                                |
| `relation.mappedBy`                                       | Configured inverse field name                                                                                                                   |
| `relation.className`                                      | PascalCase field/property name                                                                                                                  |
| `relation.variableName`                                   | camelCase field name                                                                                                                            |
| `relation.targetEntity`                                   | Target metadata: `name`, `className`, `variableName`, `pluralName`, `pluralVariableName`, `routeName`, `tableName`, `labelField`, `labelGetter` |
| `relation.collection`                                     | To-many relation                                                                                                                                |
| `relation.owningSide`                                     | This entity owns the foreign key or join table                                                                                                  |
| `relation.mappedByField`                                  | `mappedBy` value for the inverse side                                                                                                           |
| `relation.javaType`                                       | `Category` or `List<Tag>`                                                                                                                       |
| `relation.singularVariableName`                           | Singular camelCase name used for ids/labels                                                                                                     |
| `relation.idField`                                        | DTO/form property holding the related id, e.g. `categoryId`                                                                                     |
| `relation.labelField`                                     | DTO/form property holding the related label                                                                                                     |
| `relation.joinColumnName`                                 | Foreign-key column on the owning entity                                                                                                         |
| `relation.joinTableName`                                  | Join table for many-to-many ownership                                                                                                           |
| `relation.joinTableJoinColumn` / `joinTableInverseColumn` | Join table columns                                                                                                                              |
| `relation.optionsSignalName`                              | Angular signal holding select options                                                                                                           |

## Helpers

The engine registers these Handlebars helpers in addition to the built-in
block helpers (`if`, `unless`, `each`, `with`, `lookup`):

| Helper        | Example                                      | Result                       |
| ------------- | -------------------------------------------- | ---------------------------- |
| `camelCase`   | `{{camelCase project.name}}`                 | `demoBackend`                |
| `pascalCase`  | `{{pascalCase project.name}}`                | `DemoBackend`                |
| `kebabCase`   | `{{kebabCase project.name}}`                 | `demo-backend`               |
| `snakeCase`   | `{{snakeCase project.name}}`                 | `demo_backend`               |
| `packagePath` | `{{packagePath project.packageName}}`        | `com/example`                |
| `capitalize`  | `{{capitalize entity.variableName}}`         | `Product`                    |
| `lowercase`   | `{{lowercase entity.name}}`                  | `product`                    |
| `uppercase`   | `{{uppercase entity.name}}`                  | `PRODUCT`                    |
| `pluralize`   | `{{pluralize entity.name}}`                  | `Products` (irregular-aware) |
| `eq`          | `{{#if (eq project.options.database "h2")}}` | boolean comparison           |
| `json`        | `{{json project.options}}`                   | pretty-printed JSON          |

Notes:

- Templates compile with `strict: true`, so referencing a missing variable is
  an error. Guard optional data with `{{#if ...}}` / `{{#unless ...}}`.
- Rendering uses `noEscape: true`; values are emitted verbatim. Escaping
  behavior is the template author's responsibility (for example, HTML content
  in an Angular template).
- `json` returns a `SafeString`, so structured output is not escaped.

## Writing a custom template pack

A pack is a directory containing `manifest.json` and any number of `.hbs`
templates. To customize generation for one project:

```sh
cleanstack templates init          # copy the built-in packs
# edit .cleanstack/templates/spring-boot/root/README.md.hbs
cleanstack templates diff          # review what changed
```

To share customizations between projects, place the pack under
`~/.cleanstack/templates/<pack>/`. The project-level pack always wins over the
user-level pack, which wins over the built-in one.

### Manifest format

```json
{
  "name": "spring-boot",
  "description": "Spring Boot service skeleton.",
  "pathVariables": {
    "package": "Java package with dots replaced by path separators.",
    "ApplicationName": "Project name converted to PascalCase."
  },
  "files": [
    { "template": "root/README.md.hbs", "destination": "README.md" },
    {
      "template": "build/pom.xml.hbs",
      "destination": "pom.xml",
      "when": { "buildTool": "maven" }
    },
    {
      "template": "java/domain/Entity.java.hbs",
      "destination": "src/main/java/{{package}}/domain/{{entity.className}}.java",
      "forEach": "entities"
    }
  ]
}
```

Manifest fields:

| Field                 | Required | Meaning                                                                             |
| --------------------- | -------- | ----------------------------------------------------------------------------------- |
| `name`                | no       | Pack name, informational                                                            |
| `description`         | no       | Human-readable summary                                                              |
| `pathVariables`       | no       | Documentation for destination placeholders                                          |
| `files`               | **yes**  | Ordered list of manifest entries; a manifest override without an array fails        |
| `files[].template`    | yes      | Template path inside the pack, including `.hbs`                                     |
| `files[].destination` | yes      | Output path relative to the generated project subset                                |
| `files[].when`        | no       | Equality conditions checked against `project.options` (or top-level project fields) |
| `files[].forEach`     | no       | Only `"entities"` today: render once per entity with `entity` in context            |

Destination interpolation is intentionally limited to:

- `{{package}}` — `packageName` with dots replaced by `/`
- `{{ApplicationName}}` — PascalCase project name
- `{{entity.<property>}}` — any own property of the current entity (for
  example `className`, `routeName`, `tableName`, `migrationVersion`)

Handlebars helpers do not run in `destination`; use the interpolations above.

A manifest override **replaces** the pack's file list. Files that the override
does not list are not generated; they are not inherited from the built-in
manifest.

### Partials

Any pack root may contain a `partials/` directory. Every `.hbs` file below it is
registered as a partial named by its relative path without the extension, so:

```text
.cleanstack/templates/spring-boot/partials/java/header.hbs
```

is available as:

```hbs
{{> java/header}}
```

Partials follow the same priority chain: the first registration wins, so a
project partial shadows the user and built-in partials of the same name.

### Worked example: override one entity template

1. Copy the built-in packs once, then edit the template you want to change
   while keeping its pack-relative path:

   ```sh
   cleanstack templates init
   ${EDITOR:-vi} .cleanstack/templates/angular/src/app/models/Entity.ts.hbs
   ```

   To override a single file without copying the rest, create only that file
   under `.cleanstack/templates/<pack>/` with the same relative path.

2. Keep the protected-region markers, then customize the surrounding template:

   ```hbs
   export interface
   {{entity.className}}
   { id: number; //
   <cleanstack:user-code id='model.{{entity.variableName}}.custom'>
     //
   </cleanstack:user-code>
   }
   ```

3. Regenerate and verify the merge:

   ```sh
   cleanstack regenerate --dry-run
   cleanstack templates diff angular
   ```

## Best practices

**Treat protected regions as part of the API.** Keep the region ids and comment
syntax from the built-in template. `checksum` attributes are written by the
generator; never put them in a template. If you remove a region from a custom
template, the safe writer will preserve existing user content instead of
overwriting it, which can make the new template look ignored. See
[Protected regions](protected-regions.md).

**Guard optional context.** Rendering is strict: a missing variable throws.
Prefer `{{#if entity.displayField}}` over assuming a display field exists, and
use `{{#unless field.generated}}` for fields that must not be bound in forms.

**Use helpers instead of duplicating casing rules.** Use `camelCase`,
`pascalCase`, `kebabCase`, `snakeCase`, and `packagePath` rather than
hard-coding names. Destination paths use the limited interpolation described
above, not helpers.

**Keep manifest destinations stable.** Destinations define regeneration
targets. Renaming a destination in an override creates a new file and leaves
the old one untouched; migrations and user edits are keyed to paths.

**Prefer partials for shared snippets.** Imports, license headers, and common
annotation blocks belong in `partials/`. A project-level partial can then
change every generated file consistently.

**Keep templates deterministic.** Do not depend on the clock, environment
variables, or network access. Output must be a pure function of the project
configuration and context so reruns stay stable.

**Respect language syntax in region markers.** Generated files are merged line
by line, so markers must use the file's comment syntax (`//` for Java and
TypeScript, `<!-- -->` for HTML/Markdown, `--` for SQL, `#` for YAML).

**Validate a pack before sharing it.**

```sh
cleanstack templates list <pack>     # every entry resolves where expected
cleanstack new demo --yes            # render the pack end to end
cleanstack regenerate --all --dry-run
```

**Keep custom packs small.** Override only the files you need. A single-file
override is supported and avoids drifting from upstream fixes for everything
else.

## Troubleshooting

| Symptom                                            | Cause and fix                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A custom template is ignored on rerun              | The template has no protected region matching the existing file, so the safe writer preserved it. Re-add the region or use `--force`.          |
| `TemplateNotFoundError` lists only built-in paths  | The override path is wrong; it must be `<root>/<pack>/<template>.hbs`. Run `cleanstack templates list` to compare.                             |
| `manifest.json` error about a `files` array        | A manifest override is malformed. The error names the source (`project: ...` / `user: ...`).                                                   |
| Changes do not appear for `entity`                 | Overrides for `entity` live inside the generated project (`.cleanstack/templates` in the project root), not in the workspace that contains it. |
| `cleanstack templates reset` says nothing to reset | The template resolves from the built-in pack; there is no project or user override to delete.                                                  |
| Rendered output shows literal `{{...}}`            | The placeholder is outside the supported destination subset (helpers are not evaluated in `destination`) or a partial is missing.              |
