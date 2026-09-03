---
title: Workspaces, repositories, and activity
navTitle: Workspaces and repositories
description: Create workspaces, connect and index repositories, follow active work, capture notes, and generate onboarding artifacts.
product: Anvil Desktop
section: Core workspace
journey: build
order: 109
---

# Workspaces, repositories, and activity

The workspace is Anvil Desktop's main scope boundary. It groups repositories, connector choices, chat threads, activity, notes, and delivery evidence. Check the active workspace before starting work that can change files or external systems.

## Create and manage workspaces

The first launch flow creates a workspace before opening the main shell. After that you can:

- create, rename, and delete workspaces
- add or remove connected repositories
- open a workspace in another Anvil window
- export its repositories as a VS Code workspace
- store workspace-specific work item, documentation, and launch preferences

Deleting a workspace removes its Anvil-managed workspace state. It does not delete the repository directories on disk.

## Connect repositories

The Workspace view can scan a directory for local Git repositories. It can also list and clone remote repositories from GitHub or Azure DevOps when the matching connector is configured.

Each connected repository keeps its local path, branch state, indexing status, summary, and repository map state. Anvil can open it in the embedded editor or VS Code.

## Indexing and repository maps

Indexing reads the working tree and stores repository summaries for chat and the repository detail view. The UI reports scan and indexing progress, supports a forced retry after a failed or stuck run, and keeps the latest summary in SQLite.

Repository maps record modules and relationships as a graph. Map refresh can be manual or follow the repository's configured refresh policy. The repository twin combines that map with current Git status and recent agent runs so you can see where work and change are concentrated.

Treat summaries and maps as navigation aids. Open the source before relying on a generated description for a code change or review finding.

## Inbox and cross-workspace activity

The Inbox divides activity into two groups:

- **Needs you** contains approvals, questions, failures, and completed work ready for review.
- **In progress** contains agent work, automations, indexing, queued work, and local processes that are still running.

Selecting an item opens its owning route. The activity centre and desktop notifications use the same model, including the originating workspace and thread when that context exists.

Switching workspaces does not cancel an active chat or terminal. Terminal output can reattach while the desktop process stays open. A full app quit ends terminal processes and any work that depends on the local desktop runtime.

## Workspace notes

Workspace Notes is a small review queue for follow-ups that should survive the current conversation. Create a note in the desktop view or through a supported companion surface. Later, either accept it as handled or dismiss it.

Notes are workspace-scoped. They are deliberately lighter than work items and should not replace a tracked ticket when ownership, priority, or delivery reporting matters.

## Repository onboarding

The Onboarding view inspects a connected repository and can:

- detect languages, package managers, setup files, and environment state
- generate an `AGENTS.md` draft
- generate a devcontainer draft
- read an existing onboarding artifact before replacement
- write the approved artifact or write and commit it with an explicit message
- run supported dependency installation steps while streaming output

Generated files are drafts based on repository evidence. Review commands, ports, secrets handling, and platform assumptions before writing them. The app does not know which accidental local convention your team has promoted to sacred law.

## Open intents and extra windows

Anvil can receive a launch intent and route it through the Open in Anvil view. Notifications use the same principle to focus exact work instead of merely opening the app.

Tool views can open in separate windows tied to the active workspace. Use that for a browser preview, diagnostics, or another reference view while keeping Chat visible in the main window.
