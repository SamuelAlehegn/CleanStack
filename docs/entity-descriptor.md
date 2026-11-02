# Entity descriptor format

An entity descriptor is one YAML document per entity. Store descriptors in `entities/` and use the entity name as the file name, for example `entities/product.yaml`.

## Command-line usage

Add an entity to a project that was already generated with `cleanstack new`:

```sh
cleanstack entity Product
cleanstack generate entity Product
cleanstack g e Product
```

All three forms are equivalent. The command can run from the project root, from
the backend or frontend directory, or from a directory that contains exactly
one generated project.

### Finding the descriptor

`cleanstack entity Product` searches these locations for a matching descriptor:

1. `entities/` in the current directory
2. `entities/` in the generated project root
3. `entities/` next to the generated project root

Descriptor files may use `.yaml`, `.yml`, or `.json`. A file matches when its
name is the entity name in PascalCase, kebab-case, camelCase, or snake_case, or
when the descriptor's declared `name` matches. Use `--descriptor <path>` to
point at a specific file.

### Inline fields

When no descriptor is available, pass one or more `--field` options:

```sh
cleanstack entity Product \
  --field 'name:String:required:maxLength=120' \
  --field 'price:BigDecimal:required:min=0' \
  --field 'active:boolean:default=true' \
  --table products
```

The shorthand is `name:type[:modifier...]`. Supported modifiers are:

| Modifier                      | Meaning                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `required`                    | The value must be present.                                         |
| `unique`                      | The value must be unique.                                          |
| `generated`                   | Persistence generates the value.                                   |
| `minLength=<n>`               | Minimum string length.                                             |
| `maxLength=<n>`               | Maximum string length.                                             |
| `min=<n>` / `max=<n>`         | Numeric bounds.                                                    |
| `pattern=<regex>`             | Regular expression for strings.                                    |
| `validations=NotBlank\|Email` | Additional Bean Validation constraints.                            |
| `default=<value>`             | Default value; `true`, `false`, `null`, and numbers are converted. |

For any option that has no shorthand, pass a JSON object instead:

```sh
cleanstack entity Product \
  --field '{"name":"price","type":"BigDecimal","required":true,"min":0}'
```

### Options

| Option                    | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `-d, --descriptor <path>` | Use a specific entity descriptor.                    |
| `--field <spec>`          | Inline field definition; repeatable.                 |
| `--table <name>`          | Table name for an inline entity.                     |
| `--package <name>`        | Override the Java package detected from the backend. |
| `--backend`               | Generate backend artifacts only.                     |
| `--no-backend`            | Skip backend artifacts.                              |
| `--frontend`              | Generate frontend artifacts only.                    |
| `--no-frontend`           | Skip frontend artifacts.                             |
| `--force`                 | Overwrite generated files completely.                |
| `--dry-run`               | Report what would change without writing.            |

Without a side flag, the command generates both sides when both projects are
present. The Java package is detected from the backend's `*Application.java`
unless `--package` is passed.

### Generated artifacts

For the backend, the command writes the JPA entity, repository, service,
controller, request/response DTOs, mapper, not-found exception, and a Flyway
migration. The migration version is derived from the existing
`V<number>__*.sql` files; an existing migration for the same table is reused.
When `new` generates several entities at once, migration versions are ordered
so related tables exist before foreign keys and join tables that reference
them.

For the frontend, the command writes the model, HTTP service, and list, detail,
and form pages, then adds the entity routes to `app.routes.ts` and a link to
`app-layout.component.html`. Route and navigation insertion uses the
`<cleanstack:entity-routes>` and `<cleanstack:entity-nav>` markers in the
built-in templates. If those markers are missing, the command falls back to the
route array and the `<nav>` element.

Repeated runs merge the newly rendered files with the protected regions in the
existing files, so code inside a region is kept. Region conflicts leave the file
untouched and are reported with their region ids. `--force` replaces generated
files completely, including protected regions. `--dry-run` reports the same
create, update, preserve, overwrite, and conflict decisions without writing.
Repeated route and navigation updates are skipped when the entity is already
present.

Every generated entity is recorded in `.cleanstack/project.json`, so entities
built from `--field` options without a descriptor can still be rebuilt later
with `cleanstack regenerate entity <name>` or `cleanstack regenerate --all`.

