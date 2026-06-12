# Contributing to Anvil

Thanks for your interest in contributing to Anvil. This guide covers everything you need to get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Code Style](#code-style)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)
- [Architecture Overview](#architecture-overview)
- [Adding a New Feature](#adding-a-new-feature)
- [Testing](#testing)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

Be respectful, constructive, and collaborative. We're all here to build something useful.

## Getting Started

1. Fork the repository and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/devhub.git
   cd devhub
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

   This also runs `postinstall` to rebuild native modules (`better-sqlite3`, `node-pty`) for your platform.

3. Start the dev server:

   ```bash
   npm run dev
   ```

4. Verify everything works — the app should launch and the terminal, chat, and repo features should be functional.

See the [README](README.md#prerequisites) for platform-specific prerequisites (Xcode CLI tools, VS Build Tools, etc.).

## Development Workflow

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. Make your changes. The dev server supports hot reload for renderer changes; main-process changes require a restart.

3. Run checks before committing:

   ```bash
   npm run lint
   npm run format
   npm test
   ```

4. Commit using [conventional commits](#commit-conventions).

5. Push and open a pull request against `main`.

## Code Style

The project enforces style automatically — follow the existing patterns and let the tools handle formatting.

### TypeScript

- **Strict mode** is enabled. Do not use `any` unless absolutely necessary, and add a comment explaining why.
- Prefer explicit return types on exported functions.
- Use the shared types in `src/shared/types.ts` for cross-process data structures.

### Formatting (Prettier)

Prettier runs with the following settings (see `.prettierrc`):

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

Run `npm run format` to auto-format, or configure your editor to format on save.

### Linting (ESLint)

ESLint 10 with flat config. Run `npm run lint` to check for issues.

### CSS

Tailwind CSS 4 utility classes are preferred over custom CSS. Use the project's design tokens and colour palette rather than introducing new values.

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | When to use |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons — no logic change |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `test` | Adding or updating tests |
| `chore` | Build config, dependencies, tooling |
| `perf` | Performance improvement |

### Examples

```
feat(chat): add persona switching in conversation
fix(terminal): support powerline font rendering
docs: add CONTRIBUTING.md
refactor(services): extract shared LLM request logic
test(ba): add spike guard service tests
```

Keep the subject line under 72 characters. Use the body to explain _why_, not _what_ — the diff shows what changed.

## Pull Request Process

1. **One concern per PR.** A bug fix and a feature should be separate PRs.
2. **Write a clear description.** Explain what changed, why, and how to test it.
3. **Keep PRs small.** Smaller PRs get faster, better reviews.
4. **Ensure CI passes.** Lint, format, and tests must all be green.
5. **Respond to review feedback.** Push follow-up commits rather than force-pushing so reviewers can see incremental changes.
6. **Squash on merge.** The final commit on `main` should have a clean conventional commit message.

### PR Title Format

Use the same conventional commit format for PR titles:

```
feat(security): add OWASP category filtering to audit results
```

## Architecture Overview

Understanding the architecture helps you put changes in the right place.

### Process Model

Anvil is an Electron app with three layers:

| Layer | Location | Runs in | Responsibility |
|---|---|---|---|
| Main | `src/main/` | Node.js | File I/O, database, APIs, PTY, LLM calls |
| Preload | `src/preload/` | Isolated | Exposes `window.anvil` via `contextBridge` |
| Renderer | `src/renderer/` | Chromium | React SPA — UI only, no direct Node access |
| Shared | `src/shared/` | Both | TypeScript types and IPC API definition |

### IPC Pattern

All communication between renderer and main goes through typed IPC:

1. Define the API shape in `src/shared/ipc-api.d.ts`
2. Implement the handler in `src/main/ipc/<feature>.ipc.ts`
3. Register it in `src/main/index.ts`
4. Expose it in `src/preload/index.ts`
5. Call it from the renderer via `window.anvil.<namespace>.<method>()`

### Service Layer

Business logic lives in `src/main/services/`. Services are plain classes or modules — avoid putting logic directly in IPC handlers.

### Database

SQLite with better-sqlite3 in WAL mode. Schema is defined in `src/main/db/schema.ts` with numbered migrations in `src/main/db/migrations/`. Always create a new migration for schema changes; never modify an existing one.

## Adding a New Feature

A typical feature touches four layers. Here's the general pattern:

### 1. Define types

Add shared types to `src/shared/types.ts` and the IPC surface to `src/shared/ipc-api.d.ts`.

### 2. Implement the service

Create `src/main/services/<feature>.service.ts` with the core logic. If you need database tables, add a migration.

### 3. Wire up IPC

Create `src/main/ipc/<feature>.ipc.ts` — register handlers that delegate to your service. Register the IPC file in `src/main/index.ts`.

### 4. Expose in preload

Add methods to `src/preload/index.ts` under a new namespace on the `devhub` API object.

### 5. Build the UI

Create a component directory at `src/renderer/components/<feature>/`. Use existing components in `src/renderer/components/shared/` where possible.

### 6. Add a route

If the feature is a top-level view, add it to `src/renderer/App.tsx` and the sidebar in `src/renderer/components/layout/Sidebar.tsx`.

## Testing

We use [Vitest](https://vitest.dev/) for testing.

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

### Where to put tests

Place test files next to the code they test in a `__tests__/` directory:

```
src/main/services/__tests__/your-service.test.ts
src/renderer/utils/__tests__/your-util.test.ts
```

### What to test

- **Services** — unit test business logic, especially edge cases and error paths
- **Utilities** — test pure functions and parsers
- **IPC handlers** — test that they delegate correctly to services
- **React components** — test complex interaction logic; simple presentational components don't need tests

### What not to test

- Electron boilerplate and window management
- Third-party library internals
- Trivial getters/setters

## Reporting Issues

Open an issue on GitHub with:

1. **What you expected** to happen
2. **What actually happened** (include error messages, screenshots, or logs)
3. **Steps to reproduce**
4. **Environment** — OS, Node version (`node -v`), app version

For security vulnerabilities, please report privately rather than opening a public issue.
