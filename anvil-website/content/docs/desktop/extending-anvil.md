---
title: Extending Anvil Desktop
navTitle: Extend the app
description: Add new app capabilities without bypassing the Electron service boundaries.
product: Anvil Desktop
section: Engineering
journey: build
order: 130
---

# Extending Anvil Desktop

New features should follow the app's local-first Electron architecture.

## Implementation path

1. Define or extend domain objects in `src/shared/types.ts`.
2. Add the renderer-facing API shape in `src/shared/ipc-api.d.ts`.
3. Implement orchestration and side effects in `src/main/services/<feature>.service.ts`.
4. Add a thin IPC module in `src/main/ipc/<feature>.ipc.ts`.
5. Register IPC handlers from `src/main/index.ts`.
6. Expose methods on `window.anvil` in `src/preload/index.ts`.
7. Build renderer UI under `src/renderer/components/<feature>/`.
8. Wire top-level routes in `src/renderer/App.tsx` and sidebar entries in `src/renderer/components/layout/Sidebar.tsx`.
9. If persistence is needed, add a new migration version in `src/main/db/schema.ts`. Do not rewrite old migrations in place.
10. Add focused tests around services, parsing, persistence, IPC-adjacent behaviour, or renderer utilities based on risk.

## Boundary rules

The main process owns side effects: filesystem access, Git, SQLite, connector calls, shell commands, browser automation, PTYs, and LLM-facing work.

IPC handlers should validate input, call services, and translate results. Business logic in IPC files ages about as well as milk on a radiator.

Renderer code should respect workspace state, feature availability, and role-gated navigation instead of inventing a parallel universe.
