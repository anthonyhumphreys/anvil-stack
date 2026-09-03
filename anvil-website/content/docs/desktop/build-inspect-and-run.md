---
title: Build, inspect, and run
navTitle: Build and inspect
description: Run repository commands, inspect CI pipelines, preview web and mobile apps, and send runtime evidence back to Chat.
product: Anvil Desktop
section: Delivery tools
journey: build
order: 114
---

# Build, inspect, and run

Anvil Desktop keeps common build and inspection tools inside the workspace. These tools run against local repositories and processes. They do not turn a developer machine into a sandbox.

## Repository run commands

Anvil detects runnable scripts from a repository and can use the configured model to suggest additional commands. You can save a custom command, pin or unpin it, start it, stop it, and inspect its latest status and output.

Detected or generated commands are still shell commands. Read them before running them. Saved commands persist for reuse but do not gain extra safety by being familiar.

## CI/CD Atlas

CI/CD Atlas analyses the selected repository's pipeline files and renders stages, jobs, dependencies, reusable templates, and environment gates as an explorable graph. Select a node to inspect its source, dependencies, gate status, and validation findings.

The assistant input supports focused requests such as finding gates, validating the pipeline, or locating a named job. It works against the parsed pipeline model; it is not a general chat session.

When no supported pipeline exists, Atlas can preview and create a starter file from its built-in templates. Review the generated file, especially permissions, secrets, branch filters, deployment environments, and release gates, before committing it.

Pipeline analysis is local static inspection. It does not prove that the hosted CI provider accepted or ran the configuration.

## Embedded browser

The Browser view can:

- detect local development servers
- add a URL manually
- navigate, reload, and keep a preview beside Chat
- open the preview in a detachable window
- record an annotation against the current page
- send browser context to Chat
- start the local browser bridge, attach its debugger, and register the browser MCP integration

The bridge gives an agent a route to browser inspection when configured. Treat it as privileged local automation and stop it when the task is complete.

## iOS simulator preview

The Browser view can also start and stop the iOS simulator preview service. This is a visual preview inside Anvil, separate from Argent's agent-assisted mobile inspection tools.

The preview depends on local Xcode simulator state and the configured mobile project. It does not provide an Android emulator view through this panel.

## Terminal and editor

The PTY terminal runs a real shell and preserves buffered output while the desktop process stays alive. The embedded editor starts a local VS Code server, focuses files and positions requested by other Anvil views, and can hand a target to an external editor.

See [Terminal and editor](/docs/desktop/terminal-and-editor) for lifecycle and security limits.

## Useful evidence to send to Chat

Send the smallest useful evidence:

- the failing command and exit code
- the relevant output excerpt
- the pipeline node and source file
- the preview URL and visible failure
- a screenshot or annotation when layout matters
- the repository and branch under test

Do not paste a whole build log if the first actionable error is twelve lines long. Agents can read noise, but they cannot make it free.
