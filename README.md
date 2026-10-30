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
