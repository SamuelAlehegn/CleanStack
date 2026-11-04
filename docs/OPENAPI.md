# OpenAPI integration

CleanStack treats the Spring Boot OpenAPI document as the contract between the
backend and the Angular app. The backend publishes the contract with springdoc,
and `cleanstack openapi` generates a typed Angular client from it. Pass
`--contract-first` to generate Spring API interfaces from the same document as
well.

## Backend: springdoc

Generated Spring Boot projects include
`org.springdoc:springdoc-openapi-starter-webmvc-ui` 3.2.0, which supports Spring
Boot 4. While the application runs, it exposes:

| Endpoint            | Contents                   |
| ------------------- | -------------------------- |
| `/swagger-ui.html`  | Interactive Swagger UI     |
| `/v3/api-docs`      | OpenAPI 3 document as JSON |
| `/v3/api-docs.yaml` | OpenAPI 3 document as YAML |

`OpenApiConfig` supplies the API title, description, and version. When JWT or
Keycloak authentication is enabled, the security configuration permits the
documentation endpoints so the contract can be downloaded without a token.

The contract reflects controllers, request/response DTOs, validation
annotations, and HTTP status codes at runtime. No build-time export step is
required.

## Generating the Angular client

```sh
# While the backend is running
cleanstack openapi --input http://localhost:8080/v3/api-docs

# Or from a saved document
curl http://localhost:8080/v3/api-docs -o openapi/openapi.json
cleanstack openapi --input openapi/openapi.json
```

Without `--input`, CleanStack searches the workspace for:

```text
openapi/openapi.yaml        openapi/openapi.yml        openapi/openapi.json
openapi.yaml                openapi.yml                openapi.json
docs/openapi.yaml           docs/openapi.yml           docs/openapi.json
<backend>/src/main/resources/openapi.yaml
<backend>/src/main/resources/static/openapi.yaml
```

The default output is `src/app/api/generated` inside the Angular project. Pass
`--output libs/api` or another relative path to use a different directory. The
path must stay inside the Angular project.

The generator is `typescript-angular` by default. Change it with
`--generator`. Other options map to openapi-generator settings:

- `providedIn=root`
- `useSingleRequestParameter=true`
- `fileNaming=kebab-case`
- API and model tests and docs are disabled

The command uses `node_modules/.bin/openapi-generator-cli` when the generated
Angular app has installed its dev dependency. Otherwise it runs a pinned
version through `npx`. openapi-generator requires Java 11 or later.

## Contract-first mode

By default CleanStack generates the backend from entities and then publishes its
OpenAPI document. Contract-first reverses that direction: write the OpenAPI
document first, then generate both sides from it.

```sh
cleanstack openapi --contract-first --input openapi/openapi.yaml
```

The command runs two openapi-generator passes from the same validated document:

| Target  | Generator            | Default output                                         |
| ------- | -------------------- | ------------------------------------------------------ |
| Angular | `typescript-angular` | `<name>-ui/src/app/api/generated`                      |
| Spring  | `spring`             | `<name>-backend/src/main/java/<package>/api/generated` |

The Spring pass uses `interfaceOnly=true`, so it produces API interfaces and
request/response models without controller implementations. Interface names
come from OpenAPI tags; operations without a tag go into `DefaultApi`.

```text
com/example/demo/api/generated/
  api/
    ProductsApi.java       @RequestMapping operations for the products tag
    ApiUtil.java
    package-info.java
  model/
    Product.java
    package-info.java
  .cleanstack-openapi.json
```

Implement the generated interfaces with regular Spring controllers:

```java
package com.example.demo.controller;

import com.example.demo.api.generated.api.ProductsApi;
import com.example.demo.api.generated.model.Product;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProductsController implements ProductsApi {
    @Override
    public ResponseEntity<List<Product>> listProducts() {
        // call a service and map domain objects to generated models
    }
}
```

Do not repeat the class-level `@RequestMapping` on the implementation. The
interface already declares it, and Spring MVC inherits mappings from
implemented interfaces. Bean validation annotations from the contract are
generated as `jakarta.validation` constraints.

The Spring generator targets the generated Spring Boot 4 baseline:

