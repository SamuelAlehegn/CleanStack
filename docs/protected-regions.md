# Protected Regions

CleanStack regenerates files that users are expected to edit. Protected regions
are the contract that makes that safe: the generator owns the file around a
region, and the user owns everything between its markers. Running a generator
again must never silently delete hand-written code.

This document defines the marker format, the checksum metadata, and the
regeneration rules. The line-level primitives live in
[`src/core/protected-regions.ts`](../src/core/protected-regions.ts). The
file-level merge engine is the next implementation step.

## Goals

- Keep all metadata inside the generated file. No sidecar database or state
  directory is required.
- Work the same way in every language by changing only the comment syntax.
- Detect user edits with a checksum stored on the start marker.
- Make conflicts explicit instead of guessing.
- Stay small enough that a user can read a generated file and understand it.

Non-goals:

- Tamper-proofing or signing. Checksums detect accidental edits, not a
  determined user.
- Parsing the surrounding language. Markers are line-oriented.
- Nested regions. They are rejected by design.
- Replacing Git. CleanStack still expects generated projects to be versioned.

## Marker syntax

A region has a start marker and an end marker, each on its own line, wrapped in
the comment syntax of the file. The canonical tag is `cleanstack:user-code`.
`cleanstack:protected` is accepted as an alias for files generated before the
tag was standardized. Regeneration writes the canonical tag, so alias markers are
upgraded on the next successful write.

```text
<comment> <cleanstack:user-code id="REGION_ID" checksum="sha256:HEX"> <comment-end>
...user code...
<comment> </cleanstack:user-code> <comment-end>
```

- `id` is required and must be unique within the file.
- `checksum` is optional and is written by the generator, not by templates.
- The end marker has no attributes.
- Start and end must use the same tag.
- Attribute values use double quotes. Attributes are separated by whitespace.
- Unknown attributes, duplicate attributes, and extra text are errors. This
  catches typos such as `checkum=` early.

### Java

```java
    // <cleanstack:user-code id="service.product.create" checksum="sha256:...">
    public Product create(ProductRequest request) {
        return repository.save(mapper.toEntity(request));
    }
    // </cleanstack:user-code>
```

### TypeScript

```ts
  // <cleanstack:user-code id="form.product.actions" checksum="sha256:...">
  save(): void {
    this.service.create(this.form.getRawValue()).subscribe(() => this.router.navigate(['..']));
  }
  // </cleanstack:user-code>
```

### SQL

```sql
-- <cleanstack:user-code id="migration.product.seed" checksum="sha256:...">
INSERT INTO products (name, price) VALUES ('Sample', 9.99);
-- </cleanstack:user-code>
```

### HTML

```html
<!-- <cleanstack:user-code id="detail.product.actions" checksum="sha256:..."> -->
<button type="button" (click)="archive()">Archive</button>
<!-- </cleanstack:user-code> -->
```

### YAML

```yaml
# <cleanstack:user-code id="config.product.defaults" checksum="sha256:...">
# custom keys can live here
# </cleanstack:user-code>
```

### SCSS

```scss
/* <cleanstack:user-code id="theme.product.tokens" checksum="sha256:..."> */
$product-accent: #2563eb;
/* </cleanstack:user-code> */
```

## Supported languages

| Language   | Extensions                    | Marker comment |
| ---------- | ----------------------------- | -------------- |
| Java       | `.java`                       | `//`           |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | `//`           |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | `//`           |
| SQL        | `.sql`                        | `--`           |
| HTML       | `.html`, `.htm`               | `<!-- -->`     |
| XML        | `.xml`, `.xsd`                | `<!-- -->`     |
| CSS        | `.css`                        | `/* */`        |
| SCSS       | `.scss`, `.sass`, `.less`     | `/* */`        |
| YAML       | `.yml`, `.yaml`               | `#`            |
| Properties | `.properties`, `.env`         | `#`            |
| Markdown   | `.md`, `.markdown`            | `<!-- -->`     |

Only files with a supported extension can contain protected regions. If a
template emits a region in an unsupported file type, generation fails with the
file path instead of writing an unparseable file.

## Region ids

Ids identify a region across regenerations. They are part of the public shape of
a generated file, so treat them as stable API:

- Start with an ASCII letter.
- Contain ASCII letters, digits, and single `.`, `_`, or `-` separators.
- Be at most 120 characters.
- Be unique within a file.
- Never be reused for a different purpose. Renaming an id is a breaking change
  that looks like one removed region plus one new region.

Recommended shape: `<artifact>.<entity>.<purpose>`.

```text
service.product.create
controller.product.archive
form.product.actions
migration.product.seed
```

Kebab-case ids such as `service-product` remain valid for existing templates.
Camel-case segments such as `service-orderItem` are valid too.

## Checksums

The checksum detects whether a region body differs from the body CleanStack last
generated. It is stored on the start marker:

