---
name: add-feature
description: Standard workflow for adding a new Anvil feature that spans shared contracts, IPC, preload, services, persistence, and renderer UI.
---

# Add Feature

Use this skill when the new behavior is more than a cosmetic UI tweak and crosses process boundaries.

## Default Workflow

1. Define or extend shared types in `src/shared/types.ts` if the feature introduces new domain objects.
2. Extend the public API in `src/shared/ipc-api.d.ts`.
3. Implement or update business logic in `src/main/services/`.
4. Add or update an IPC registration file in `src/main/ipc/`.
5. Register the IPC handlers from `src/main/index.ts` if this is a new IPC module.
6. Expose the method on `window.anvil` in `src/preload/index.ts`.
7. Call the new API from the relevant renderer view or context.
8. Add tests around the new logic where the repo already has strong patterns.

## File Placement Rules

- Put orchestration and side effects in `src/main/services/<feature>.service.ts`.
- Keep IPC files thin, for example `src/main/ipc/security.ipc.ts` and `src/main/ipc/workspace.ipc.ts`.
- Reuse `src/shared/types.ts` for cross-process entities instead of re-declaring view-local copies.
- If the feature needs a new top-level screen, add a `*View.tsx` component under the relevant feature folder in `src/renderer/components/`.

## Existing Examples To Follow

- Workspace flows:
  - `src/renderer/contexts/WorkspaceContext.tsx`
  - `src/main/ipc/workspace.ipc.ts`
  - `src/main/services/workspace.service.ts`
- Onboarding flows:
  - `src/main/services/onboard.service.ts`
  - `src/main/ipc/onboard.ipc.ts`
  - `src/renderer/components/onboard/`
- Terminal flows:
  - `src/main/services/terminal.service.ts`
  - `src/main/ipc/terminal.ipc.ts`
  - `src/renderer/components/terminal/`

## Database Changes

If the feature needs persistence:

1. Update `src/main/db/schema.ts`.
2. Add a new target-version entry to `MIGRATIONS` in `src/main/db/schema.ts`.
3. Update the persistence or service layer that reads/writes the table.
4. Add or update tests around the changed behavior.

Do not edit old migration SQL in place.

## UI Integration Checklist

- Add route wiring in `src/renderer/App.tsx` if the feature is screen-level.
- Add sidebar navigation in `src/renderer/components/layout/Sidebar.tsx` if the screen should be globally reachable.
- Consider workspace and role gating if the feature should only appear in some contexts.
- Reuse existing shared components under `src/renderer/components/shared/` or nearby feature folders before inventing new primitives.

## Verification

Choose the narrowest useful verification:

- service/util change: targeted Vitest coverage plus `pnpm test`
- preload / IPC / startup change: `pnpm test` and `pnpm build`
- renderer flow change: `pnpm lint`, plus manual dev verification in `pnpm dev`

## Anti-Patterns

- Don’t put business logic directly in TSX views.
- Don’t let the renderer call Electron or Node APIs directly.
- Don’t add duplicate ad hoc types when the data crosses process boundaries.
- Don’t bypass workspace or role models if the nearby feature area already uses them.
