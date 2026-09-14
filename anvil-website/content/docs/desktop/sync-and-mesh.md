---
title: Sync and Mesh
navTitle: Sync and Mesh
description: Account sync across devices, remote execution on enrolled machines, session handoff, data portability, and self-hosted backends.
product: Anvil Desktop
section: Specialist tools
journey: build
order: 121
kind: feature
---

# Sync and Mesh

Sync & Mesh is the account layer for Anvil Desktop. Sync replicates
account-owned entities — workspace definitions, workflow templates, editable
agents, and approved settings — across your devices. Mesh runs jobs on enrolled
devices: workspace preparation, provider sessions, and delegated workflow nodes.

Both are optional. Anvil works local-only by default, and the backend is
yours to choose: the contract is frozen and provider-neutral, so the same
desktop build talks to an Anvil-hosted deployment, your own Cloudflare account,
or any third-party implementation that passes the conformance suite.

This is alpha infrastructure. The architecture, contract, and lifecycle are
implemented and tested; the multi-device story has been rehearsed on real
Cloudflare deployments but not yet demoed end-to-end on physical hardware.

## Connection modes

Settings → Sync & Mesh offers four modes:

| Mode | Behavior |
| --- | --- |
| Local only | Nothing leaves the device. Any remembered backend is paused, not forgotten. |
| Anvil-hosted | Sign in to the operated backend. Currently unavailable in this build — the option is visible but disabled. |
| Your Cloudflare | Point Anvil at a Cloudflare Workers deployment you own (see [Self-deploy](#self-deploy)). |
| Compatible backend | Any URL implementing the Sync v1 contract — see [Conformance](#conformance). |

Pinning a backend stores the association and stops there — no data uploads
until you sign in and enable sync. Changing a backend's identity (endpoint or
issuer) requires re-review before credentials are sent again.

## Signing in and enrolling devices

Each device enrolls independently. The first device signs in directly;
additional devices enroll with a short-lived enrollment code issued from a
signed-in device. Enrollment produces a device-scoped credential — it is not
your account password and can be revoked per device.

Sync runs a push/pull loop accelerated by a live socket. When the socket is
down, fallback polling keeps converging; edits made offline queue in a local
outbox and sync when the backend is reachable. Conflicts never auto-overwrite:
divergent entities surface as conflicts you resolve explicitly.

## Devices

The Devices section lists every enrollment on the account: name, enrollment id,
age, and status. You can rename a device (submitting an empty name clears it)
or revoke one. Revocation is account-scoped, ends that device's session
immediately, and is idempotent — revoking an already-revoked device is a no-op.
The current device cannot be revoked from its own UI to avoid stranding the
session; revoke it from another enrolled device.

## Remote executions

The Remote executions section lists jobs this account dispatched: source and
target devices, placement explanation, and state. Job states are labeled
honestly — `Stopping…` while cancellation propagates, and `Lost contact` when
the outcome is genuinely unknown. Lost contact is never presented as cancelled.

Expanding a job shows its attempts, each with a lease and worker incarnation.
On a live attempt, **Watch** streams activity: durable replay fills history,
live frames append, and gaps in the stream are marked rather than hidden.

Pending approvals show the action digest and expiry. Approve/Deny controls
only appear where this device is actually permitted to decide — an approval
pinned to another device, or raised by this device's own worker, shows what it
is waiting on instead.

## Moving a session between devices

In the run view, the ownership strip under the agent map shows which device
owns the session. **Move** lists eligible devices and starts a handoff:

1. Readiness is evaluated first — a dirty tree or unpushed commits block with
   concrete remediation rather than failing mid-transfer.
2. The source durably rejects new messages, quiesces, and captures an
   exact-commit checkpoint.
3. Ownership transfers at a fenced generation; the target prepares the
   workspace and continues the provider session from the checkpoint.

No live process migrates. The target resumes via checkpoint import or summary
continuation depending on the provider — the handoff record says which.

## Running jobs on this device

The mesh worker is opt-in and device-local — the flag never syncs. Enabling it
lets this machine claim account jobs it is capable of running (capability and
workspace-readiness constraints are checked before placement). Each attempt
executes in an isolated per-attempt worktree at the pinned commit; results
transfer back as artifacts and integrate in dependency order with conflicts
surfaced visibly.

## Your data

The Your data section exports every synced entity to a portable JSON document
(`formatVersion`, `epoch`, `entities`) via a save dialog, and imports through a
staged preview: creates, unchanged, conflicts, and invalid entities are counted
and listed before anything applies. Apply is always explicit — an import never
silently overwrites divergent data.

Account deletion is a durable operation with a visible status; it purges
server-side state and signs every enrolled device out.

## Self-deploy

The `anvil-cloud` CLI deploys the official backend to your own Cloudflare
account:

```sh
anvil-cloud mesh plan --backend <path> --name <worker> --subdomain <sub>
anvil-cloud mesh apply --backend <path> --name <worker>
anvil-cloud mesh connection --name <worker> --base-url <url>
anvil-cloud mesh remove --backend <path> --name <worker>
```

`plan` generates a Wrangler config (Durable Object bindings, cumulative
migrations, R2 artifact bucket). `apply` deploys and waits for readiness;
secrets are provisioned after the first deploy. `connection` writes the
discovery file the desktop app consumes. `remove` regenerates its own config
before deleting so it never targets a stale worker name. All commands accept
`--json` for automation.

See the [CLI reference](/docs/cloud/cli-reference) for the full flag surface.

## Conformance

Third-party backends implement the frozen Sync v1 contract and prove it with
the shipped conformance suite:

```sh
pnpm conformance -- --url <backend> --admin-token <token>
```

The suite covers enrollment, sessions, push/pull, devices, data portability,
mesh jobs, and handoff — the same checks the desktop app relies on. A backend
that passes is a drop-in target for the Compatible backend mode.

## Current limits

- The Anvil-hosted mode is not yet offered; the option renders disabled.
- The two-device fan-out and handoff journey is automated end-to-end in tests
  and rehearsed against real deployments, but a physical multi-machine demo is
  still pending — treat cross-device UX as unproven until the recorded
  acceptance run lands.
- Remote execution job history lists the most recent 100 jobs.
- The mesh worker opt-in is per-device by design; there is no account-level
  "run jobs everywhere" switch.
