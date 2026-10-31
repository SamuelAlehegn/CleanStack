# Entity descriptor format

An entity descriptor is one YAML document per entity. Store descriptors in `entities/` and use the entity name as the file name, for example `entities/product.yaml`.

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

`type` accepts `OneToOne`, `OneToMany`, `ManyToOne`, or `ManyToMany`. The `target` must match another entity name in the project, and `field` names the association on this entity. `required` defaults to `false`. Optional `mappedBy` and `inverse` properties describe the inverse side of a bidirectional relation.

The older `name` property is accepted as an alias for `field` for existing project configurations. New descriptors should use `field`.

## Validation

`EntityParser` reads `.yaml`, `.yml`, and `.json` files through the safe filesystem service. Use `parseFile()` to validate one descriptor, or `parseDirectory()` / `parseFiles()` to validate a set, reject duplicate entities and unresolved relation targets, and receive normalized models.

```ts
import { EntityParser } from 'cleanstack-generator/entity-parser';

const parser = new EntityParser({ rootDir: process.cwd() });
const entities = await parser.parseDirectory('entities');
```

Each returned `EntityModel` has normalized `className`, `variableName`, `pluralName`, `pluralClassName`, `pluralVariableName`, `routeName`, and `tableName` values. Its field models include the Java and TypeScript types, snake-case column names, and rendered validation annotation names. Relations include the resolved target entity's names and table name, plus collection and owning-side metadata.

For example, `Product` defaults to the `products` table and a `products` route. A `Product.category` relation targeting `Category` carries the target's normalized class and table names. An explicit `tableName` takes precedence over the generated plural snake-case name.
