# CleanStack Generator

> A clean, maintainable generator for Angular and Spring Boot applications.

<!-- TODO: Add npm, CI, and license badges when publishing is configured. -->

CleanStack helps developers start full-stack projects with a clear structure and
readable generated code.

## Requirements

- Node.js 22 or later
- npm

## Getting started

```sh
npm install
npm run build
npm start
```

Run the built CLI with `node dist/cli/index.js <command>`, or install it globally
with `npm link` and use `cleanstack`.

## Commands

```text
cleanstack
  new                        Create a new project skeleton
  entity                     Generate an entity in an existing project
    generate entity          Alias for `entity`
    g e                      Alias for `entity`
  regenerate | r             Re-generate files, preserving protected regions
  templates                  List, copy, diff, and reset template overrides
  config                     Inspect the resolved configuration
  doctor                     Check the environment for common problems
  ui                         Open the web UI (not available yet)
  --version, -V              Print the version
  --help, -h                 Show help
  --verbose, -v              Show debug output
  --quiet, -q                Suppress non-error output
```

Global flags may appear before or after a command, so `cleanstack new demo
--verbose` and `cleanstack --verbose new demo` are equivalent. Run
`cleanstack <command> --help` for the full option list of any command.

## Configuration

CleanStack reads defaults from the first supported configuration file in the
current directory or up to four parent directories:

- `cleanstack.config.ts`, `.mts`, `.js`, `.mjs`
- `cleanstack.config.json`, `.yml`, `.yaml`
- `.cleanstackrc`, `.cleanstackrc.json`, `.cleanstackrc.yml`, `.cleanstackrc.yaml`

TypeScript and JavaScript files default-export an object; JSON and YAML files
contain the same object. A file checked into the repository root acts as
team-wide defaults, so `cleanstack new demo` picks it up from any subdirectory.

```ts
// cleanstack.config.ts
export default {
  packageName: 'com.acme',
  options: {
    database: 'postgresql',
    auth: 'jwt',
    buildTool: 'maven',
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
```

A team defaults file may omit `name`; the name passed to `cleanstack new` (or
`--name`) supplies it. Files may also list `entities` using the same format as a
generated project configuration.

### Environment variables

Every setting can also be supplied through a `CLEANSTACK_` environment
variable. Precedence, highest first:

1. Command-line options
2. Environment variables
3. Configuration file
4. Built-in defaults

| Variable                                        | Setting                            |
| ----------------------------------------------- | ---------------------------------- |
| `CLEANSTACK_NAME`                               | Project name                       |
| `CLEANSTACK_PACKAGE`, `CLEANSTACK_PACKAGE_NAME` | Java package                       |
| `CLEANSTACK_BACKEND`                            | Generate backend files             |
| `CLEANSTACK_FRONTEND`                           | Generate frontend files            |
| `CLEANSTACK_DATABASE`, `CLEANSTACK_DB`          | `postgresql`, `mysql`, or `h2`     |
| `CLEANSTACK_AUTH`                               | `jwt`, `none`, or `keycloak`       |
| `CLEANSTACK_BUILD`, `CLEANSTACK_BUILD_TOOL`     | `maven` or `gradle`                |
| `CLEANSTACK_DOCKER`                             | Emit Docker files                  |
| `CLEANSTACK_DRY_RUN`                            | Report changes without writing     |
| `CLEANSTACK_OUTPUT_DIR`                         | Output directory                   |
| `CLEANSTACK_CONFIG`                             | Explicit configuration file to use |

