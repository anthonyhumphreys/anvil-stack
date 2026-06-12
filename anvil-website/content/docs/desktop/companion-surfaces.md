---
title: Companion surfaces
navTitle: Companion surfaces
description: Pair mobile, watch, Raycast, menu bar, and widget controls with the desktop app.
product: Anvil Desktop
section: Working guide
order: 120
---

# Companion surfaces

Anvil's companion surfaces are opt-in controls for local agent work. They are useful when the desktop app is not frontmost and a session needs a short action: approve, decline, reply, interrupt, launch a workflow, or open the work back on the Mac.

They are not a replacement for the desktop workspace. Full diffs, terminal work, browser checks, and handover review still belong on the desktop.

## Supported surfaces

| Surface | Use it for |
| --- | --- |
| Mobile companion | Pair by QR code, inspect workspace status, resolve approvals, launch quick workflows, send short chat input, and open Anvil on the Mac. |
| Raycast extension | Check workspace state, resolve approvals, send active-session input, launch predefined workflows, and focus the desktop app. |
| macOS menu bar | See pending approvals, focus Anvil, launch companion workflows, and stop active sessions. |
| Home Screen widgets | Pin live workflow health, approval counts, running sessions, repo counts, and one-tap command launches. |
| Apple Watch | Resolve small approval decisions, send quick replies, continue, stop, summarize, or interrupt. |

## Security posture

Companion access is local and revocable. Treat tokens and pairing tickets as workflow credentials, not decoration.

Use companion surfaces for short commands. When the action needs repository inspection, terminal output, or a decision with real blast radius, open the desktop app and review the evidence.

