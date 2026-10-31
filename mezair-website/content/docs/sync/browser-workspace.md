---
title: Mezair in the browser
navTitle: Browser workspace
description: Connect a browser to an enrolled Mezair Desktop, open approved projects, and choose the provider and access mode for your chat.
product: Mezair Sync & Mesh
section: Guides
journey: build
order: 65
---

# Mezair in the browser

Open the [web workspace](/account/workspace) and sign in with the account
linked to Mezair Desktop. The browser controls work on a connected machine;
the machine runs the provider and keeps the repository checkout and provider
credentials. Browser-to-cloud execution is outside this release.

## Connect a machine

Choose a named machine from your account and request a connection. You do
not need to copy workspace or repository IDs. Revoked devices and temporary
cloud workers do not appear as connection choices. A machine in the list is
enrolled, but that does not establish that it is currently online.

Mezair Desktop shows the request and verification code. Compare the code
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
Switch providers between turns. Mezair keeps the chat transcript and starts
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

## Connection limits

The connected machine must be online and reachable. If it goes offline, the
browser preserves your unsent draft. Reconnect before sending more work; check
the outcome of an interrupted command before running it again.

A session needs a valid renewal to continue an active turn. If it expires,
Desktop stops that browser's active turn and terminals. Other Desktop work
continues.