Boolean variables accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`.
Empty variables are ignored, and setting two aliases for the same option (for
example both `CLEANSTACK_DB` and `CLEANSTACK_DATABASE`) is an error.

```sh
CLEANSTACK_DATABASE=h2 cleanstack new demo
CLEANSTACK_CONFIG=./ci/team.yml cleanstack config validate
```

The `config` command reports the effective values for the discovered file,
including environment overrides:

```sh
cleanstack config             # print the effective configuration (alias: show)
cleanstack config show --json # print it as JSON
cleanstack config path        # print the configuration file path
cleanstack config validate    # validate the configuration and report problems
```

## Doctor

`cleanstack doctor` checks the tools and files needed to build generated
projects and prints a suggested fix for anything that is missing or outdated:

- Node.js 22+
- Java 21+
- Maven or Gradle, matching the detected project
- Angular CLI (optional, only needed for frontend work)
- Git
- Free disk space
- Configuration file validity
- Built-in template integrity (manifests and referenced template files)

```sh
cleanstack doctor
```

Doctor exits non-zero when a hard requirement fails. Warnings, such as a missing
optional tool, do not block generation but may prevent a generated project from
building.

## Error messages

Configuration and entity validation errors are reported field by field with
their full paths, expected values, and a suggested fix:

```text
✖ Invalid configuration in /work/app/.cleanstackrc.yml:
  • options.database: Invalid value. Expected one of: "postgresql", "mysql", "h2".
  • options.auth: Invalid value. Expected one of: "jwt", "none", "keycloak".

  Hint: Fix the highlighted fields and run "cleanstack config validate" again.
```

Missing entity descriptors list the directories that were searched, suggest a
similar file name when one exists, and show the inline `--field` alternative.
Use `--verbose` to include stack traces for unexpected failures.

## Safe regeneration

Generated files that are meant to be customized contain protected regions. Run the
same command again to update the generated code without losing anything you wrote
inside those regions. The generator reports every region it updated or preserved.

```sh
cleanstack new demo --yes
cleanstack new demo --yes --dry-run   # show what would change
cleanstack new demo --yes --force     # replace files, including protected regions
```

`--force` is the explicit escape hatch: it overwrites generated files completely.
`--dry-run` performs the same merge decisions and reports them without writing.

## Regenerating

The `regenerate` command re-runs generation on an existing project without
touching code inside protected regions:

```sh
cleanstack regenerate                    # project skeleton only
cleanstack regenerate entity Product     # one entity
cleanstack regenerate --all              # skeleton and every known entity
```

It decides what to regenerate from the generation metadata stored in
`.cleanstack/project.json` (written by `cleanstack new`), the configuration file
searched next to the generated project, and every descriptor in `entities/`.
When metadata is missing, options are recovered from the configuration file or
detected from the generated files themselves.

Options:

| Option                       | Meaning                                         |
| ---------------------------- | ----------------------------------------------- |
| `--all`                      | Regenerate the skeleton and all known entities. |
| `--backend / --no-backend`   | Regenerate or skip backend artifacts.           |
| `--frontend / --no-frontend` | Regenerate or skip frontend artifacts.          |
| `--force`                    | Overwrite generated files completely.           |
| `--dry-run`                  | Report what would change without writing files. |

Existing migrations keep their `V<n>` numbers during `--all`; only files that
changed are rewritten, and conflicts are reported with their region ids.

## Generating an entity

The `entity` command adds an entity to a project that was already generated with
`cleanstack new`. Run it from the project root, from the backend or frontend
directory, or from a directory that contains exactly one generated project.

```sh
cleanstack entity Product
cleanstack generate entity Product
cleanstack g e Product
```

By default the command reads `entities/Product.yaml` (or `.yml` / `.json`) and
generates both the Spring Boot and Angular artifacts. It also searches for the
descriptor in `<project>/entities` and in `entities/` next to the project.

To define an entity without a descriptor, pass one or more `--field` options:

```sh
cleanstack entity Product \
  --field 'name:String:required:maxLength=120' \
  --field 'price:BigDecimal:required:min=0' \
  --field 'active:boolean:default=true'
```

Generate only one side with `--backend` or `--frontend`, and skip a side with
`--no-backend` or `--no-frontend`. Other options:

| Option                    | Meaning                                         |
| ------------------------- | ----------------------------------------------- |
| `-d, --descriptor <path>` | Use a specific descriptor file.                 |
| `--field <spec>`          | Inline field definition; repeatable.            |
| `--table <name>`          | Table name for an inline entity.                |
| `--package <name>`        | Override the detected Java package.             |
| `--force`                 | Overwrite generated files completely.           |
| `--dry-run`               | Report what would change without writing files. |

Running the command again merges the generated code with the protected regions
in the existing files, so custom code survives. It adds the Angular routes and
navigation link automatically and picks the next Flyway migration version from
the existing migrations. See
[docs/entity-descriptor.md](docs/entity-descriptor.md) for the descriptor
format and the inline field syntax.

### Relations

Descriptors support `ManyToOne`, `OneToMany`, `ManyToMany` (with a join table),
and `OneToOne` relations. Generated entities use the matching JPA annotations,
migrations add foreign keys or join tables, requests accept relation ids, and
responses include readable labels. Angular forms render selects for the owning
side of each relation.

```yaml
name: Product
fields:
  - name: name
    type: String
    required: true
