---
title: Desktop feature directory
navTitle: Feature directory
description: A route-by-route map of every user-facing Anvil Desktop feature and the guide that explains it.
product: Anvil Desktop
section: Basics
journey: learn
order: 101
---

# Desktop feature directory

This directory maps the shipped Anvil Desktop views to the documentation that explains them. Use it when you know the label in the app but not where the operating detail lives.

Role selection controls which tools appear. Cloud is also hidden until you enable it in Settings. A missing navigation item can therefore mean "not enabled for this workspace" rather than "not installed."

## Primary workspace

| Feature | What it does | Guide |
| --- | --- | --- |
| Inbox | Collects approvals, questions, failures, completed work, agent runs, automations, indexing, and local processes that need attention. | [Workspaces, repositories, and activity](/docs/desktop/workspaces-repositories-and-activity) |
| Chat | Runs repository-aware Codex, Cursor, OpenAI, or Azure-backed conversations with attachments, approvals, plans, goals, artifacts, and agent activity. | [Chat, canvas, and agent runs](/docs/desktop/chat-canvas-and-agent-runs) |
| Workspace | Groups repositories and workspace-specific preferences, supports more than one window, and exports VS Code workspace files. | [Workspaces, repositories, and activity](/docs/desktop/workspaces-repositories-and-activity) |
| Repositories | Connects local checkouts, clones GitHub or Azure DevOps repositories, indexes code, and builds repository maps. | [Workspaces, repositories, and activity](/docs/desktop/workspaces-repositories-and-activity) |

## Automate

| Feature | What it does | Guide |
| --- | --- | --- |
| Watchtower and schedules | Runs manual, scheduled, or repository-change-triggered automation in disposable worktrees and stores run events. | [Automations](/docs/desktop/automations) |
| Workflows | Builds reusable agent graphs, assigns providers and models per step, runs them against workspace repositories, and exposes the supervisor transcript. | [Workflow graphs](/docs/desktop/workflow-graphs) |

## Delivery

| Feature | What it does | Guide |
| --- | --- | --- |
| Work Items | Searches and plans work from named Azure DevOps, Linear, or Jira connections. | [Work items and planning](/docs/desktop/work-items-and-planning) |
| Code Review | Reviews a codebase, commit, branch, or pull request; tracks findings; posts comments; exports reports; and produces pull request visualisations. | [Assurance tools](/docs/desktop/assurance-tools) |
| CI/CD Atlas | Reads pipeline files as a graph, inspects jobs and gates, validates the pipeline, and creates starter files from templates. | [Build, inspect, and run](/docs/desktop/build-inspect-and-run) |
| Git | Stages, unstages, discards, commits, fetches, pulls, pushes, creates pull requests, and manages local branches. | [Git workflows](/docs/desktop/git-workflows) |

## Build and inspect

| Feature | What it does | Guide |
| --- | --- | --- |
| Editor | Starts or attaches to the embedded VS Code server, focuses files from Anvil, or opens them in an external editor. | [Terminal and editor](/docs/desktop/terminal-and-editor) |
| Browser | Detects local dev servers, opens an embedded preview, records annotations, sends page context to Chat, and can register the browser MCP bridge. | [Build, inspect, and run](/docs/desktop/build-inspect-and-run) |
| Cloud | Runs Anvil Cloud health, build, runtime, workflow, service, and agent commands. It can also start and supervise authenticated remote executions. | [Cloud and mobile workbenches](/docs/desktop/cloud-and-mobile-workbenches) |
| DB Insights | Imports database exports, detects tables, stored procedures, relationships, and risks, then prepares follow-up prompts for Chat. | [Assurance tools](/docs/desktop/assurance-tools) |
| Dependencies | Inventories npm, pnpm, Yarn, NuGet, and Python packages; runs vulnerability and licence checks; and exports SBOMs. | [Assurance tools](/docs/desktop/assurance-tools) |
| Security | Runs repository security audits, tracks findings, creates work items, and exports reports. Its Pentest tab runs Docker-backed dynamic scans. | [Assurance tools](/docs/desktop/assurance-tools) |
| Onboarding | Detects repository setup, generates `AGENTS.md` and devcontainer files, checks the environment, and can write or commit approved artifacts. | [Workspaces, repositories, and activity](/docs/desktop/workspaces-repositories-and-activity) |
| Argent | Checks the Expo companion toolchain and prepares mobile inspection prompts for screenshots, logs, network calls, React trees, profiles, and deep links. | [Cloud and mobile workbenches](/docs/desktop/cloud-and-mobile-workbenches) |

## Knowledge

| Feature | What it does | Guide |
| --- | --- | --- |
| Meeting Notes | Accepts pasted or dictated notes, extracts actions and spike signals locally, and sends selected follow-up work to Chat. | [Work items and planning](/docs/desktop/work-items-and-planning) |
| Workspace Notes | Stores follow-ups for later review, including notes captured by companion surfaces. | [Workspaces, repositories, and activity](/docs/desktop/workspaces-repositories-and-activity) |
| Documentation | Browses Confluence pages, checks staleness against a repository, drafts updates, and creates pages. | [Knowledge tools](/docs/desktop/knowledge-tools) |
| ADRs | Finds architecture decision records across workspace repositories and provides a readable detail view. | [Knowledge tools](/docs/desktop/knowledge-tools) |
| Diagrams | Lists and edits repository Draw.io files, generates diagram XML with the configured model, and opens Draw.io for manual work. | [Knowledge tools](/docs/desktop/knowledge-tools) |

## Governance and operations

| Feature | What it does | Guide |
| --- | --- | --- |
| Lifecycle | Tracks delivery items through configurable stages and gates, links repositories and work items, runs impact analysis, and exports handover packs. | [Governance and lifecycle](/docs/desktop/governance-and-lifecycle) |
| Governance boards | Groups local governance documents into workspace boards. | [Governance and lifecycle](/docs/desktop/governance-and-lifecycle) |
| Data and Compliance | Generates repository-grounded DPIA, privacy policy, and terms drafts with explicit human-review markers. | [Assurance tools](/docs/desktop/assurance-tools) |
| Settings | Controls roles, themes, chat layout, model providers, connectors, companion access, feature flags, review rubrics, and opt-in crash reports. | [Settings and diagnostics](/docs/desktop/settings-and-diagnostics) |
| Codex Skills and MCPs | Inspects installed skills and MCP servers, searches `skills.sh`, installs skills, and registers local or HTTP MCP servers. | [Settings and diagnostics](/docs/desktop/settings-and-diagnostics) |
| Runtime Diagnostics | Reports Electron process memory, feature counters, active work, and local runtime state. | [Settings and diagnostics](/docs/desktop/settings-and-diagnostics) |

## Companion and launch surfaces

The mobile app, Apple Watch app, widgets, menu bar, Raycast extension, CarPlay, and Siri expose smaller slices of the desktop workflow. Pairing, revocation, approval limits, and supported actions are documented in [Companion surfaces](/docs/desktop/companion-surfaces).

Anvil also accepts open intents and notifications that navigate to the relevant workspace, thread, or tool. Tool views can open in detachable windows when a second window is useful for comparison or monitoring.
