---
title: Sync and Mesh
navTitle: Sync and Mesh
description: The Settings → Sync & Mesh panel in Anvil Desktop — connection modes, sign-in and device enrollment, remote executions, the mesh worker, session handoff, and your data.
product: Anvil Desktop
section: Guides
journey: build
order: 200
---

# Sync and Mesh

Sync & Mesh is the account layer of Anvil Desktop: end-to-end encrypted sync
of account-owned entities, remote job execution on your own machines, and
checkpointed session handoff between devices. **Settings → Sync & Mesh** is
where you connect, enroll, and supervise all of it. This page describes the
panel; the contract, encryption, and backend mechanics live in the
[Sync & Mesh docs](/docs/sync/overview).

Everything here is optional — Anvil works local-only by default. It is also
alpha: the lifecycle is implemented and tested and has been rehearsed against
real Cloudflare deployments, but a physical multi-device demo is still
pending.

## Connection modes

The panel offers four modes:

| Mode | Behavior |
| --- | --- |
| Local only | Nothing leaves the device. Any remembered backend is paused, not forgotten. |
| Anvil-hosted | The operated backend. Renders **disabled** in this build — hosted sync is not shipping in this packet. |
| Your Cloudflare | A backend you deploy to your own Cloudflare account with `anvil-cloud mesh`. |
| Compatible backend | Any URL implementing the Sync v1 contract. |

Pinning a backend stores the association only — no data uploads until you
sign in and enable sync. See [Self-deploy](/docs/sync/self-deploy) for the
deploy path, [Conformance](/docs/sync/conformance) for proving a third-party
backend, and [Hosted](/docs/sync/hosted) for the state of the operated
service.

## Signing in and enrollment

Sign in from the panel, then enroll this device. The first device on an
account signs in directly; additional devices enroll with a short-lived
enrollment code issued from an already-signed-in device. Enrollment produces
a device-scoped credential — not your account password — that can be revoked
per device. Enrollment mechanics: [Devices](/docs/sync/devices).

## Devices

The Devices section lists every enrollment on the account: name, enrollment
id, age, and status. Rename a device (submitting an empty name clears it) or
revoke one. Revocation is account-scoped, ends that device's session
immediately, and is idempotent. The current device cannot be revoked from its
own UI — revoke it from another enrolled device to avoid stranding the
session.

Where you revoke matters. A revoke initiated in the app rotates the account
data key, so the revoked device cannot read anything written after rotation.
A revoke from the web account area severs the session only. Key rotation:
[Encryption](/docs/sync/encryption); roster mechanics:
[Devices](/docs/sync/devices).

## Remote executions

The Remote executions section lists jobs this account dispatched to enrolled
devices: source and target devices, placement explanation, and state. States
are labelled honestly — `Stopping…` while cancellation propagates, and
`Lost contact` when the outcome is genuinely unknown. Lost contact is never
presented as cancelled.

Expanding a job shows its attempts, each with a lease and worker incarnation.
On a live attempt, **Watch** streams activity: durable replay fills history,
live frames append, and gaps in the stream are marked rather than hidden.
Pending approvals show the action digest and expiry, and Approve/Deny only
appears where this device is actually permitted to decide. Job lifecycle and
placement rules: [Mesh jobs](/docs/sync/mesh-jobs).

## Running jobs on this device

The mesh worker is opt-in and device-local — the flag never syncs, so there is
no account-level "run jobs everywhere" switch. Enabled, this machine claims
account jobs it is capable of running; each attempt executes in an isolated
per-attempt worktree at the pinned commit and returns results as artifacts.
A headless daemon host mode exists for always-on mesh workers. Job execution
and sealed artifact storage: [Mesh jobs](/docs/sync/mesh-jobs) and
[Artifacts and shares](/docs/sync/artifacts-and-shares).

## Moving a session between devices

Session handoff starts in the run view, not in Settings. The ownership strip
under the agent map shows which device owns the session; **Move** lists
eligible devices and starts a handoff. Readiness is evaluated first — a dirty
tree or unpushed commits block with concrete remediation rather than failing
mid-transfer — then the source quiesces, captures an exact-commit checkpoint,
and ownership transfers at a fenced generation. No live process migrates; the
target resumes from the checkpoint. The protocol:
[Session handoff](/docs/sync/session-handoff).

## Your data

The Your data section exports every synced entity to a portable JSON document
and imports through a staged preview — creates, unchanged, conflicts, and
invalid entities are counted and listed before anything applies. Account
deletion is a durable operation with a visible status: it purges server-side
state and signs every enrolled device out. Formats and lifecycle:
[Data portability](/docs/sync/data-portability).

## What the backend can see

Synced payloads are sealed on your device before they leave; the backend
stores and replicates ciphertext and sees only the metadata replication
needs — entity ids and types, revisions, sizes, timestamps, session and job
records, and the device roster. The full envelope, key-wrapping, and
share-link story: [Encryption](/docs/sync/encryption).

For the architecture, contract, and threat model behind the panel, start with
the [Sync & Mesh overview](/docs/sync/overview). Current rollout state:
[Status and limits](/docs/sync/status-and-limits).