```yaml
name: Product
tableName: products # optional; defaults can be derived from the entity name

fields:
  - name: name
    type: String
    required: true
    minLength: 2
    maxLength: 100
    validations:
      - NotBlank

  - name: price
    type: BigDecimal
    required: true
    min: 0
    validations:
      - PositiveOrZero

  - name: active
    type: boolean
    default: true

  - name: createdAt
    type: Instant
    generated: true

relations:
  - type: ManyToOne
    target: Category
    field: category
    required: true
```

## Entity properties

| Property    | Type       | Meaning                                                    |
| ----------- | ---------- | ---------------------------------------------------------- |
| `name`      | identifier | Required Java-style entity name.                           |
| `tableName` | string     | Optional database table name.                              |
| `fields`    | list       | Scalar fields. Defaults to an empty list.                  |
| `relations` | list       | Associations to other entities. Defaults to an empty list. |

Field names and relation fields use Java-style identifiers. Names are case-sensitive within an entity; duplicate names are rejected.

## Field properties

| Property                 | Type           | Meaning                                                       |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| `name`                   | identifier     | Required field name.                                          |
| `type`                   | string         | One of the supported types below.                             |
| `required`               | boolean        | Whether a value must be present. Defaults to `false`.         |
| `unique`                 | boolean        | Whether the value must be unique. Defaults to `false`.        |
| `default`                | scalar or null | Default value.                                                |
| `generated`              | boolean        | Whether persistence generates the value. Defaults to `false`. |
| `minLength`, `maxLength` | integer        | String length bounds.                                         |
| `min`, `max`             | number         | Numeric value bounds.                                         |
| `pattern`                | string         | Regular expression constraint for strings.                    |
| `validations`            | list           | Additional supported Bean Validation constraints.             |

Length and pattern properties are only valid for `String`; `min` and `max` are only valid for numeric fields. Minimum values cannot exceed maximum values.

### Supported field types

| Descriptor type                                                    | Java type                          | Typical use                           |
| ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------- |
| `String`                                                           | `String`                           | Text                                  |
| `boolean`, `Boolean`                                               | primitive or boxed boolean         | Flags                                 |
| `byte`, `Byte`, `short`, `Short`, `int`, `Integer`, `long`, `Long` | Corresponding primitive or wrapper | Whole numbers                         |
| `BigInteger`                                                       | `java.math.BigInteger`             | Large whole numbers                   |
| `float`, `Float`, `double`, `Double`                               | Corresponding primitive or wrapper | Floating-point values                 |
| `BigDecimal`                                                       | `java.math.BigDecimal`             | Precise decimal values such as prices |
| `UUID`                                                             | `java.util.UUID`                   | UUID identifiers                      |
| `LocalDate`                                                        | `java.time.LocalDate`              | Calendar dates                        |
| `LocalTime`                                                        | `java.time.LocalTime`              | Time without a date or zone           |
| `LocalDateTime`                                                    | `java.time.LocalDateTime`          | Local date and time                   |
| `OffsetDateTime`                                                   | `java.time.OffsetDateTime`         | Date and time with an offset          |
| `Instant`                                                          | `java.time.Instant`                | UTC timeline timestamp                |

### Validation annotations

The descriptor uses annotation names without the `@` prefix. These are Jakarta Bean Validation constraints intended for generated Java fields:

| Descriptor setting                             | Annotation                      |
| ---------------------------------------------- | ------------------------------- |
| `required: true`                               | `@NotNull`                      |
| `minLength` / `maxLength`                      | `@Size(min = ..., max = ...)`   |
| `min` / `max`                                  | `@DecimalMin` / `@DecimalMax`   |
| `pattern`                                      | `@Pattern(regexp = ...)`        |
| `validations: [NotBlank]`                      | `@NotBlank`                     |
| `validations: [Email]`                         | `@Email`                        |
| `validations: [Positive]` / `[PositiveOrZero]` | `@Positive` / `@PositiveOrZero` |
| `validations: [Negative]` / `[NegativeOrZero]` | `@Negative` / `@NegativeOrZero` |
| `validations: [Past]` / `[PastOrPresent]`      | `@Past` / `@PastOrPresent`      |
| `validations: [Future]` / `[FutureOrPresent]`  | `@Future` / `@FutureOrPresent`  |

