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

To run the greeting command directly:

```sh
node dist/cli/index.js hello
```

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
