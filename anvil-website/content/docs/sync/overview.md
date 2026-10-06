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
  templates, custom agents, and selected settings — only for workspaces where
  you choose Sync. Entity payloads are sealed on-device before dispatch; the
  backend stores and forwards ciphertext.
- **Mesh** runs jobs — workspace preparation, diagnostics, provider sessions —
  on machines you enrolled. Compute and credentials stay on those machines.
  Supported upgraded clients use an authenticated, encrypted host session for
  live traffic when a route is enabled and reachable. Managed HTTPS routes use
  an operator-configured provider proxy; they are not peer-to-peer. The account
  service handles identity, discovery, and durable job decisions; it does not
  execute.

Both are optional. Anvil works local-only by default, and the backend is yours
to choose: the wire contract is frozen and provider-neutral, so the same
desktop build talks to an Anvil-operated deployment, a Worker on your own
Cloudflare account, or a third-party implementation that passes the
conformance suite.

Sync & Mesh are free. Authentication, account lifecycle, security
policy, and fair-use limits still apply. The hosted backend is not broadly
available while Anvil-hosted production access is being prepared.

This is alpha infrastructure. The architecture, contract, and lifecycle are
implemented and tested, and the system has been rehearsed on real Cloudflare
deployments — but a physical multi-device demo has not happened yet. See
[Status and limits](/docs/sync/status-and-limits) for the unvarnished list.

## Account backend modes

Onboarding and Settings → Sync & Mesh offer one hosted sign-in action. Custom
service choices remain in **Advanced connection settings**:

| Mode | Behavior |
| --- | --- |
| Local only | No account backend is connected. A remembered backend is paused, not forgotten. New workspaces default to Local. |
| Anvil-hosted | **Sign in to Anvil** uses the hosted HTTPS service configured for this build. Production availability is still pending; Sync & Mesh remain free. See [Anvil-hosted sync](/docs/sync/hosted). |
| Your Cloudflare | Point Anvil at a Cloudflare Workers deployment you own (labeled *My Cloudflare service* in advanced settings). Deploy it with [`anvil-cloud mesh`](/docs/sync/self-deploy). |
| Compatible backend | Any URL implementing the frozen Sync v2 and Mesh v2 profiles — see [Backend conformance](/docs/sync/conformance). |

Sign-in checks and pins the service without uploading configuration. Choose
automatic connection or code verification, save recovery, and explicitly
connect this device before uploading portable configuration. Choose Local or Sync separately for each
workspace. If the backend's endpoint or issuer changes, the app requires
re-review before sending credentials again.

## What syncs, what doesn't

| Syncs (sealed) | Stays local |
| --- | --- |
| Workspace definitions | Repo contents, uncommitted state |
| Workflow templates | Provider credentials and session secrets |
| Editable agents | Mesh worker opt-in flag (per-device, never syncs) |
| Approved settings | Device identity keys, sync tokens, machine paths, and chat transcripts |

Sync is an explicit choice for each workspace; Local is the default. It shares
portable configuration only: workspace definitions, templates, custom agents,
and selected settings. It does not enable itself because you prepare or run a
remote job. Git state moves through Git; mesh jobs verify commits, they do not
replicate repository trees.

## The mental model

For Sync, devices hold the keys and the backend relays encrypted configuration.
For Mesh, supported upgraded clients send live commands and receive live output
over an encrypted session with the enrolled host when a supported route is
enabled and reachable. The app chooses the route automatically. Managed HTTPS
endpoints pass through an operator-configured provider proxy; they avoid the
Anvil application relay, but are not peer-to-peer. They are off by default and
are not enabled by choosing Sync. The account service remains responsible for
identity, discovery, durable job decisions, and required recovery.

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
| Check hosted availability and legacy billing records | [Anvil-hosted sync](/docs/sync/hosted) |
| See every known gap in one place | [Status and limits](/docs/sync/status-and-limits) |

The older single-page version of this material lives at
[Sync and Mesh](/docs/desktop/sync-and-mesh) under Anvil Desktop.
