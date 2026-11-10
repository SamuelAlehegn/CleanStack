# Extensions

CleanStack has a deliberately small extension system. Extensions let the
community add new field types or new frontend frameworks without changing the
core: an extension only registers names, and the generator joins those names
with the lookup tables it already consults. The core never imports extension
code.

## What an extension can add today

| Capability         | Registered with                           | Effect                                                                                                                            |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Field type         | `registry.registerFieldType(...)`         | Usable in entity descriptors (`type: Money`), inline `--field name:Money`, and validated like built-in types                      |
| Frontend framework | `registry.registerFrontendFramework(...)` | Announces a framework for future `--frontend` support; pair it with a template pack through the ordinary template override system |

Both registration points are additive. Extensions cannot replace built-in
field types (`String`, `BigDecimal`, …) or the built-in `angular` framework;
the registry rejects duplicates with a clear error.

## The contract

An extension is a module whose default export (or any top-level export) is an
object with:

- `name` — shown by `cleanstack extensions list`
- `register(registry)` — called once when the extension is loaded, before any
  descriptor is parsed

```ts
// .cleanstack/extensions/money.ts
import type { CleanStackExtension } from 'cleanstack-generator/extensions';

const moneyExtension: CleanStackExtension = {
  name: 'money',
  register(registry) {
    registry.registerFieldType({
      name: 'Money',
      javaType: 'BigDecimal',
      javaImports: ['java.math.BigDecimal', 'java.util.Currency'],
      typescriptType: 'string',
      kind: 'numeric',
      sqlType: { postgresql: 'DECIMAL(19, 2)', mysql: 'DECIMAL(19, 2)', h2: 'DECIMAL(19, 2)' },
    });
  },
};

export default moneyExtension;
```

TypeScript types for authoring extensions are exported from the package root:

```ts
import type { CleanStackExtension } from 'cleanstack-generator/extensions';
```

or, from the installed package, `cleanstack-generator/extensions`.

## Field type definition

| Property            | Required | Meaning                                                                                                                                                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`              | yes      | Name used in descriptors, exactly as it is spelled there                                                                                                                                               |
| `javaType`          | no       | Java type emitted in entities and DTOs (defaults to the type name)                                                                                                                                     |
| `javaImports`       | no       | Fully qualified Java types imported when a field uses this type                                                                                                                                        |
| `typescriptType`    | no       | TypeScript type emitted in frontend models (default by `kind`)                                                                                                                                         |
| `typescriptDefault` | no       | Literal used as the initial form value (default by `typescriptType`)                                                                                                                                   |
| `kind`              | no       | `string`, `numeric`, `boolean`, or `other` (default). Decides which descriptor options validate: `string` allows `minLength`/`maxLength`/`pattern`, `numeric` allows `min`/`max`                       |
| `sqlType`           | no       | A string (`'DECIMAL(19, 2)'`), a record per database, or a function `(field, database) => string` for field-dependent types such as `VARCHAR(120)` when `maxLength` is set. Defaults to `VARCHAR(255)` |

Validation annotations come for free: a field declared with `required`,
`pattern`, `minLength`, and so on receives the same Jakarta Validation
annotations as built-in types.

## Frontend framework definition

| Property       | Required | Meaning                                                    |
| -------------- | -------- | ---------------------------------------------------------- |
| `name`         | yes      | Lower-case identifier, for example `react`                 |
| `label`        | no       | Human-readable label shown by `cleanstack extensions list` |
| `templateRoot` | no       | Built-in template root the framework renders from          |

Registering a framework announces it to the generator. CleanStack ships one
framework built-in (`angular`); new frameworks join by registering here and
providing their templates through the template override system
(see [TEMPLATES.md](./TEMPLATES.md)).

## Loading extensions

Extensions are discovered from three places, in order:

1. **Configuration file** — the `extensions` list in `cleanstack.config.ts` /
   `.cleanstackrc*`. Entries are npm package names or file paths:

   ```yaml
   # .cleanstackrc.yml
   extensions:
     - cleanstack-ext-money
     - ./ops/fields.cjs
   ```

2. **Discovery directory** — every `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, or
   `.cts` file in `.cleanstack/extensions/` is loaded. The directory is
   searched upward from the working directory and from the generated project
   root, so both the generator repo and a generated project can carry
   extensions.

3. **Callers** — embedding code can pass extra specifiers to `loadExtensions`.

Loading happens once per command, before any entity descriptor is parsed, so
descriptors and the configuration file itself may use extension field types.

## Inspecting what is loaded

```
cleanstack extensions list
```

prints every extension with its source and the field types and frontend
frameworks it registered. `--verbose` also logs each extension as commands
load it.

## Errors

Extension problems are reported with the file and a suggestion:

- a module that does not export a compatible `{ name, register }` object
- a registration of a duplicate or built-in name
- an extension that throws while registering

Fix the extension and run the command again; nothing is generated when
loading fails.

## Stability expectations

The contract above is intentionally tiny. Two registration points cover the
extension points the generator currently defines; more may be added later
(generators, CLI steps) following the same shape. Extensions that only use
`registerFieldType` and `registerFrontendFramework` are safe across minor
releases.
