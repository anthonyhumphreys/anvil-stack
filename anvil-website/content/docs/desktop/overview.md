---
title: Anvil Desktop
navTitle: Overview
description: The local desktop workspace for repo-aware agent delivery work.
product: Anvil Desktop
section: Basics
order: 100
---

# Anvil Desktop

Anvil Desktop is the product in `anvil-app`: an Electron desktop app for local, repo-aware delivery work.

It uses chat as the primary workspace, with repositories, work items, Git state, code review, security review, dependency analysis, documentation, diagrams, terminals, browser checks, companion controls, and handover evidence kept close to each conversation.

The point is not to make a giant dashboard. The point is to keep delivery context close enough that a developer can inspect the work, verify the change, and hand over what happened without reconstructing the past from chat tabs and terminal scrollback.

## Who it is for

Use Anvil Desktop when a change needs more than a chat transcript:

- A coding agent needs repo context, branch state, and file references.
- A work item has acceptance criteria, risks, dependencies, or follow-up tasks.
- Review findings need to survive into a PR or handover.
- Security, dependency, CI, data, or compliance checks matter.
- A teammate needs to understand what changed, what passed, and what was not verified.

## Core surfaces

| Surface | Use it for |
| --- | --- |
| Repositories | Add local checkouts, inspect branch state, index modules, and ground sessions in the code that exists. |
| Chat | Run planning, implementation, review, investigation, documentation, and handover conversations with the configured primary agent. Thread history and workspace context stay attached. |
| Workflows | Build reusable graphs whose steps can use different active providers and models, including Codex and the local Cursor model catalog. |
| Work items | Bring Linear, Jira, Azure DevOps, acceptance criteria, BA findings, and follow-up tasks next to implementation work. |
| Editor and terminal | Open workspace-scoped editor and real PTY sessions. Running terminals reattach with buffered output when you switch away and return while Anvil remains open. |
| Git and code review | Inspect diffs, run review workflows, separate blockers from preferences, and prepare PR handover notes. |
| Security and dependencies | Run audits, inspect package risk, export findings, and keep unresolved issues visible. |
| Documentation and diagrams | Keep docs, ADRs, generated architecture notes, Draw.io context, and Figma-adjacent design work near the repo. |
| Governance | Track lifecycle gates, impact analysis, decisions, readiness checks, and handover packs. |
| Activity and notifications | See work continuing in other workspaces and open the exact conversation when Anvil needs approval or input, or when a run completes. |
| Companion controls | Use mobile, watch, Raycast, widget, and menu bar surfaces for small actions while the desktop app owns heavy review. |

## Chat-first workspace

Chat, repositories, and the editor are the primary navigation. Work items, automations, workflows, and code review stay close behind; specialised tools remain available under **More tools**. On narrower chat layouts the navigation compacts so the conversation keeps the useful width instead of donating it to a permanent menu.

Switching workspaces does not cancel active chat work. The activity centre keeps running and waiting conversations visible across workspaces. Desktop notifications for approval, requested input, and completion navigate back to the originating workspace and thread.

## Local-first shape

Anvil Desktop runs as a desktop app with privileged main-process services, a typed preload bridge, SQLite persistence, and a React renderer.

That boundary matters. Local developer tooling touches credentials, repositories, shell commands, work evidence, and connector state. Renderer code should not gain direct Node access just because a button wants to feel important.

## Read next

- [Installation and setup](/docs/desktop/installation)
- [Architecture](/docs/desktop/architecture)
- [Operating guide](/docs/desktop/operating-guide)
- [Agent workflows](/docs/desktop/agent-workflows)
- [Security and review](/docs/desktop/security-and-review)
- [Companion surfaces](/docs/desktop/companion-surfaces)
- [Extending Anvil Desktop](/docs/desktop/extending-anvil)
