---
title: Companion surfaces
navTitle: Companion surfaces
description: Pair mobile, watch, widget, menu bar, Raycast, CarPlay, and Siri controls with the desktop app.
product: Anvil Desktop
section: Working guide
journey: build
order: 120
---

# Companion surfaces

Anvil's companion surfaces are opt-in controls for local agent work. They are useful when the desktop app is not frontmost and a session needs a short action: approve, decline, reply, interrupt, launch a workflow, or open the work back on the Mac.

They are not a replacement for the desktop workspace. Full diffs, terminal work, browser checks, and handover review still belong on the desktop.

## Supported surfaces

| Surface | Use it for |
| --- | --- |
| Mobile companion | Pair by QR code, switch hosts and workspaces, inspect the work queue and workspace health, resolve approvals, browse threads and work items, send chat input, and launch quick actions. |
| Raycast extension | Check workspace state, resolve approvals, send active-session input, launch predefined workflows, and focus the desktop app. |
| macOS menu bar | See pending approvals, focus Anvil, launch companion workflows, and stop active sessions. |
| Home Screen widgets | Pin live workflow health, approval counts, running sessions, repo counts, and one-tap command launches. |
| Apple Watch | Resolve small approval decisions, send quick replies, continue, stop, summarize, or interrupt. |
| CarPlay | Shows the Anvil Drive queue and offers a small set of safe actions such as pausing work, continuing low-risk checks, preparing a handover, or capturing a note. |
| Siri | Captures a workspace note or invokes a supported short companion action through the mobile app. |

## Pairing and hosts

Desktop starts a local companion server only after you enable it. A pairing ticket is short-lived and contains the server address and one-time ticket in a QR code. The companion can store more than one host and prefers reachable LAN or Tailscale addresses over loopback.

Settings lists paired devices with their client type and last-seen state. Revoke a device when it is lost, replaced, or no longer needs access. Raycast uses a separately issued companion token.

## Approval limits

Companion approval requests show the command or file change, repository, workspace, reason, and risk metadata that Desktop supplied. Some requests require desktop review and should not offer a remote approval shortcut.

Destructive or unclear actions belong on Desktop, where the full thread, diff, and terminal context are visible. A small screen is good at answering "continue this known check." It is bad at reviewing a shell command that can delete half a monorepo.

## Security posture

Companion access is local, authenticated, and revocable. Treat tokens and pairing tickets as workflow credentials, not decoration. Network reachability still depends on the selected advertised address and the host machine's firewall.

Use companion surfaces for short commands. When the action needs repository inspection, terminal output, or a decision with real blast radius, open the desktop app and review the evidence.
