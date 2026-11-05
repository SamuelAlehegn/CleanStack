# CleanStack Generator

CleanStack is a local project generator for **Spring Boot + Angular**
applications. It creates a Spring Boot 4.1 / Java 21 backend and an Angular 22
frontend from one configuration, then keeps them maintainable with entity
descriptors, safe regeneration, template overrides, and OpenAPI client
generation.

The generated code is intentionally plain: constructor injection, explicit
layers, manual DTO mapping, standard Flyway migrations, standalone Angular
components, and signals. There is no CleanStack runtime dependency and no
generated abstraction layer to learn.

## Why CleanStack

- **One command, two applications.** Generate a Spring Boot service and an
  Angular app that already agree on the API shape and development proxy.
- **Entities, not scaffolding exercises.** Describe an entity once and get the
  JPA model, repository, service, controller, DTOs, mapper, migration, Angular
  model, HTTP service, and list/detail/form pages.
- **Safe regeneration.** Hand-written code lives inside protected regions with
  checksums. Re-running a generator updates the generated code without
  silently deleting your work.
- **Template overrides.** Replace one file or a whole template pack at the
  project or user level. Built-in templates remain the fallback.
- **OpenAPI when you need it.** Generate a typed Angular client from a running
  backend or a saved contract, optionally with Spring API interfaces.
- **CLI and local Studio.** CleanStack Studio is a local web UI over the same
  engine, not a second implementation.
- **No telemetry, no hosted service.** Everything runs on your machine and
  writes to the paths you choose.

## Requirements

| Tool              | Version                                                       |
| ----------------- | ------------------------------------------------------------- |
| Node.js           | 22 or later for the generator                                 |
| npm               | Bundled with Node.js 22 or later                              |
| JDK               | 21 or later for generated Spring Boot projects                |
| Maven or Gradle   | Maven 3.9+ or Gradle 8.14+, matching the generated project    |
| Angular Node.js   | `^22.22.3`, `^24.15.0`, or `^26.0.0` for the generated app    |
| openapi-generator | Java 11+ when generating API clients (run locally or via npx) |

Run `cleanstack doctor` to check the tools on the current machine and get
suggested fixes for anything missing.

## Quick start

CleanStack is currently installed from a checkout. The CLI is not required to
be published to npm for local use.

```sh
git clone https://github.com/SamuelAlehegn/CleanStack.git
cd CleanStack
npm install
npm run build
npm link

cleanstack new demo --db h2 --auth none --no-entities --yes
cd demo
```

Start the backend in one terminal:

```sh
cd demo-backend
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
```

Start the frontend in another terminal:

```sh
cd demo-ui
npm install
npm start
```

Open:

- Frontend: <http://localhost:4200>
- Backend API: <http://localhost:8080/api/greetings>
- Swagger UI: <http://localhost:8080/swagger-ui.html>
- Health check: <http://localhost:8080/actuator/health>

This quick start uses H2 and disables authentication so the first run needs no
database or identity provider. The defaults are PostgreSQL, JWT, Maven, and an
Angular frontend; run `cleanstack new demo` without `--yes` for an interactive
wizard, or pass flags explicitly.

If you prefer not to install a global link, run the built CLI directly:

```sh
node /path/to/CleanStack/dist/cli/index.js new demo --db h2 --auth none --no-entities --yes
```

## What you get

```text
demo/
├── demo-backend/            Spring Boot 4.1 service
│   ├── mvnw                 Maven wrapper (Maven projects)
│   ├── pom.xml              or build.gradle.kts for Gradle
│   └── src/main/java/...
├── demo-ui/                 Angular 22 application (optional)
│   └── src/app/...
└── .cleanstack/
    └── project.json         Generation metadata used by regeneration
```

The Spring Boot backend is always generated. Pass `--frontend none` to create
only the backend.

### Backend

- Java 21 and Spring Boot 4.1.2 with Spring Web MVC, Spring Data JPA, and
  Bean Validation
- PostgreSQL, MySQL, or H2 configuration with Flyway migrations
- Layered packages: `controller`, `service`, `domain`, `repository`,
  `web/dto`, `web/mapper`, `config`, and `security`
- CRUD endpoints for each entity with validation and consistent HTTP statuses
- JWT resource-server security, Keycloak, or no authentication
- springdoc OpenAPI/Swagger UI and Actuator health endpoints
- Virtual threads enabled by default
- Optional Dockerfile and Docker Compose environment

### Frontend

- Angular 22 standalone components, signals, and zoneless change detection
- Page-first structure with lazy-loaded routes and a responsive application shell
- Entity list, detail, and create/edit pages backed by typed HTTP services
- Development proxy from `/api` to `http://localhost:8080`
- SCSS design tokens and no runtime UI framework dependency

Authentication is a backend concern. Generated Angular apps do **not** include a
login screen, token-acquisition flow, or HTTP interceptor. Add those in the
frontend when your identity provider and UX are decided; the backend validates
bearer tokens according to the selected mode.

