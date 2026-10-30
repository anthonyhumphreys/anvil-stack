---
title: Keyboard shortcuts and composer keys
navTitle: Keyboard shortcuts
description: Global shortcuts, the chat composer's keys, and how to rebind them.
product: Mezair Desktop
section: Reference
journey: reference
order: 285
---

# Keyboard shortcuts and composer keys

Most actions in Mezair have a keyboard shortcut. On macOS shortcuts use <kbd>⌘</kbd>; on Windows and Linux the same shortcuts use <kbd>Ctrl</kbd>.

## Global shortcuts

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Command palette | <kbd>⌘</kbd> <kbd>K</kbd> | <kbd>Ctrl</kbd> <kbd>K</kbd> |
| Settings | <kbd>⌘</kbd> <kbd>,</kbd> | <kbd>Ctrl</kbd> <kbd>,</kbd> |
| Toggle terminal | <kbd>⌘</kbd> <kbd>`</kbd> | <kbd>Ctrl</kbd> <kbd>`</kbd> |
| New chat thread | <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>N</kbd> | <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>N</kbd> |
| Create workspace | <kbd>⌘</kbd> <kbd>⌥</kbd> <kbd>N</kbd> | <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd> |

The command palette reaches views, recent threads, workspace switching and actions such as picking up a shared thread.

## In the composer

| Key | What it does |
| --- | --- |
| <kbd>Enter</kbd> | Send. While an agent is working, Enter adds a line instead. |
| <kbd>Shift</kbd> <kbd>Enter</kbd> | New line. |
| <kbd>⌘</kbd> <kbd>Enter</kbd> | While an agent is working, send using the selected follow-up mode: **Guide** the current run, or **Queue** it for when the run finishes. |
| <kbd>/</kbd> | Commands. |
| <kbd>$</kbd> | Skills available to the agent. |
| <kbd>@</kbd> | Mention a file from the thread's repositories. |

Guide, Queue and a read-only side question are available for Codex, OpenAI, Azure and LLMGateway. Cursor and Devin offer Queue while work continues. The composer shows which modes the current provider supports.

## Rebinding

Open **Settings → Keyboard shortcuts** to change a global shortcut. A binding needs at least one of ⌘/Ctrl, ⌥/Alt or Ctrl alongside the key. Common editing shortcuts such as copy, paste, undo, select all, find and quit are reserved and can't be rebound. Shortcuts are stored on this device and don't sync.
