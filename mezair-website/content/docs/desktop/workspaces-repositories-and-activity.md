---
title: Workspaces, repositories and activity
navTitle: Workspaces and repositories
description: Set up workspaces, connect and index repositories, follow running work, keep notes and generate onboarding files.
product: Mezair Desktop
section: Guides
journey: build
order: 40
---

# Workspaces, repositories and activity

A workspace is the main container in Mezair Desktop. It groups repositories, connector choices, chat threads, activity, notes and the evidence you collect as you work. Check which workspace is active before starting anything that can change files or other systems.

## Create and manage workspaces

The first launch creates a workspace for you. After that you can:

- create, rename and delete workspaces
- add or remove repositories
- open a workspace in a second Mezair window
- export its repositories as a VS Code workspace
- set work item, documentation and launch preferences for each workspace

Deleting a workspace removes what Mezair stores about it. It never deletes your repository folders.

## Connect repositories

The Workspace view can scan a folder for Git repositories. With the GitHub or Azure DevOps connector set up, it can also list remote repositories and clone them.

For each repository, Mezair keeps its path, branch state, indexing status, summary and map. You can open it in the built-in editor or in VS Code.

## Indexing and repository maps

Indexing reads the working tree and saves a summary that chat and the repository view can use. You can watch progress, force a retry if a run fails or stalls, and the latest summary is kept in the local database.

A repository map records modules and how they connect. Refresh it by hand or on the repository's schedule. The repository twin combines the map with current Git status and recent agent runs, so you can see where changes are piling up.

Treat summaries and maps as a way to find your way around. Open the source before relying on a generated description for a change or a review finding.

## Inbox and activity across workspaces

The Inbox splits activity into two groups:

- **Needs you**: approvals, questions, failures and finished work ready to review.
- **In progress**: agent work, automations, indexing, queued work and local processes that are still running.

Selecting an item takes you to where it lives. The activity centre and desktop notifications work the same way, and open the right workspace and thread when they know it.

Switching workspaces doesn't stop a running chat or terminal, and terminal output is still there when you come back, as long as the app stays open. Quitting the app ends terminal processes and anything else that depends on it.

## Workspace notes

Workspace Notes is a small queue for follow-ups you don't want to lose when a conversation ends. Add a note in the app or from a companion device, then later mark it handled or dismiss it.

Notes belong to a workspace. They're deliberately lighter than work items; use a proper ticket when ownership, priority or reporting matters.

## Repository onboarding

The Onboarding view looks at a repository and can:

- detect its languages, package managers, setup files and environment
- draft an `AGENTS.md`
- draft a devcontainer
- show you an existing onboarding file before replacing it
- write the file you approve, or write and commit it with your message
- run supported dependency installs and stream the output

The drafts are based on what's in the repository. Check the commands, ports, secrets handling and platform assumptions before you write them. Mezair can't know which of your team's local habits are actually rules.

## Open links and extra windows

Mezair can receive a link that opens specific work, and routes it through the **Open in Mezair** view. Notifications use the same mechanism to take you to the exact thread rather than just bringing the app forward.

Tool views can open in their own window, tied to the active workspace. That's useful for a browser preview, diagnostics or reference material while chat stays visible in the main window.