`required` expresses presence; `NotBlank` additionally rejects empty or whitespace-only strings. Validation names are case-sensitive and limited to the list above.

## Relations

`type` accepts `OneToOne`, `OneToMany`, `ManyToOne`, or `ManyToMany` (case-insensitive
forms such as `many-to-one` are accepted too). The `target` must match another
entity name in the project, and `field` names the association on this entity.
`required` defaults to `false`.

A relation has an owning side and an optional inverse side:

- `ManyToOne` is always the owning side.
- `OneToMany` is always the inverse side and requires `mappedBy`, or a matching
  `ManyToOne` relation on the target entity to infer it from.
- `OneToOne` and `ManyToMany` are owning by default. Mark the other side with
  `inverse: true` (or set `mappedBy`) to make it the inverse side.

```yaml
# entities/Product.yaml
name: Product
fields:
  - name: name
    type: String
    required: true
  - name: price
    type: BigDecimal
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

```yaml
# entities/Category.yaml
name: Category
fields:
  - name: name
    type: String
    required: true
relations:
  - type: OneToMany
    target: Product
    field: products
    # mappedBy: category      # inferred from Product.category
```

```yaml
# entities/Tag.yaml
name: Tag
fields:
  - name: name
    type: String
    required: true
relations:
  - type: ManyToMany
    target: Product
    field: products
    inverse: true
    # mappedBy: tags          # inferred from Product.tags
```

Every related descriptor must be available in `entities/` when the entity is
generated, because relation targets are validated up front. Generate the
target entity first when the relation owns the foreign key or join table:

```sh
cleanstack entity Category
cleanstack entity Tag
cleanstack entity Product
```

### Generated relation code

| Relation     | JPA mapping                                       | Database                               |
| ------------ | ------------------------------------------------- | -------------------------------------- |
| `ManyToOne`  | `@ManyToOne` + `@JoinColumn(name = "<field>_id")` | Foreign key column on the owning table |
| `OneToOne`   | `@OneToOne` + unique `@JoinColumn`                | Unique foreign key column              |
| `OneToMany`  | `@OneToMany(mappedBy = ...)`                      | No column; the other side owns the key |
| `ManyToMany` | `@ManyToMany` + `@JoinTable`                      | Join table named `<owner>_<target>`    |

Inverse sides emit `mappedBy` instead of a column. Many-to-many join tables use
`<owner singular>_id` and `<target singular>_id` columns, and their foreign keys
cascade on delete.

To keep the first version simple, to-many relations are fetched eagerly so the
mapper can include labels without extra queries. Relation payloads are flat:

- Requests accept `categoryId` for a single relation and `tagIds` for a
  collection. Inverse relations are read-only and are not accepted in requests.
- Responses include both `categoryId` and `categoryLabel` (or `tagIds` and
  `tagLabels`) using the target's `name`, `title`, `label`, `code`, or `slug`
  field when one exists, otherwise the target id.
- Angular forms render a `<select>` for single relations and a multiple
  `<select>` for collections, loading options from the target's HTTP service.
  List and detail pages display the resolved labels.

## Validation

`EntityParser` reads `.yaml`, `.yml`, and `.json` files through the safe filesystem service. Use `parseFile()` to validate one descriptor, or `parseDirectory()` / `parseFiles()` to validate a set, reject duplicate entities and unresolved relation targets, and receive normalized models.

```ts
import { EntityParser } from 'cleanstack-generator/entity-parser';

const parser = new EntityParser({ rootDir: process.cwd() });
const entities = await parser.parseDirectory('entities');
```

Each returned `EntityModel` has normalized `className`, `variableName`, `pluralName`, `pluralClassName`, `pluralVariableName`, `routeName`, and `tableName` values. Its field models include the Java and TypeScript types, snake-case column names, and rendered validation annotation names. Relations include the resolved target entity's names and table name, collection and owning-side metadata, generated id/label property names, and the join column or join table names.

For example, `Product` defaults to the `products` table and a `products` route. A `Product.category` relation targeting `Category` carries the target's normalized class and table names. An explicit `tableName` takes precedence over the generated plural snake-case name.
