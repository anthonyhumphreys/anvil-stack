---
title: Terminal and editor
description: Use the PTY terminal and embedded VS Code editor inside Anvil Desktop without losing workspace context.
product: Anvil Desktop
section: Working guide
order: 115
---

# Terminal and editor

Anvil Desktop includes a PTY-based terminal and an embedded VS Code server so you can run shell commands and edit files without leaving the workspace.

## PTY terminal

The terminal runs real shell processes through `node-pty` in the main process. It is not a fake terminal that pipes output through a WebSocket with optimistic rendering.

### What works

- Bash, zsh, or fish depending on the system shell.
- Full TTY features: colours, cursor movement, tab completion, curses apps.
- Multiple terminal tabs per workspace.
- Session restore on app restart where the OS allows it.
- Working directory tracking per tab.

### What does not work yet

- Windows shell selection is still being hardened. The porting guide covers the plan.
- SSH agent forwarding from inside the terminal is not automatically wired.
- Very long-running background processes may not survive an app restart.

### Terminal limits

The terminal can run any shell command the user can run. That is the point. But keep in mind:

- Commands run as the user who launched Anvil Desktop.
- The terminal does not sandbox commands.
- Sensitive commands should be reviewed before execution, especially if a chat session suggested them.

## Embedded editor

The embedded editor is a VS Code server instance that Anvil Desktop can start for a workspace. It gives you editor features without switching applications.

### What works

- File tree scoped to the active workspace.
- Syntax highlighting for TypeScript, JavaScript, JSON, YAML, Markdown, and more.
- Extension loading where the VS Code server supports it.
- Open file from chat sessions by clicking a file reference.

### What does not work yet

- Full extension marketplace access may be limited by the server implementation.
- Debugging features depend on the language server and debug adapter setup.
- The embedded editor is a convenience, not a replacement for a full IDE when heavy refactoring or multi-repo navigation is needed.

## Security posture

The terminal and editor are privileged surfaces:

- They run shell commands and file writes directly.
- They do not go through the preload bridge like renderer components.
- A chat session that suggests `rm -rf` can still be executed if the user confirms it.

Treat terminal suggestions from AI sessions with the same scepticism you would apply to a Stack Overflow answer from 2013.

## Workflow tips

1. Open the terminal in the repo directory before running build or test commands.
2. Use the editor for quick file inspections and small edits.
3. Switch to your full IDE for large refactors or when you need full debugging.
4. Keep terminal tabs named by purpose: `build`, `test`, `logs`, `server`.
5. Copy terminal output into chat sessions when the model needs error context.

## Read next

- [Operating guide](/docs/desktop/operating-guide)
- [Build and release](/docs/desktop/build-and-release)
