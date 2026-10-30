---
title: Sync & Mesh overview
navTitle: Overview
description: What Sync & Mesh is, the four connection modes, what syncs and what stays local, and how the trust model works.
product: Mezair Sync & Mesh
section: Start here
journey: learn
order: 10
---

# Sync & Mesh overview

Sync & Mesh connects your Mezair installations:

- **Sync** keeps workspace definitions, workflow templates, custom agents and
  selected settings in step across your machines. You choose which workspaces
  sync. Content is encrypted on your device before the backend receives it.
- **Mesh** runs jobs on machines you've connected to your account, including
  workspace preparation, diagnostics and provider sessions. The jobs run on
  those machines, and provider credentials stay there.
  Supported upgraded clients use an authenticated, encrypted host session for
  live traffic when a route is enabled and reachable. Routing is LAN first: the
  host's LAN address, then other private routes, HTTPS and managed ingress.
  Managed routes use the provider's proxy; they are not peer-to-peer. The account
  service handles identity, discovery, and durable job decisions; it does not
  execute.

Both are optional. Mezair works local-only by default, and the backend is yours
to choose: the wire contract is frozen and provider-neutral, so the same
desktop build talks to a Mezair-operated deployment, a Worker on your own
Cloudflare account, or a third-party implementation that passes the
conformance suite.

Mezair-hosted writes require a paid entitlement or a redeemed beta code. The
invite-only test path uses time-limited codes, checkout is closed, and
production hosting is not available yet. Proposed paid plans start at £6 a
month for one person. You can run your own backend without paying Mezair; your
infrastructure costs still apply. See [pricing](/pricing).

Sync & Mesh, including [LAN-first Mesh routing](/docs/sync/lan-first-routes),
is in beta through 30 November 2026. The architecture, contract, and lifecycle
are implemented and tested, and the system has been rehearsed on real
Cloudflare deployments. A recorded physical multi-device demo is still pending.
See [Status and limits](/docs/sync/status-and-limits) before relying on it.

## Account backend modes

Onboarding and Settings → Sync & Mesh offer one hosted sign-in action. Custom
service choices remain in **Advanced connection settings**:

| Mode | Behavior |
| --- | --- |
| Local only | No account backend is connected. A remembered backend is paused, not forgotten. New workspaces default to Local. |
| Mezair-hosted | **Sign in to Mezair** uses the hosted service configured for this build. The test path is invite-only; hosted writes require paid or beta access. Checkout and production hosting are not available yet. See [Mezair-hosted sync](/docs/sync/hosted). |
| Your Cloudflare | Point Mezair at a Cloudflare Workers deployment you own (labeled *My Cloudflare service* in advanced settings). Deploy it with [`mezair-cloud mesh`](/docs/sync/self-deploy). |
| Compatible backend | Any URL implementing the frozen Sync v2 and Mesh v2 profiles, see [Backend conformance](/docs/sync/conformance). |

Sign-in checks and pins the service without uploading configuration. New
hosted accounts use automatic connection by default; choose code verification
in Sync & Mesh settings for a manual check. Save the recovery code and
explicitly connect this device before uploading portable configuration.
Choose Local or Sync separately for each workspace. If the backend's endpoint
or issuer changes, the app requires re-review before sending credentials
again.

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
enabled and reachable. The app chooses the route automatically and
[prefers the host's LAN address](/docs/sync/lan-first-routes). Managed
endpoints pass through the provider's proxy; they avoid the Mezair application
relay, but are not peer-to-peer. They need a provisioned, enabled endpoint, and
choosing Sync does not provision one. The account service remains responsible for
identity, discovery, durable job decisions, and required recovery.

- Each device generates an X25519 identity at enrollment and publishes the
  public half as a crypto-boundary entity.
- A versioned account data key (ADK) seals every synced payload with
  AES-256-GCM. Devices wrap the ADK to each other's public keys.
- The backend validates envelope shape, journals ciphertext opaquely, and
  coordinates devices, jobs, and handoffs. It can read metadata but never
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
| Add or remove a device | [Devices and sign-in](/docs/sync/devices) |
| Run jobs on my own hardware | [Mesh jobs and remote execution](/docs/sync/mesh-jobs) |
| Understand how Mesh picks and switches routes | [LAN-first Mesh routes](/docs/sync/lan-first-routes) |
| Share an artifact link | [Artifacts and share links](/docs/sync/artifacts-and-shares) |
| Export, import, or delete my data | [Data portability and deletion](/docs/sync/data-portability) |
| Deploy the backend myself | [Self-deploy the backend](/docs/sync/self-deploy) |
| Build a compatible backend | [Backend conformance](/docs/sync/conformance) |
| Check hosted availability and legacy billing records | [Mezair-hosted sync](/docs/sync/hosted) |
| See every known gap in one place | [Status and limits](/docs/sync/status-and-limits) |

The older single-page version of this material lives at
[Sync and Mesh](/docs/desktop/sync-and-mesh) under Mezair Desktop.