- `useSpringBoot4=true` and `useJackson3=true`
- `useJspecify=true` for nullability annotations
- `useBeanValidation=true` and `useResponseEntity=true`
- `requestMappingMode=api_interface`
- `skipDefaultInterface=true` so implementations must provide every operation
- `openApiNullable=false` to avoid extra dependencies
- API/model tests and documentation are disabled
- generation timestamps are hidden so unchanged contracts produce identical files

Use `--backend-output` to choose another package directory under
`<name>-backend/src/main/java`. The directory path becomes the generated base
package, so it must contain valid Java identifiers. Use `--spring-generator` to
replace the `spring` generator. Both options require `--contract-first`.

## Safe regeneration

Each generated directory is owned by CleanStack and carries its own
`.cleanstack-openapi.json` manifest. Hand-written adapters belong outside them,
for example in `src/app/services` or a normal controller package.

```text
src/app/
  api/
    README.md
    generated/
      .cleanstack-openapi.json   <- Angular ownership manifest
      api/...
      model/...
  services/
    product.service.ts           <- hand-written adapter

<name>-backend/src/main/java/<package>/api/generated/
  .cleanstack-openapi.json       <- Spring ownership manifest
  api/...
  model/...
```

Regeneration follows these rules:

1. **Validate first.** The command downloads or reads the document, parses it,
   and verifies that it is OpenAPI 3 before invoking the generator.
2. **Generate in isolation.** openapi-generator writes to temporary
   directories. If either generation fails, the project is untouched. In
   contract-first mode both targets are planned before either is written.
3. **Require ownership.** A non-empty directory without
   `.cleanstack-openapi.json` is rejected. `--force` allows colliding files to
   be replaced, but still does not remove unknown files.
4. **Track every generated file.** The manifest stores each path and a SHA-256
   content hash, plus the spec source and hash.
5. **Replace only generated paths.** Files are created or updated. Stale files
   listed in the old manifest but missing from the new generation are deleted.
6. **Preserve unknown files.** Files added inside the generated directory are
   kept and reported as preserved.
7. **Warn before overwriting edits.** If a tracked file changed after the last
   generation, the command warns before replacing it. Keep customizations
   outside the generated directory.
8. **Support dry runs.** `--dry-run` performs generation in a temporary
   directory and reports created, updated, removed, and unchanged files without
   touching the project.

### Manifest format

```json
{
  "version": 1,
  "generatedBy": "cleanstack",
  "generator": "typescript-angular",
  "spec": {
    "source": "http://localhost:8080/v3/api-docs",
    "hash": "4f2a..."
  },
  "files": {
    "api/product.service.ts": "d91c...",
    "model/product.ts": "9b03..."
  }
}
```

The manifest is committed with the client. Deleting it makes the directory
unmanaged, so the next run requires `--force`.

## Relationship to entity generation

Entity templates generate hand-written Angular models and services plus
entity-oriented Spring controllers. The generated OpenAPI artifacts are a
separate, contract-derived layer:

- use entity templates for project-owned CRUD screens and custom fields,
- use contract-first mode when the OpenAPI document should drive both the
  Spring interfaces and the Angular client,
- use client-only mode when integrating with external services or an existing
  backend contract.

Entity DTOs and contract-first models can coexist, but contract-first should
target dedicated packages. CleanStack refuses to overwrite unmanaged files
unless `--force` is used.

## Troubleshooting

| Symptom                                   | Fix                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `No OpenAPI document was found`           | Start the backend and pass `--input http://localhost:8080/v3/api-docs`, or save the spec under `openapi/`. |
| `used Swagger 2`                          | Upgrade springdoc to 3.x so the backend publishes OpenAPI 3.                                               |
| `openapi-generator-cli failed`            | Check Java 11+ (`cleanstack doctor`), network access for npx, and the generator output with `--verbose`.   |
| `unmanaged non-empty directory`           | Choose an empty output, or use `--force` to allow colliding files to be replaced.                          |
| `Contract-first generation needs a ...`   | Use a project with both backend and frontend, or omit `--contract-first` for client-only generation.       |
| `must be a package directory under ...`   | Pass a `--backend-output` under `src/main/java` using valid Java package segments.                         |
| A custom file was kept but should be gone | CleanStack never deletes untracked files. Remove it manually or let the generator own it.                  |
| Generated file edits disappeared          | Do not edit `generated/`; put adapters in `src/app/services` and implementations in `controller`.          |
