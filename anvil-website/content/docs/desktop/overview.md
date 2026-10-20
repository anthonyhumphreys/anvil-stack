---
title: Anvil Desktop
navTitle: Overview
description: A tour of the desktop app for running coding agents on your own repos.
product: Anvil Desktop
section: Start here
journey: learn
order: 10
---

# Anvil Desktop

Anvil Desktop is an Electron app for running coding agents on your own repos. It lives in the `anvil-app` folder of the repository.

The conversation is the centre of the app. Around it sit the things a coding job actually needs: your repositories and branches, work items, diffs and reviews, security and dependency checks, docs and diagrams, terminals, browser checks, and the notes you hand on when the work is done.

It isn't trying to be a giant dashboard. The aim is to keep enough context next to the work that you can check a change, verify it, and explain what happened, without digging through old chats and terminal scrollback.

## When it helps

Anvil Desktop earns its place when a change needs more than a chat window:

- The agent needs to know the repo, the branch and the files involved.
- The work item has acceptance criteria, risks, dependencies or follow-ups.
- Review findings need to make it into the pull request or the handover.
- Security, dependency, CI, data or compliance checks matter.
- Someone else needs to understand what changed, what passed and what wasn't checked.

## What's in the app

| Area | What it's for |
| --- | --- |
| Repositories | Add local checkouts, see branch state, and index the code so agents work from what really exists. |
| Chat | Plan, build, review, investigate, document and hand over with your chosen agent. Threads keep their history and workspace context. |
| Workflows | Build reusable multi-step workflows. Each step can use a different provider and model, including Codex and your local Cursor models. |
| Work items | Bring in Linear, Jira or Azure DevOps items, acceptance criteria, analyst findings and follow-up tasks next to the code. |
| Editor and terminal | Open an editor and real terminals scoped to the workspace. Terminals keep running, with their output buffered, while you work elsewhere in the app. |
| Git and code review | Read diffs, run reviews, separate blocking issues from preferences, and prepare pull request notes. |
| Security and dependencies | Run audits, check package risk, export findings and keep open issues visible. |
| Docs and diagrams | Keep docs, decision records, architecture notes, draw.io diagrams and design context near the repo. |
| Governance | Track lifecycle gates, impact analysis, decisions, readiness checks and handover packs. |
| Activity and notifications | See work running in other workspaces, and jump straight to the thread when an agent needs approval or input, or finishes. |
| Companions | Use your phone, watch, Raycast, widgets or the menu bar for quick actions. Heavy review stays on the desktop. |
| Cloud Workbench (optional) | Connect to an Anvil Cloud execution service, send it a read-only snapshot of a commit, pick how the agent signs in, and inspect the results without leaving chat. |

## Built around the conversation

Chat, repositories and the editor are the main navigation. Work items, automations, workflows and code review are close behind, and everything else lives under **More tools**. On narrow layouts the navigation shrinks so the conversation keeps the width.

Switching workspaces doesn't stop running work. The activity centre shows conversations that are running or waiting in any workspace. Notifications for approvals, questions and finished runs take you back to the right workspace and thread.

## Local by design

The app has a privileged main process, a typed bridge to the interface, a SQLite database and a React interface.

That split matters because developer tools handle credentials, repositories, shell commands and connector settings. The interface code never gets direct access to Node.

The optional Cloud Workbench keeps the same split. Its access token is encrypted in the main process's database, repository archives are built and uploaded by the main process, and the interface only sees connection status, execution leases and results. Cloud Workbench is off by default and stays out of normal chat unless you turn it on.

## Newer tools

- [Workflows](/docs/desktop/workflow-graphs) run teams of specialist agents across providers, with limits on delegation and a person making the key decisions.
- [Change review](/docs/desktop/change-review) ties sign-off to a replayed version of the change, a versioned set of criteria and the evidence captured.
- [Dojo](/docs/desktop/dojo) links agent activity and usage to suggestions for better prompts and skills.

## Read next

- [Feature directory](/docs/desktop/feature-directory)
- [Installation and setup](/docs/desktop/installation)
- [Workspaces, repositories and activity](/docs/desktop/workspaces-repositories-and-activity)
- [Chat, surfaces and agent runs](/docs/desktop/chat-canvas-and-agent-runs)
- [Architecture](/docs/desktop/architecture)
- [Operating guide](/docs/desktop/operating-guide)
- [Agent workflows](/docs/desktop/agent-workflows)
- [Security and review](/docs/desktop/security-and-review)
- [Companion surfaces](/docs/desktop/companion-surfaces)
- [Extending Anvil Desktop](/docs/desktop/extending-anvil)