```text
checksum="sha256:9f2c0d4e..."
```

### Format

- Algorithm: SHA-256, lowercase hex, exactly 64 characters.
- Prefix: `sha256:`.
- An invalid checksum is a hard format error.
- A missing checksum is not an error. It means "base unknown"; see below.

### What is hashed

The checksum covers the region body only, not the markers, not the id, and not
the rest of the file. Before hashing:

1. `CRLF` and lone `CR` line endings become `LF`.
2. Exactly one trailing newline is removed.
3. Nothing else changes. Indentation, interior blank lines, and trailing
   whitespace on body lines are significant.

Consequences:

- Converting a file between LF and CRLF does not create a false user edit.
- Editing code outside a region never changes that region's checksum.
- Re-indenting a region body counts as a user edit. The engine preserves the
  body verbatim rather than trying to re-indent it.

### The checksum is a base, not a copy

This is the key design decision. `checksum` is the checksum of the **template
body CleanStack most recently generated**, not the checksum of the body
currently in the file. The two are equal until the user edits the region.

That single rule is enough to detect both user edits and template changes
without storing the previous generated body:

- `B` = checksum stored on the marker (the base).
- `U` = checksum of the body currently in the file.
- `T` = checksum of the body in the newly rendered template.

- `U = B` means the user has not edited the region.
- `T = B` means the template has not changed since the last generation.
- `U ≠ B` and `T ≠ B` means both sides changed: a conflict.

After a successful regeneration, the marker's checksum always becomes `T`,
because the newly rendered template body is the new base. This holds even when
the user's body was preserved: the next run then reports `U ≠ B`, `T = B` and
preserves the body again, exactly as intended.

### Missing checksum

A region without `checksum` has an unknown base. CleanStack treats it as
user-owned:

- Preserve the body verbatim.
- Report the region as unverified.
- Never assume the body matches the template.

This keeps hand-written markers and files generated before checksums existed
safe. The generator adds a checksum the next time it writes the file.

### Security note

A user can recompute the checksum after editing. That is fine. The checksum is
a convenience for detecting drift, not an access control mechanism.

## Regeneration rules

`ProtectedRegionManager` implements the following rules. It is pure: callers pass
the existing and newly generated content, and the manager returns the merged
content plus a decision log.

### Decision table

| Base `B` | User `U` | Template `T` | Result                                                                |
| -------- | -------- | ------------ | --------------------------------------------------------------------- |
| present  | `U = B`  | `T = B`      | Write template body (identical). Checksum stays `B`.                  |
| present  | `U = B`  | `T ≠ B`      | Template changed only: write new template body. Checksum becomes `T`. |
| present  | `U ≠ B`  | `T = B`      | User changed only: preserve user body. Checksum stays `B` (`= T`).    |
| present  | `U ≠ B`  | `T ≠ B`      | Conflict. Apply the selected merge strategy.                          |
| present  | `U = T`  | `T ≠ B`      | Converged: both sides made the same edit. Write `T`, no conflict.     |
| missing  | unknown  | any          | Preserve user body and report it as unverified.                       |
| any      | any      | region gone  | Orphaned region: conflict, never dropped silently.                    |
| absent   | n/a      | region added | Insert the new region with the template body and checksum `T`.        |

### Merge strategies

- `manual` (default): do not write the file. Report every conflicting region id
  and the reason. The user resolves the file and runs the command again.
- `keep-user`: keep the current body for conflicting regions and set the
  checksum to `T`. The user body wins, but future template changes are still
  detected.
- `keep-template`: replace the body with the new template body and set the
  checksum to `T`.
- `--force`: overwrite generated files completely, including protected regions.
  This is the explicit escape hatch and is never the default.

Strategies can be set on the manager, per merge, or per region id. Per-region
overrides win over the merge default, which wins over the manager default.

`--dry-run` reports the same decisions without writing anything.

### Orphaned and new regions

- A region in the existing file that no longer exists in the template is
  orphaned. Its body may contain user code, so it is never deleted silently. It
  is a conflict.
  - `manual` leaves the file untouched and reports the id.
  - `keep-user` appends the orphaned region to the end of the regenerated file
    and preserves its original checksum. Appending is safe for the file's bytes
    but may not compile in every language; review the reported region.
  - `keep-template` drops the orphaned region because the template explicitly no
    longer owns it.
- A region in the template that is absent from the existing file is inserted
  normally with the template body and its checksum.
- Region order follows the template. Matching is by id, not by position, so
  reordering regions is safe.

### Error and diagnostic codes

Marker and file-shape problems throw `ProtectedRegionFormatError` with one of
these codes. The engine never writes a partially merged file:

