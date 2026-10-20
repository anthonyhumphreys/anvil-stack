---
title: Anvil in the browser
navTitle: Browser workspace
description: Connect a browser to an enrolled Anvil Desktop, open approved projects, and choose the provider and access mode for your chat.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 65
---

# Anvil in the browser

Open the [web workspace](/account/workspace) and sign in with the account
linked to Anvil Desktop. The browser controls work on a connected machine;
the machine runs the provider and keeps the repository checkout and provider
credentials. Browser-to-cloud execution is outside this release.

## Connect a machine

Choose a named machine from your account and request a connection. You do
not need to copy workspace or repository IDs. Revoked devices and temporary
cloud workers do not appear as connection choices. A machine in the list is
enrolled, but that does not establish that it is currently online.

Anvil Desktop shows the request and verification code. Compare the code
with the browser, select the workspace and repositories it may access, and
approve the requested capabilities. Only the selected machine can decide
the request. Your web sign-in alone does not grant repository access.

The project picker shows the repositories covered by that approval. Adding
repositories or capabilities requires another approval. The browser does
not receive the account data key or unrestricted filesystem access.

Desktop can remember this browser for up to 30 days. The browser still uses
short sessions and proves possession of its approved key when reconnecting.
Remembering a browser never widens the original approval. Disconnect revokes
the remembered connection and its sessions; locking the browser only removes
its current connection from view.

Desktop enforces session expiry locally, including while it cannot reach the
backend. A valid renewed session can continue the browser's active turn.
Without one, expiry interrupts that turn and closes its browser terminals.
It does not stop unrelated Desktop work.

## Work in a chat

Choose a project and open or create a thread. The composer uses the provider,
model and access mode selected for that session. Available providers and
models come from the connected machine's configuration. An unavailable
provider needs configuration on that machine before it can run.
Switch providers between turns. Anvil keeps the chat transcript and starts
the selected provider's session on the next message.

The machine's maximum permission mode bounds the selected access mode.
Browser connection capabilities are separate: the browser must also have
permission to send work, edit files, use a terminal or resolve approvals.
Changing Desktop's default agent mode does not itself authorise a browser.

Conversation, changes, files, terminal output and preview use the same
workspace interface. Preview captures a screenshot of a running development
server on the connected machine. It is not an interactive browser session.
File edits carry an expected revision so a stale browser cannot silently
overwrite a newer change.

## Acceptance checks for a candidate

Use a candidate Desktop and the matching staging backend for these checks:

1. Request a connection by machine name, approve exact repositories, and
   confirm the browser lists only those projects.
2. Send a chat with a configured provider and model. Follow its progress,
   send a follow-up, resolve a requested approval and interrupt a turn. Switch
   providers after a turn finishes and send again in the same thread. Confirm
   agent progress is attributed to Anvil and newer draft text survives a slow
   send.
3. Set the machine's maximum mode below the requested mode. Confirm the
   session reports and enforces the effective mode. Repeat with Desktop's
   default set to Full access.
4. Reopen a remembered browser and verify renewal of its short session.
   Changing the browser key, origin, account, target, repositories or scopes
   must not inherit that approval.
5. Disconnect the browser or revoke access in Desktop. Confirm renewed
   sessions and browser terminals lose access too.
6. Take the machine offline. Confirm the browser preserves an unsent draft
   and reports uncertain command outcomes without replaying mutations. Let a
   session expire while Desktop cannot reach the backend; confirm its active
   browser turn and terminals stop without interrupting other Desktop work.

Passing an automated build does not replace these physical-device and
provider-login checks. Availability in the operated service still depends
on the matching Desktop and backend being released.

## Shared chat presentation

The web composer, message framing, thread rows and empty state use the same
React presentation components as Desktop, in
`anvil-app/src/renderer/components/chat/shared/ChatPresentation.tsx`. The
default palette is shared through `anvil-app/src/renderer/styles/chat-theme.css`.
These components accept data and callbacks; they do not import Electron or
Desktop services. Browser transport and Desktop execution stay separate.

Website CI also runs when those shared sources change. The website installs
its own dependencies and supplies the React types for those shared sources.
