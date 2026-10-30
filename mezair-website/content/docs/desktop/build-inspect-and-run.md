---
title: Build, inspect and run
navTitle: Build and inspect
description: Run repository commands, explore CI pipelines, preview web and mobile apps, and send what you find back to chat.
product: Mezair Desktop
section: Guides
journey: build
order: 120
---

# Build, inspect and run

Mezair Desktop keeps everyday build and inspection tools inside the workspace. They run against your local repositories and processes. They don't turn your machine into a sandbox.

## Repository run commands

Mezair finds the scripts a repository can run, and can ask your model to suggest more. You can save a custom command, pin it, start and stop it, and see its latest status and output.

Detected or suggested commands are still shell commands, so read them before running them. A saved command isn't any safer for being familiar.

## CI/CD Atlas

CI/CD Atlas reads a repository's pipeline files and draws its stages, jobs, dependencies, shared templates and environment gates as a graph you can explore. Select a node to see its source, dependencies, gate status and any problems.

Its assistant answers focused questions, like finding gates, validating the pipeline or locating a job. It only knows about the pipeline; it isn't a general chat.

When no supported pipeline exists, Atlas can preview and create a starter file from its built-in templates. Review the generated file, especially permissions, secrets, branch filters, deployment environments, and release gates, before committing it.

This is a local read of the files. It doesn't prove your CI provider accepted or ran them.

## Embedded browser

The Browser view can:

- detect local development servers
- add a URL manually
- navigate, reload, and keep a preview beside Chat
- open the preview in a detachable window
- record an annotation against the current page
- send browser context to Chat
- start the local browser bridge, attach its debugger, and register the browser MCP integration

The bridge lets an agent inspect the browser. Treat it as powerful local automation and stop it when you're done.

## iOS simulator preview

The Browser view can also start and stop the iOS simulator preview service. This is a visual preview inside Mezair, separate from Argent's agent-assisted mobile inspection tools.

The preview depends on local Xcode simulator state and the configured mobile project. It does not provide an Android emulator view through this panel.

## Terminal and editor

The terminal runs a real shell and keeps its output while the app is open. The built-in editor runs a local VS Code server, jumps to files and lines other parts of Mezair point at, and can open them in your own editor.

See [Terminal and editor](/docs/desktop/terminal-and-editor) for lifecycle and security limits.

## What to send to chat

Send the smallest thing that helps:

- the failing command and exit code
- the relevant output excerpt
- the pipeline node and source file
- the preview URL and visible failure
- a screenshot or annotation when layout matters
- the repository and branch under test

Don't paste a whole build log when the first real error is twelve lines long. Agents can read noise, but it isn't free.
