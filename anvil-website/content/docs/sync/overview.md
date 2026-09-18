---
title: Sync & Mesh overview
navTitle: Overview
description: What Sync & Mesh is, the four connection modes, what syncs and what stays local, and how the trust model works.
product: Anvil Sync & Mesh
section: Start here
journey: learn
order: 10
---

# Sync & Mesh overview

Sync & Mesh is the account layer for Anvil Desktop. Two halves:

- **Sync** replicates account-owned entities — workspace definitions, workflow
  templates, editable agents, and approved settings — across your enrolled
  devices. Entity payloads are sealed on-device before dispatch; the backend
  stores and forwards ciphertext.
- **Mesh** runs jobs — workspace preparation, diagnostics, provider sessions —
  on machines you enrolled. Compute and credentials never leave your hardware;
  the backend coordinates, it does not execute.

Both are optional. Anvil works local-only by default, and the backend is yours
to choose: the wire contract is frozen and provider-neutral, so the same
desktop build talks to an Anvil-operated deployment, a Worker on your own
Cloudflare account, or a third-party implementation that passes the
conformance suite.

This is alpha infrastructure. The architecture, contract, and lifecycle are
implemented and tested, and the system has been rehearsed on real Cloudflare
deployments — but a physical multi-device demo has not happened yet. See
[Status and limits](/docs/sync/status-and-limits) for the unvarnished list.

## Connection modes

Settings → Sync & Mesh offers four modes:

| Mode | Behavior |
| --- | --- |
| Local only | Nothing leaves the device. A remembered backend is paused, not forgotten. The default. |
| Anvil-hosted | The operated backend run by the Anvil project. In this build the option renders disabled — "not shipping in this packet." See [Anvil-hosted sync](/docs/sync/hosted). |
| Your Cloudflare | Point Anvil at a Cloudflare Workers deployment you own (labeled *My Cloudflare deployment* in the picker). Deploy it with [`anvil-cloud mesh`](/docs/sync/self-deploy). |
| Compatible backend | Any URL implementing the frozen Sync v1 contract — see [Backend conformance](/docs/sync/conformance). |

Pinning a backend stores the association and stops there. No data uploads until
you sign in and enable sync. If a pinned backend's identity changes — endpoint
or issuer — the app requires re-review before credentials are sent to it again.

## What syncs, what doesn't

| Syncs (sealed) | Stays local |
| --- | --- |
| Workspace definitions | Repo contents, uncommitted state |
| Workflow templates | Provider credentials and session secrets |
| Editable agents | Mesh worker opt-in flag (per-device, never syncs) |
| Approved settings | Device identity keys, sync tokens |

Sync carries account-owned configuration entities, not your code. Git state
moves through Git; mesh jobs verify commits, they do not replicate trees.

## The mental model

Devices hold the keys; the backend relays ciphertext.

- Each device generates an X25519 identity at enrollment and publishes the
  public half as a crypto-boundary entity.
- A versioned account data key (ADK) seals every synced payload with
  AES-256-GCM. Devices wrap the ADK to each other's public keys.
- The backend validates envelope shape, journals ciphertext opaquely, and
  coordinates devices, jobs, and handoffs. It can read metadata — never
  content.

The exact field list the server can see is documented in
[Encryption and keys](/docs/sync/encryption). If you are evaluating the trust
claims, start there, then [How sync works](/docs/sync/sync-engine).

## Where to go next

| I want to… | Read |
| --- | --- |
| Understand the crypto and what the server sees | [Encryption and keys](/docs/sync/encryption) |
| Follow a write from edit to peer apply | [How sync works](/docs/sync/sync-engine) |
| Move a running session between machines | [Session handoff](/docs/sync/session-handoff) |
| Add or remove a device | [Devices and pairing](/docs/sync/devices) |
| Run jobs on my own hardware | [Mesh jobs and remote execution](/docs/sync/mesh-jobs) |
| Share an artifact link | [Artifacts and share links](/docs/sync/artifacts-and-shares) |
| Export, import, or delete my data | [Data portability and deletion](/docs/sync/data-portability) |
| Deploy the backend myself | [Self-deploy the backend](/docs/sync/self-deploy) |
| Build a compatible backend | [Backend conformance](/docs/sync/conformance) |
| Check preview terms and billing | [Anvil-hosted sync](/docs/sync/hosted) |
| See every known gap in one place | [Status and limits](/docs/sync/status-and-limits) |

The older single-page version of this material lives at
[Sync and Mesh](/docs/desktop/sync-and-mesh) under Anvil Desktop.