relations:
  - type: ManyToOne
    target: Category
    field: category
    required: true
  - type: ManyToMany
    target: Tag
    field: tags
```

Related descriptors must be present in `entities/`, and the target entity
should be generated before the entity that owns the foreign key or join table.
See [docs/entity-descriptor.md](docs/entity-descriptor.md#relations) for the
owning and inverse side rules.

## Template overrides

Every generated file comes from a Handlebars template. Templates resolve through
a three-level priority chain:

1. `.cleanstack/templates/` in the project (or the workspace root for
   `cleanstack new`)
2. `~/.cleanstack/templates/` in your home directory
3. Built-in templates shipped with CleanStack

The chain mirrors the template directory layout: to override a single file, copy
only that file and keep its relative path. For example, to replace the backend
README of the Spring Boot templates:

```text
.cleanstack/templates/spring-boot/root/README.md.hbs
```

A partial override affects just that file. Everything not overridden continues
to render from the built-in templates, so you never copy a whole template pack
to change one file. A template can also replace a template set's file list: put
a `manifest.json` with a `files` array in an override directory, and it fully
controls which files that set writes (built-in files you leave out are not
generated).

Which project level applies depends on the command:

| Command                           | Project override location                              |
| --------------------------------- | ------------------------------------------------------ |
| `cleanstack new`                  | `.cleanstack/templates/` next to the generated project |
| `cleanstack entity`, `regenerate` | `.cleanstack/templates/` inside the generated project  |

Keep override templates safe to regenerate: include the
`<cleanstack:user-code ...>` region markers where the built-in template has
them. Without a matching region the safe writer preserves the existing file on
reruns (see [Safe regeneration](#safe-regeneration)); `--force` overwrites.
`manifest.json` itself participates in the chain, and a manifest override must
declare a `files` array.

## Managing templates

The `templates` command inspects and manages the override directory of the
current project (`.cleanstack/templates`):

```sh
cleanstack templates list            # every template and where it resolves from
cleanstack templates init            # copy built-in templates into the project
cleanstack templates diff            # show differences from the built-in
cleanstack templates reset <name>    # remove one override, fall back to built-in
```

`list` annotates each template with its source (`project`, `user`, or
`built-in`) and flags override-only files. A pack name can narrow the output:
`cleanstack templates list spring-boot`.

`init` copies the built-in templates so you can edit them locally. Existing
override files are kept unless you pass `--force`; `--dry-run` reports what
would be copied without writing.

`diff` compares every override file with its built-in counterpart and prints
line differences (context collapsed around changes). Files that exist only in
an override are reported as added.

`reset` deletes an override file so the built-in template applies again. The
name is the pack-qualified template path (with or without the `.hbs`
extension), for example `spring-boot/root/README.md`. Without a project or user
override the command reports that nothing needs resetting; `--dry-run` only
reports what it would delete.

For the complete template catalog, context variables, helpers, manifest format,
and best practices, see [docs/TEMPLATES.md](docs/TEMPLATES.md).

## Development

```sh
npm run build
npm test
npm run lint
npm run format:check
```

## Project structure

- `src/cli` — command-line entry points and commands
- `src/core` — generator logic and shared domain behavior
- `src/templates` — template loading and rendering code
- `src/utils` — shared utilities
- `templates` — built-in project templates
- `tests` — automated tests
- `docs` — design and usage documentation
- `examples` — example configurations and generated projects

## Roadmap

- Add project configuration and validation
- Add built-in Spring Boot and Angular templates
- Generate projects from the command line

## License

MIT
