# Anvil

## Project Structure & Module Organization

Anvil is an Electron desktop app for repo-aware developer workflows. The root package contains the Electron runtime in `src/`: `src/main/` owns privileged Node/Electron work such as SQLite access, repo scanning, Git operations, LLM calls, PTY lifecycle, automation, mobile companion support, and external integrations. `src/preload/` exposes the typed `window.anvil` bridge plus the small `window.brand` bridge. `src/shared/` holds IPC contracts, app identity, branding, and shared types.

The renderer lives in `src/renderer/` as a React/Tailwind SPA. Feature UI is grouped under `src/renderer/components/` (`chat`, `repos`, `workitems`, `automations`, `adrs`, `diagrams`, `security`, `terminal`, `editor`, `diagnostics`, and related views), with shared state in `contexts/`, hooks in `hooks/`, pure helpers in `utils/`, and global styling in `styles/global.css`.

SQLite schema, current schema version, and incremental migrations are all in `src/main/db/schema.ts`; database startup and migration execution are in `src/main/db/database.ts`. Prompt assets live in `prompts/`. Build and release helpers live in `scripts/`. App icons and Anvil artwork live in `resources/`. `mobile/` is a pnpm workspace package for the Expo companion app. `video/` is a separate Remotion project.

## Build, Test, and Development Commands

- `pnpm install` installs root/workspace dependencies and triggers the native `electron-rebuild` postinstall for `better-sqlite3` and `node-pty`.
- `pnpm dev` starts the Electron app in development mode through `electron-vite`.
- `pnpm build` builds main, preload, and renderer bundles into `out/`.
- `pnpm preview` previews the production renderer build.
- `pnpm test` runs the Vitest suite once.
- `pnpm test:watch` runs Vitest in watch mode.
- `pnpm lint` runs ESLint against `src/`.
- `pnpm format` formats TypeScript, TSX, CSS, and JSON files in `src/`.
- `pnpm run dist:mac:arm64:anvil` builds unsigned/internal Anvil macOS arm64 artifacts.
- `pnpm run dist:mac:arm64:anvil:notarized` builds, signs, notarizes, and validates Anvil macOS arm64 artifacts when Apple signing/notary secrets are configured.
- `pnpm --dir mobile start` starts the Expo companion app; use `pnpm --dir mobile ios`, `pnpm --dir mobile android`, `pnpm --dir mobile typecheck`, and `pnpm --dir mobile lint` for mobile-specific work.
- `cd video && npm install` installs the standalone Remotion project, then `npm run studio`, `npm run render`, or `npm run render:splash` runs the video workflows.

## Coding Style & Naming Conventions

- TypeScript is the default everywhere. Keep types explicit across process boundaries and avoid `any` unless the boundary is genuinely unknown.
- Follow `.prettierrc`: semicolons, single quotes, trailing commas, `printWidth: 100`, `tabWidth: 2`.
- Keep business logic in `src/main/services/`; IPC files in `src/main/ipc/*.ipc.ts` should validate, delegate, and translate results.
- When a renderer feature needs privileged access, extend the stack end to end: `src/shared/ipc-api.d.ts`, `src/main/ipc/*.ipc.ts`, `src/preload/index.ts`, then the renderer caller.
- Renderer components are feature-grouped and generally use PascalCase filenames. Preserve local naming patterns such as `*View.tsx` for top-level screens and `*Card.tsx`, `*Panel.tsx`, or `*Overlay.tsx` for focused UI pieces.
- Tailwind utility classes are the default styling path. Extend `src/renderer/styles/global.css` or existing tokens only when utilities are not enough.
- Keep app identity flowing through `src/shared/branding.ts`, `scripts/dist.mjs`, and `electron-builder.yml` rather than scattering product metadata through UI code.

## Testing Guidelines

- Vitest is the active root test runner. Service and persistence coverage lives mainly under `src/main/services/__tests__/`.
- Renderer coverage exists under `src/renderer/components/**/__tests__/` and `src/renderer/utils/__tests__/`.
- Add focused tests for parsing, persistence, workflow state, branch logic, IPC-adjacent service behavior, and shared renderer utilities.
- For database changes, update `SCHEMA_VERSION`, add the migration SQL to `MIGRATIONS` in `src/main/db/schema.ts`, and test the affected service or migration behavior where practical.
- There is no established full end-to-end UI harness in this repo. Do not invent one for a narrow change unless the task actually needs it.

## Commit & Pull Request Guidelines

- Use Conventional Commits such as `feat(terminal): ...`, `fix(codereview): ...`, `docs: ...`, and `chore(release): ...`.
- Keep scopes meaningful and tied to the feature area.
- Prefer small, single-purpose changes. Run the narrowest useful checks first, then broaden to `pnpm test`, `pnpm lint`, or `pnpm build` when the blast radius justifies it.
- Do not rewrite or delete existing schema migrations; add a new target-version migration in `MIGRATIONS`.

## Architecture Notes

- App startup begins in `src/main/index.ts`, which parses the brand, initializes SQLite, registers IPC modules, starts background integrations, and creates the BrowserWindow.
- `src/renderer/App.tsx` wires role gating, connector setup, workspace selection, launch intents, and top-level routes.
- Workspace state is central. `src/renderer/contexts/WorkspaceContext.tsx` and the matching workspace IPC/service layer coordinate active repos and per-workspace preferences.
- The preload bridge in `src/preload/index.ts` is the renderer's only route to privileged APIs. If a capability is not exposed there, the renderer should not reach for Node APIs directly.
- Repo onboarding, chat, code review, security, documentation, BA sessions, diagrams, ADRs, automations, launch intents, diagnostics, mobile companion, and terminals all follow the same broad path: renderer view -> preload API -> IPC handler -> service/persistence layer.

## Repo-Specific Gotchas

- pnpm is the root workflow. `pnpm-lock.yaml` and `pnpm-workspace.yaml` are the dependency source of truth; the workspace currently includes `mobile/` and uses `nodeLinker: hoisted` for Electron/native-module sanity. Do not refresh `package-lock.json` as part of routine root changes unless the task explicitly asks for npm compatibility. One lockfile war per week is enough.
- Native dependencies (`better-sqlite3`, `node-pty`) make installs and rebuilds platform-sensitive. If native behavior looks strange after dependency or Node changes, rerun `pnpm install` before blaming the app.
- The macOS notarized release path requires a Developer ID Application certificate and Apple notary credentials. The unsigned/internal release path is not the same thing, even if Gatekeeper is feeling generous that day.
- `mobile/` is an Expo Router companion app in the pnpm workspace. Keep its Expo/React Native dependencies and commands scoped to `mobile/`.
- `video/` is intentionally separate from the Electron app and still has its own `package-lock.json`. Do not mix Remotion dependencies into the root package unless the task explicitly spans both.

## Skills

- `.agents/skills/build-and-test/SKILL.md` explains the working dev/test/lint loop for the Electron app and companion projects.
- `.agents/skills/architecture-overview/SKILL.md` maps process boundaries, data flow, and feature placement.
- `.agents/skills/add-feature/SKILL.md` captures the standard workflow for adding a feature across shared types, IPC, preload, services, persistence, and UI.
- `.agents/skills/add-view/SKILL.md` focuses on adding a new top-level renderer screen and wiring it into routing and navigation.
