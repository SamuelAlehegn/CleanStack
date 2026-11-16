# Multi-Version Support Plan

This document tracks the final phase of `CleanStack.md` — **Prompts 55–65, Multi-Version
Support** — for the `0.2.0` cycle. Every earlier phase (foundation, skeleton, entities,
protected regions, template overrides, CLI, OpenAPI, Studio, testing, docs, launch
preparation) is already implemented on `main`.

The goal is to let one generator emit projects for more than one Java / Spring Boot /
Angular combination, while keeping the default output identical to today's.

## Status

| Item             | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Integration      | `develop` (created from `main` at `0.1.1`)                                        |
| Target release   | `0.2.0` (minor)                                                                   |
| Shipped baseline | Java 21 · Spring Boot 4.1.2 · Angular 22.2                                        |
| Release gate     | Nothing publishes until `develop → main` and the changesets release PR are merged |

## Branch workflow

```text
main        ← released code only; pushes run the release workflow
└── develop ← integration branch for 0.2.0; no release workflow
     ├── docs/version-support-design
     ├── feat/version-config
     ├── feat/version-metadata
     ├── feat/version-cli
     ├── feat/versioned-templates
     ├── feat/spring-boot-versions
     ├── feat/angular-versions
     ├── feat/java-versions
     ├── feat/version-aware-entities
     ├── test/version-matrix
     ├── docs/version-support
     └── feat/version-upgrade-helper   (bonus, may ship later)
```

Rules:

- Create every slice branch from `develop`; open its PR against `develop`.
- A slice merges as soon as it is green — do not batch slices at the end.
- CI (`.github/workflows/ci.yml`) validates PRs targeting both `main` and `develop`.
- `release.yml` only listens to `main`, so working on `develop` never publishes.
- After any hotfix on `main`, merge `main` into `develop` (`git merge main`, never rebase
  a shared branch).
- A promotion PR (`develop → main`) triggers the normal changesets flow: version PR,
  then publish when that PR is merged. Tag the release `v0.2.0`.
- Delete `develop` after the release, or recreate it for the next milestone. Do not let
  it become a permanent second trunk.

## Proposed support matrix

> Finalize this in slice 1. The ranges in `CleanStack.md` predate the current templates
> (Spring Boot 4.1.2 / Angular 22.2), so they need updating before any code is written.

| Runtime     | Proposed support    | Default | Notes                                                       |
| ----------- | ------------------- | ------- | ----------------------------------------------------------- |
| Java        | 21, 25              | 21      | 17 is only relevant for older Spring Boot lines             |
| Spring Boot | 3.5.x, 4.0.x, 4.1.x | 4.1.x   | Older lines are migration targets, not the recommended path |
| Angular     | 20, 21, 22          | 22      | Control-flow and signal differences drive the template work |

Compatibility is validated as a matrix, not as three independent lists: not every Java
version can run every Spring Boot line, and the generator must reject unsupported
combinations with a clear message.

## Work breakdown

Each slice is a short-lived branch off `develop`, merged when its checklist and the full
CI matrix are green.

### [ ] 1. Version support design — `docs/version-support-design`

Prompts: 55 · Depends on: nothing

- [ ] Record the supported ranges and compatibility matrix in `docs/VERSIONS.md`.
- [ ] Decide the template strategy (recommended: hybrid — shared templates, Handlebars
      conditionals for small differences, version folders/partials only where needed).
- [ ] Define `latest` / `lts` semantics. Recommendation: resolve from the bundled matrix,
      with no network access during generation.
- [ ] Document how a future contributor extends the matrix and adds a version-specific
      partial.
- [ ] Confirm the decision is reflected in `docs/ARCHITECTURE.md` and `docs/TEMPLATES.md`.

### [ ] 2. Version config and validation — `feat/version-config`

Prompt: 56 · Depends on: 1

- [ ] Add `VersionConfig`, the compatibility matrix, and validation in
      `src/core/versions.ts`.
- [ ] Resolve explicit versions plus `latest` / `lts`.
- [ ] Default to the current baseline when no versions are supplied.
- [ ] Unit tests for valid combinations, rejected combinations, and keyword resolution,
      including the error messages.

### [ ] 3. Persist versions — `feat/version-metadata`

Prompt: 57 (storage half) · Depends on: 2

- [ ] Extend the project config schema in `src/core/config.ts` with an optional
      `versions` block.
- [ ] Round-trip versions through `.cleanstack/project.json`
      (`src/core/project-metadata.ts`).
- [ ] Keep existing configs valid: a missing `versions` block means the baseline.
- [ ] Tests for backward compatibility and metadata round-tripping.

### [ ] 4. Version-aware `new` — `feat/version-cli`

Prompt: 57 · Depends on: 3

- [ ] Add `--java`, `--spring-boot`, and `--angular` to `cleanstack new`
      (`src/cli/new.ts`, `src/cli/program.ts`).