| Code                            | Meaning                                             |
| ------------------------------- | --------------------------------------------------- |
| `PROTECTED_REGION_MALFORMED`    | Marker cannot be parsed.                            |
| `PROTECTED_REGION_UNCLOSED`     | Start marker has no matching end marker.            |
| `PROTECTED_REGION_STRAY_END`    | End marker has no matching start marker.            |
| `PROTECTED_REGION_NESTED`       | A start marker appears inside another region.       |
| `PROTECTED_REGION_TAG_MISMATCH` | Start and end tags differ.                          |
| `PROTECTED_REGION_DUPLICATE_ID` | The same id appears more than once in one file.     |
| `PROTECTED_REGION_UNKNOWN_TYPE` | The file extension has no supported comment syntax. |

Merge outcomes are reported in the result instead of thrown:

| Code                          | Meaning                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `PROTECTED_REGION_CONFLICT`   | User and template both changed a region.                |
| `PROTECTED_REGION_ORPHANED`   | A user region no longer exists in the template.         |
| `PROTECTED_REGION_UNVERIFIED` | A region has no checksum; it is preserved and reported. |

### File handling

- Files are UTF-8.
- New files use LF. When rewriting an existing file, preserve its dominant line
  ending so a regeneration does not produce a whole-file diff.
- Preserve the existing trailing-newline convention.
- Write through the existing `FileSystemService` so dry-run, backups, and action
  logging keep working.
- Prefer writing to a temporary file and renaming it into place, so a failed
  merge never leaves a truncated source file.

## Using the manager

```ts
import { ProtectedRegionManager } from 'cleanstack-generator/protected-region-manager';

const manager = new ProtectedRegionManager({ strategy: 'manual' });

const parsed = manager.parse(existingSource, { filePath: 'ProductService.java' });
const result = manager.merge(existingSource, generatedSource, {
  filePath: 'ProductService.java',
  strategies: { 'service.product.archive': 'keep-user' },
});

if (result.writable) {
  await fileSystem.writeFile('ProductService.java', result.content, { overwrite: true });
}
```

`merge` returns:

- `content`: merged text, or the existing source unchanged when `writable` is
  false.
- `writable`: false when any conflict or orphan is left to `manual`.
- `decisions`: one entry per region with a status such as `unchanged`,
  `template-updated`, `user-preserved`, `converged`, `added`, `unverified`,
  `conflict-kept-user`, `conflict-kept-template`, `conflict-manual`,
  `orphaned-kept`, `orphaned-dropped`, or `orphaned-manual`.
- `conflicts`: both-modified and orphaned conflicts, including whether the
  selected strategy resolved them.
- `warnings`: unverified regions that were preserved but could not be checked.

Format problems throw `ProtectedRegionFormatError` with a `code` from the table
above. Invalid strategy values throw `ProtectedRegionMergeError`.

## Template authoring rules

Templates emit raw markers. They do not emit checksums; the generator computes
and writes those after rendering.

```text
    // <cleanstack:user-code id="service.{{entity.variableName}}.create">
    // </cleanstack:user-code>
```

Rules:

1. Put each marker on its own line, wrapped in the correct comment syntax.
2. Use stable, unique ids. Namespacing by artifact and entity avoids collisions.
3. Keep the default body empty, or a minimal compilable placeholder. A large
   default body creates avoidable conflicts.
4. Keep regions small and focused: a method body, a list of form actions, a seed
   block. Do not protect an entire class.
5. Do not nest regions.
6. Do not put imports inside a region. Imports are generated and sorted by the
   generator; a user cannot safely add one from inside a method-level region.
   Dedicated import regions are out of scope for the first version.
7. Do not rely on a region's position. The engine matches by id.
8. Do not emit a region into an unsupported file type.

## Worked example

Template body for a new service method:

```java
    // <cleanstack:user-code id="service.product.create">
    // </cleanstack:user-code>
```

First generation writes the checksum of the empty body:

```java
    // <cleanstack:user-code id="service.product.create" checksum="sha256:EMPTY">
    // </cleanstack:user-code>
```

The user adds code:

```java
    // <cleanstack:user-code id="service.product.create" checksum="sha256:EMPTY">
    public Product create(ProductRequest request) {
        Product product = mapper.toEntity(request);
        return repository.save(product);
    }
    // </cleanstack:user-code>
```

`U ≠ B`, so the region is user-modified. The next generation, with the same
template, preserves the body and leaves the checksum alone. If the template's
default body later changes, `T ≠ B` and the region becomes a conflict; the user
chooses `keep-user`, `keep-template`, or resolves it manually.

## Implementation status

The protected-region system is implemented:

- `src/core/protected-regions.ts` provides language and comment-syntax lookup,
  region id and checksum validation, marker rendering and parsing, and checksum
  computation and verification.
- `src/core/protected-region-manager.ts` provides file parsing, merge decisions,
  conflict detection, merge strategies, orphan handling, and line-ending
  preservation.
- `tests/protected-region-manager.test.js` covers parsing, every decision-table
  branch, strategies, orphans, checksum drift, and line endings.

Generators will adopt the manager next, together with `--force` and `--dry-run`.
