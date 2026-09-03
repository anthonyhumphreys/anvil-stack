---
title: Settings and diagnostics
navTitle: Settings and diagnostics
description: Configure roles, providers, connectors, companion access, Codex extensions, telemetry, and runtime diagnostics.
product: Anvil Desktop
section: Operations
journey: reference
order: 122
---

# Settings and diagnostics

Settings controls application-wide defaults and connector credentials. Workspace preferences handle choices that belong to one workspace. Keep that boundary in mind when a provider works in one workspace but not another.

## Appearance and role

Choose the Developer, BA/BRM, Design, or ITSM role to control which tools appear in navigation. Roles change visibility, not the underlying repository data or operating-system permissions.

Theme and chat layout are also saved here. The onboarding preview replays the role and connector screens without replacing the saved configuration.

## Agent providers

Choose one primary provider for new Chat threads and app-level AI work, then enable any additional providers that workflow steps may use. Provider settings cover:

- Codex CLI status, model, reasoning effort, and maximum agent threads
- Cursor CLI status and the locally reported model catalog
- OpenAI API credentials and model selection
- Azure AI Foundry configuration through the Codex provider configuration
- optional local helper routing through Apple Foundation Models, Ollama, or LM Studio

Connection tests report configuration or authentication failures. A successful test does not grant the model broader repository permissions than the selected Chat mode.

## Skills, MCPs, and agent instructions

The Codex Skills and MCPs view has three areas:

- Installed lists registered skills and MCP servers.
- Discover searches `skills.sh` and installs a selected skill.
- MCP provides presets and registers a local command or HTTP server with optional environment configuration.

Settings can also read and edit the Codex `AGENTS.md` file used by the local toolchain. Review the path and content before saving because those instructions affect later agent sessions.

Installed extensions run under their own permissions and configuration. Inspect their source and credential needs before installation.

## Delivery connectors

Named work item connections support Azure DevOps, Linear, and Jira. A workspace can bind to the appropriate connection instead of sharing one anonymous global credential.

Documentation settings support Confluence directly and Notion through MCP. Git and repository connection settings cover GitHub and Azure DevOps access where the matching feature uses them. Review rubrics can customize quick-glance and senior code review prompts.

## Companion and optional features

Mobile companion settings start or stop the local companion service, create a short-lived pairing ticket, issue a Raycast token, list paired devices, and revoke a device. Pairing data is a credential.

Cloud features are off by default. Enabling them reveals the Cloud Workbench; it does not configure a Cloud execution endpoint for you.

## Updates and crash reporting

Packaged Desktop builds initialize the update service and use the configured release feed for the platform. Availability and installation behavior depend on the packaged target and release configuration, not the development server.

Crash reporting is opt-in. When enabled, Anvil sends crash reports to Sentry. The UI states that reports exclude screenshots, interaction history, and attached file contents. Keep secrets out of error messages regardless.

## Runtime Diagnostics

The Diagnostics view reports a point-in-time snapshot of:

- process memory for Electron runtime processes
- workspace, repository, thread, terminal, and other feature counters
- the active workspace and thread
- runtime and tool status exposed by the diagnostics service

Refresh the snapshot after reproducing a problem. Pair it with the app version, operating system, failing action, and exact error text when filing an issue.

Diagnostics is observational. It does not repair a database, restart a failed provider, or clear a stuck run.

## Credential storage and reset

Connector credentials are encrypted before storage in local SQLite. The renderer uses typed IPC methods and should not receive raw secrets unless a specific workflow requires user entry.

Resetting onboarding replays setup state. Deleting the application data directory is a much broader reset and removes local history and encrypted settings. Export anything important first.