- [ ] Add interactive prompts with clear defaults and descriptions.
- [ ] Print the chosen versions in the generation summary.
- [ ] Persist the selection so `entity`, `regenerate`, and `upgrade` can read it.
- [ ] Tests for flags, prompts, config precedence, and rejected combinations.
- [ ] Optional follow-up: expose the same selection in Studio
      (`src/web/contracts.ts`, `web/src/`), tracked separately.

### [ ] 5. Version-aware template resolution — `feat/versioned-templates`

Prompt: 58 · Depends on: 2

- [ ] Teach `TemplateEngine` and the manifest planner to resolve templates and partials
      by version.
- [ ] Expose the selected versions in the template context.
- [ ] Define the lookup order (version-specific → shared → built-in) and document it.
- [ ] Tests for resolution precedence, missing templates, and unchanged output when no
      version-specific template exists.

### [ ] 6. Spring Boot differences — `feat/spring-boot-versions`

Prompt: 59 · Depends on: 5

- [ ] Adapt the Maven and Gradle builds (BOM, plugin versions, Java release).
- [ ] Adapt security, actuator, springdoc, and JPA templates.
- [ ] Add version-specific partials only where a conditional would hurt readability.
- [ ] Golden tests for each supported Spring Boot line and a build check for the default.

### [ ] 7. Angular differences — `feat/angular-versions`

Prompt: 60 · Depends on: 5

- [ ] Adapt `package.json`, `angular.json`, and TypeScript configuration ranges.
- [ ] Adapt control flow, signals, routing, and test setup in skeleton and CRUD templates.
- [ ] Keep generated code idiomatic for the selected major version.
- [ ] Golden tests for each supported Angular line.

### [ ] 8. Java differences — `feat/java-versions`

Prompt: 61 · Depends on: 5

- [ ] Adapt compiler `release` / source-target settings in Maven and Gradle.
- [ ] Use newer language features only when the selected Java version supports them.
- [ ] Verify generated code compiles for 21 and 25 (or document the tested boundary).
- [ ] Golden tests for language-level differences.

### [ ] 9. Version-aware entity generation — `feat/version-aware-entities`

Prompt: 62 · Depends on: 4, 5, 6, 7, 8

- [ ] Read the stored versions when generating or regenerating entities.
- [ ] Apply the correct templates and partials for backend and frontend output.
- [ ] Prove protected regions survive regeneration across every supported version.
- [ ] Tests covering add-entity and regenerate flows on at least two version combinations.

### [ ] 10. Version matrix tests — `test/version-matrix`

Prompt: 63 · Depends on: 6, 7, 8, 9

- [ ] Unit tests for the matrix and validation logic (extends slice 2).
- [ ] Golden-file tests for at least the default combination and one newer/older one.
- [ ] A helper that generates a project per matrix row and asserts key files.
- [ ] Keep the expensive full-build/e2e run on the default combination only.

### [ ] 11. Version documentation — `docs/version-support`

Prompt: 64 · Depends on: 10

- [ ] Write `docs/VERSIONS.md`: matrix, selection guide, upgrade notes, maintenance guide.
- [ ] Add a short "Supported Versions" section to `README.md`.
- [ ] Update `docs/GUIDE.md`, `docs/TEMPLATES.md`, and command help.
- [ ] Verify every documented combination against the actual CLI.

### [ ] 12. Upgrade helper (bonus) — `feat/version-upgrade-helper`

Prompt: 65 · Depends on: 11 · May ship after `0.2.0`

- [ ] Add `cleanstack upgrade` with `--java`, `--spring-boot`, and `--angular`.
- [ ] Detect current versions, show a diff summary, support `--dry-run` first.
- [ ] Update config, regenerate safely, and warn about breaking changes.
- [ ] Tests for detection, refusal of unsupported targets, and protected-region safety.

## Cross-cutting requirements

- **Backward compatibility:** configs and metadata without `versions` must produce the
  same output as `0.1.1`.
- **Offline and deterministic:** no registry or network lookups; `latest` / `lts` resolve
  from the bundled matrix.
- **One changeset per user-visible slice.** Internal-only changes (CI, refactors) do not
  need one.
- **Docs travel with code.** A slice that changes behavior updates the docs that describe
  it in the same PR.
- **Tests match risk:** unit tests for logic, golden files for templates, full build/e2e
  only for the default combination.
- **Protected regions are non-negotiable.** Any template change must still regenerate
  safely and preserve hand-written code.

## Milestone release checklist

- [ ] All non-bonus slices merged into `develop`.
- [ ] `develop` is up to date with `main` and CI is green.
- [ ] Promotion PR `develop → main` reviewed as a release candidate.
- [ ] `npm run version` produces `0.2.0` with a complete changelog.
- [ ] Merge the changesets release PR → npm publish + GitHub release.
- [ ] Tag `v0.2.0`.
- [ ] Delete `develop` (or recreate it for the next milestone).

## Working a slice

```sh
git switch develop
git pull
git switch -c feat/<slice>

# implement, test, document
npm run build
npm test
npm run lint
npm run format:check
npx changeset              # user-visible changes only

git push -u origin feat/<slice>
# open the PR against develop
```

Keep the PR small enough to review in one sitting. If a slice grows, split it and adjust
the dependency chain above rather than letting the branch live longer.
