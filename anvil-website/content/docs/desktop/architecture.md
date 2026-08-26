---
title: Desktop architecture
navTitle: Architecture
description: How Anvil Desktop separates Electron main process services, preload IPC, shared contracts, renderer UI, SQLite, and companion packages.
product: Anvil Desktop
section: Engineering
journey: learn
order: 105
---

# Desktop architecture

Anvil Desktop follows the standard Electron split, with a deliberately narrow bridge between privileged services and renderer UI.

```txt
src/main
  owns filesystem, Git, SQLite, PTYs, LLM calls, connector calls, automation,
  mobile companion servers, browser work, and app lifecycle

src/preload
  exposes the typed window.anvil bridge through contextBridge

src/shared
  holds IPC API contracts, shared types, app identity, and branding

src/renderer
  renders the React and Tailwind app, calls window.anvil, and keeps UI state
```

## Main process

`src/main` owns side effects. If a feature touches a repository, shell process, database, external API, connector token, browser automation, local socket, or AI execution path, it belongs behind a main-process service.

Typical feature shape:

1. IPC handler validates renderer input.
2. Handler calls a service.
3. Service performs privileged work and persistence.
4. Handler translates the result into the shared IPC shape.
5. Renderer receives data through `window.anvil`.

Keep business logic in services. IPC files should not become tiny untested product managers.

## Preload bridge

`src/preload/index.ts` exposes `window.anvil`. The renderer should not import Node modules or reach around the bridge.

When adding a capability:

1. Define the renderer-facing method in `src/shared/ipc-api.d.ts`.
2. Register the IPC channel and contract in shared types where needed.
3. Implement the main-process IPC handler.
4. Expose the method in preload.
5. Call it from renderer code.

If a renderer component can bypass that path, the architecture has stopped being an architecture and started being a suggestion.

## Shared contracts

`src/shared` is where process-boundary types live. Keep anything crossing IPC explicit and serializable.

Good shared types:

- workspace and repository identifiers
- work item provider shapes
- chat session metadata
- review and security finding payloads
- diagnostics and status objects
- connector capability shapes

Poor shared types:

- service classes
- database handles
- Electron objects
- provider SDK clients
- anything with hidden process affinity

The Cloud execution path follows the same rule. `anvil-cloud-execution.service`
owns encrypted connection state, Git snapshot construction, authenticated HTTP,
and execution lifecycle calls. The typed IPC bridge exposes leases and events,
not bearer tokens or archive bytes.

## Renderer

The renderer is a React single-page app. Feature UI is grouped under `src/renderer/components` with supporting contexts, hooks, stores, utilities, and global styles.

Renderer code should focus on:

- navigation and role-aware surfaces
- workspace selection
- forms and review state
- status presentation
- invoking preload methods
- rendering results and evidence

It should not quietly run shell commands, write repository files, or manage secrets. Decorative privilege escalation is still privilege escalation.

## Persistence

SQLite schema, version, and migrations live in `src/main/db/schema.ts`. Database startup and migration execution live in `src/main/db/database.ts`.

Rules:

- Increment `SCHEMA_VERSION` for schema changes.
- Add a new migration entry to `MIGRATIONS`.
- Do not rewrite old migrations in place.
- Keep services responsible for persistence behavior.
- Add focused tests when schema changes affect workflows, side effects, or data integrity.

## Supporting packages

The repo has more than the desktop runtime:

| Package | Role |
| --- | --- |
| `mobile` | Expo companion app for approvals, quick workflows, prompts, interruptions, widgets, watch, and other companion surfaces. |
| `raycast/anvil` | Raycast command surface for workspace status, approvals, messages, workflows, and focusing the desktop app. |
| `video` | Remotion project for branded demo and marketing videos. |
| `prompts` | Reusable LLM prompt templates filled with repo context. |
| `resources` | App icons and macOS helper scripts. |
| `scripts` | Build, signing, notarization, release, and external control helpers. |

## Data flow example

```txt
Renderer review button
  -> window.anvil.codeReview.run(...)
  -> preload invoke
  -> src/main/ipc/code-review.ipc.ts
  -> src/main/services/code-review.service.ts
  -> Git, files, prompts, LLM provider, SQLite
  -> shared review result
  -> renderer review panel
```

That shape is the default. When a new feature needs privileged behavior, extend the same chain rather than inventing a side path.
