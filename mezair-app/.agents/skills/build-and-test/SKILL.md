---
name: build-and-test
description: Day-one setup, development, and verification workflow for the Mezair Electron app and its companion Remotion video project.
---

# Build And Test

Use this skill when you need the quickest reliable path to running, building, or verifying Mezair locally.

## Root App Commands

Prepare the local CLI packages from the monorepo root with `node .github/scripts/prepare-desktop-clis.mjs`, then run these from `mezair-app/`:

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm format
```

## What Each Command Does

- `pnpm install` installs Desktop/workspace dependencies and runs the `postinstall` rebuild for `better-sqlite3` and `node-pty`.
- `pnpm dev` starts the Electron main process plus the Vite-powered renderer through `electron-vite`.
- `pnpm build` outputs compiled artifacts into `out/main`, `out/preload`, and `out/renderer`.
- `pnpm test` runs the Vitest suite once.
- `pnpm lint` checks `src/` with ESLint.
- `pnpm format` rewrites supported source files under `src/` using the repo Prettier config.

## Fast Verification Strategy

Use this lightweight order after a change unless the task needs something deeper:

1. Run the narrowest relevant test if one already exists.
2. Run `pnpm test` if the change touches shared logic, persistence, parsing, or other broad code paths.
3. Run `pnpm lint` for renderer or TypeScript-heavy work.
4. Run `pnpm build` when changing bundling-sensitive code, preload contracts, or Electron startup paths.

## Test Locations

- `src/main/services/__tests__/` contains most service and persistence tests.
- `src/renderer/utils/__tests__/` contains pure renderer utility tests.

If you add logic to a service like `src/main/services/spike-guard.service.ts`, follow the existing nearby test pattern in `src/main/services/__tests__/spike-guard.service.test.ts`.

## Native Module Gotchas

- Installs can fail if the platform toolchain is missing because `better-sqlite3` and `node-pty` are native modules.
- If behavior looks broken only after dependency updates, re-running `pnpm install` is often the first repair step because it re-triggers the native rebuild.

## Mobile Companion

The `mobile/` directory is an Expo Router workspace package. Use it only when the task explicitly touches the companion app.

```bash
pnpm --dir mobile start
pnpm --dir mobile ios
pnpm --dir mobile android
pnpm --dir mobile typecheck
pnpm --dir mobile lint
```

## Video Project

The `video/` directory is a separate Remotion project. Use it only when the task explicitly touches the promo video.

```bash
cd video
npm install
npm run studio
npm run render
npm run render:gif
```

Relevant files:

- `video/src/Root.tsx`
- `video/src/MezairSizzle.tsx`
- `video/src/LogoSplash.tsx`

## When Not To Use This Skill

- If you need architectural orientation first, read `architecture-overview`.
- If you are adding a new cross-layer product feature, pair this with `add-feature`.

## Desktop CLI preparation

Before installing Desktop dependencies, build its locally bundled CLIs:

```sh
node ../.github/scripts/prepare-desktop-clis.mjs
```

Run `pnpm install` inside `mezair-app` after the helper succeeds. The projects
retain independent lockfiles. See the [identity cutover guide](../../../../docs/mezair-identity-cutover.md) for profile, protocol and release prerequisites.
