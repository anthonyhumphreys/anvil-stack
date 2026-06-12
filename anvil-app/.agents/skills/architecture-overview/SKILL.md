---
name: architecture-overview
description: Process model, data flow, and feature placement guide for Anvil so agents can modify the right layer with minimal thrash.
---

# Architecture Overview

Anvil is a multi-process Electron app with a strict bridge between the UI and privileged code.

## Top-Level Shape

- `src/main/`: privileged Node/Electron runtime
- `src/preload/`: typed bridge exposed as `window.anvil` plus `window.brand`
- `src/renderer/`: React UI
- `src/shared/`: shared types and IPC API contract
- `src/main/db/`: schema, inline migrations, and database bootstrap
- `prompts/`: persona and prompt assets used by AI workflows
- `mobile/`: Expo Router companion app in the pnpm workspace
- `video/`: separate Remotion project

## Runtime Flow

Most product features follow this path:

1. The renderer triggers an action from a view such as `src/renderer/components/security/SecurityView.tsx`.
2. The view calls a typed method on `window.anvil` from `src/preload/index.ts`.
3. Preload forwards the request to an IPC channel implemented in `src/main/ipc/*.ipc.ts`.
4. The IPC handler delegates to business logic in `src/main/services/*.service.ts`.
5. Services persist data through `src/main/db/database.ts` and the schema in `src/main/db/schema.ts`, or call external tools/APIs as needed.
6. Results flow back up to the renderer through the same typed contract.

## Main Process Entry

`src/main/index.ts` is the startup hub. It:

- fixes environment/path issues for spawned tools
- initializes SQLite
- registers every IPC handler set
- starts background integrations such as Repobase MCP
- sets up the single BrowserWindow and deep-link handling
- cleans up sessions and terminals before quit

If a new privileged feature exists, it usually needs registration there.

## Important Main-Process Areas

- `src/main/ipc/`: one registration file per feature area
- `src/main/services/`: core business logic and integrations
- `src/main/services/repobase.service.ts` and `repobase-mcp.service.ts`: repository indexing and Repobase integration
- `src/main/services/foundry.service.ts` and `llm.service.ts`: LLM/provider behavior
- `src/main/services/workspace.service.ts`: workspace persistence and repo grouping
- `src/main/services/git.service.ts`: git operations shared across flows
- `src/main/services/terminal.service.ts`: PTY session lifecycle

## Renderer Organization

`src/renderer/App.tsx` owns:

- role-based feature gating
- connector onboarding flow
- workspace gating
- route registration

Feature screens live in `src/renderer/components/` by area:

- `repos/`
- `chat/`
- `onboard/`
- `workitems/`
- `ba/`
- `security/`
- `codereview/`
- `docs/`
- `diagrams/`
- `adrs/`
- `automations/`
- `editor/`
- `diagnostics/`
- `governance/`
- `terminal/`
- `workspace/`
- `layout/`

Shared state is mostly held in:

- `src/renderer/contexts/WorkspaceContext.tsx`
- `src/renderer/contexts/ChatContext.tsx`
- `src/renderer/contexts/BrandContext.tsx`
- `src/renderer/contexts/BaContext.tsx`

## Data Model Notes

The schema in `src/main/db/schema.ts` covers:

- connected repos and repo summaries
- chat sessions/messages
- settings and provider credentials
- mobile companion settings/devices
- onboarding state
- BA sessions/findings/messages
- code reviews and findings
- security audits and findings
- automations and run events
- ADRs, diagrams, lifecycle, and governance records
- workspaces and preferences
- governance boards/documents

Never silently rewrite historical migrations. Add a new target-version entry to `MIGRATIONS` in `src/main/db/schema.ts` and keep `SCHEMA_VERSION` aligned.

## Extension Points By Task

If you are:

- adding a privileged capability: start in `src/shared/ipc-api.d.ts`, then `src/main/ipc/`, `src/preload/index.ts`, and a new or updated service
- adding a new screen: start in `src/renderer/components/`, then wire `src/renderer/App.tsx` and likely `src/renderer/components/layout/Sidebar.tsx`
- changing workspace behavior: inspect `src/renderer/contexts/WorkspaceContext.tsx`, `src/main/ipc/workspace.ipc.ts`, and `src/main/services/workspace.service.ts`
- changing onboarding artifacts: inspect `src/main/services/onboard.service.ts`, `src/main/ipc/onboard.ipc.ts`, and `src/renderer/components/onboard/`
- changing repo indexing: inspect `src/main/ipc/repo.ipc.ts`, `src/main/services/indexer.service.ts`, `repobase.service.ts`, and repo summary persistence

## Practical Rule

Keep each layer honest:

- renderer handles presentation and user flow
- preload exposes only safe typed entry points
- IPC translates and delegates
- services own business logic
- persistence stays centralized around the database/service layer