## Commands

| Command                             | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `cleanstack new <name>`             | Create a project skeleton and optionally its entities      |
| `cleanstack entity <name>`          | Add an entity to an existing generated project             |
| `cleanstack generate entity <name>` | Alias for `cleanstack entity`                              |
| `cleanstack g e <name>`             | Short alias for `cleanstack entity`                        |
| `cleanstack regenerate`             | Re-render project files while preserving protected regions |
| `cleanstack regenerate --all`       | Re-render the skeleton and every known entity              |
| `cleanstack openapi [spec]`         | Generate Angular and optionally Spring API artifacts       |
| `cleanstack api [spec]`             | Alias for `cleanstack openapi`                             |
| `cleanstack templates ...`          | List, copy, diff, and reset template overrides             |
| `cleanstack config ...`             | Inspect and validate the resolved configuration            |
| `cleanstack doctor`                 | Check tool versions, configuration, and built-in templates |
| `cleanstack ui`                     | Start CleanStack Studio on a local port                    |

Global flags work before or after a command: `--verbose`/`-v`, `--quiet`/`-q`,
`--version`/`-V`, and `--help`/`-h`. Run `cleanstack <command> --help` for the
full option list.

## Entities in a minute

Add `entities/Product.yaml` in the workspace:

```yaml
name: Product
fields:
  - name: name
    type: String
    required: true
    maxLength: 120
  - name: price
    type: BigDecimal
    required: true
    min: 0
```

Then generate it:

```sh
cleanstack entity Product
```

CleanStack creates the backend model, persistence, service, HTTP layer, Flyway
migration, and the Angular model, service, and pages. Descriptors can also be
built inline with repeatable `--field` options:

```sh
cleanstack entity Product \
  --field 'name:String:required:maxLength=120' \
  --field 'price:BigDecimal:required:min=0'
```

See [Entity descriptors](docs/entity-descriptor.md) for field types,
validations, inline syntax, and relation ownership rules.

## Safe regeneration

Generated files contain protected regions. Each region records a checksum of
the template body it was generated from, so CleanStack can tell whether the
template changed, whether you changed the region, or both.

```sh
cleanstack regenerate --dry-run     # show what would change
cleanstack regenerate --all         # skeleton plus every known entity
cleanstack regenerate --force       # replace files completely, including regions
```

Files without protected regions are preserved on rerun unless `--force` is
passed. Conflicts leave the file untouched and are reported with the region
ids; generation stops rather than writing a partially merged file. See
[Protected regions](docs/protected-regions.md) for the full contract.

## CleanStack Studio

```sh
cleanstack ui
```

Studio opens on <http://127.0.0.1:5173>. It provides a four-step project wizard,
a visual entity editor with generated-code previews, and YAML save support. It
uses the same `runNewCommand` and `runEntityCommand` engine as the CLI, so the
wizard and terminal produce the same files.

```sh
cleanstack ui --workspace ~/projects --port 5180
cleanstack ui --host 0.0.0.0
cleanstack ui --static     # built UI only, bundled demo data, no API
```

Studio is local-first: local generation is restricted to loopback clients, and
ZIP downloads work without writing to the workspace. Static mode serves the
built bundle and demo data without accessing project files.

## Documentation

| Document                                        | Contents                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| [User guide](docs/GUIDE.md)                     | Installation, project creation, entities, regeneration, Studio, troubleshooting |
| [Architecture](docs/ARCHITECTURE.md)            | Generator modules, pipelines, template engine, generated application design     |
| [Templates](docs/TEMPLATES.md)                  | Template catalog, context variables, helpers, manifests, overrides              |
| [Entity descriptors](docs/entity-descriptor.md) | YAML format, field types, validations, relations                                |
| [Protected regions](docs/protected-regions.md)  | Marker syntax, checksums, merge strategies, error codes                         |
| [OpenAPI integration](docs/OPENAPI.md)          | springdoc, client generation, contract-first workflows, manifests               |
| [Comparison](docs/COMPARISON.md)                | CleanStack versus JHipster, Spring Initializr, Bootify, and Seed4J              |
| [Contributing](docs/CONTRIBUTING.md)            | Development setup, tests, conventions, pull request checklist                   |

## Development

```sh
npm run build          # compile the CLI and library to dist/
npm test               # build, then run the Node test suite
npm run test:e2e       # opt-in full-stack test; needs Java 21, Maven, network
npm run lint           # ESLint
npm run format:check   # Prettier check
npm run ui:check       # type-check the Studio sources
npm run ui             # build and start Studio with the local API
npm run ui:dev         # Vite hot reload plus the local API
```

See [Contributing](docs/CONTRIBUTING.md) for the test strategy, repository
layout, and template authoring rules.

## License

MIT. See [LICENSE](LICENSE).
