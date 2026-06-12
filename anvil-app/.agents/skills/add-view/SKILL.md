---
name: add-view
description: Add a new top-level renderer screen to Anvil and wire it into routing, navigation, and the existing workspace-gated shell.
---

# Add View

Use this skill when you are creating a new screen or major route in the React renderer.

## Where Views Live

Top-level screens are usually `*View.tsx` files under `src/renderer/components/<feature>/`.

Examples:

- `src/renderer/components/repos/ReposView.tsx`
- `src/renderer/components/chat/ChatView.tsx`
- `src/renderer/components/security/SecurityView.tsx`
- `src/renderer/components/docs/DocsView.tsx`

## Wiring Steps

1. Create the new `*View.tsx` file inside the appropriate feature folder under `src/renderer/components/`.
2. Import it into `src/renderer/App.tsx`.
3. Add a `<Route />` in `src/renderer/App.tsx`.
4. If it should appear in the global nav, add a `NavItem` entry in `src/renderer/components/layout/Sidebar.tsx`.
5. If the feature is role-restricted, use the existing `guard(...)` pattern in `App.tsx`.
6. If the view depends on workspace selection, keep it inside the existing `WorkspaceGate`.

## App-Level Patterns To Preserve

- Routing is hash-based via `HashRouter`.
- Many screens are wrapped in `ErrorBoundary`.
- Workspace-aware routes usually render inside `WorkspaceGate`.
- Feature availability is controlled by `ROLE_FEATURES` from `src/shared/types`.

Use existing route definitions in `src/renderer/App.tsx` as the template instead of inventing a new routing pattern.

## When The View Needs Data

Choose the narrowest integration:

- renderer-only derived state: local component state or a feature-local hook
- shared renderer state: extend an existing context such as `WorkspaceContext`
- privileged or persisted data: add or extend a `window.anvil` API and follow the full cross-process workflow from `add-feature`

## Styling Guidance

- Prefer the existing Tailwind utility vocabulary used across `src/renderer/components/`.
- Reuse layout primitives from `src/renderer/components/layout/` and nearby feature folders.
- Keep the visual language aligned with the current app shell rather than introducing a disconnected page style.

## Good Reference Files

- `src/renderer/App.tsx`
- `src/renderer/components/layout/Shell.tsx`
- `src/renderer/components/layout/Sidebar.tsx`
- `src/renderer/contexts/WorkspaceContext.tsx`

## Verification

- Run `pnpm lint` after adding or wiring a screen.
- If the route touches process boundaries or typed APIs, also run `pnpm test` and, when relevant, `pnpm build`.
- Manually open the screen in `pnpm dev` to confirm route access, role gating, and workspace behavior.
