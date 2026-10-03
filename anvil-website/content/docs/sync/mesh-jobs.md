---
title: Mesh jobs and remote execution
navTitle: Mesh jobs
description: Create jobs against your account, let enrolled workers claim them on your own hardware, watch attempts live, and read job states that say what is actually known.
product: Anvil Sync & Mesh
section: Guides
journey: build
order: 60
---

# Mesh jobs and remote execution

A mesh job runs on a machine you enrolled, under your account, at commits the
job manifest pins. The backend dispatches and journals; your hardware
executes. Compute and provider credentials never leave your machines — the
backend never runs the job and never sees the provider keys.

This is provider-neutral infrastructure: codex/claude/cursor-style providers
plug in behind the same job contract.

## Job types

| Type | What it does |
| --- | --- |
| `start-session` | Spawn a provider session on a worker — the remote-run case. |
| `diagnostic` | Run diagnostics against a device or workspace and report back. |
| `prepare-workspace` | Materialize a workspace at a pinned revision so a later job or handoff starts warm. |

## How a job runs

1. **Create.** You create a job against the account — targeting a device or a
   set of requirements. The job carries a manifest pinning the workspace
   definition revision and the exact repository commits it needs.
2. **Advertise and claim.** Enrolled devices running the mesh worker advertise
   capability. A worker that satisfies the job's placement constraints claims
   it. Placement is checked before assignment: **capability** (can this
   device run this job at all) and **workspace readiness** (does it have what
   the manifest needs, or can it get it).
3. **Verify Git state.** Before spawning anything, the worker verifies the
   repository state matches the pinned commits. A drifted tree is a failed
   claim, not a job that runs on the wrong code.
4. **Execute in an isolated worktree.** Each attempt runs in its own
   per-attempt worktree at the pinned commit — attempts never share a working
   tree and never touch your checkout.
5. **Journal.** The attempt streams its journal as ordinary sealed entity
   changes: progress, output references, state transitions. Artifacts the job
   produces upload sealed — see
   [Artifacts and share links](/docs/sync/artifacts-and-shares).
6. **Integrate.** Results transfer back and integrate in dependency order;
   conflicts surface visibly rather than merging silently.

## Attempts, leases, incarnations

A job's attempts are first-class. Each attempt carries a **lease** — the
worker must keep renewing it or the attempt is presumed lost — and a **worker
incarnation** that identifies which worker process holds it. If a worker dies
mid-attempt, the lease expiry is what tells the account the attempt is gone;
nothing is declared finished on a heartbeat failure.

## Watching live

**Watch** on a live attempt streams activity with an honesty contract:

- durable replay fills the history up to the point you joined;
- live frames append as they journal;
- **gaps in the stream are marked, not hidden.** If the replay can't cover a
  span, you see the seam.

## Approvals

Pending approvals show the **action digest** — what the action will do — and
an **expiry**. Approve/Deny renders only where this device is actually
permitted to decide. An approval pinned to another device, or raised by this
device's own worker, shows what it is waiting on instead of offering buttons
that would no-op.

## Honest states

Job states are labeled by what is actually known:

- `Stopping…` while cancellation propagates — the request is in flight, the
  outcome is not yet known.
- `Lost contact` when the outcome is genuinely unknown — the worker stopped
  answering and the backend cannot say whether the work finished. It is never
  presented as cancelled.

If a UI ever shows "cancelled" for a job whose outcome wasn't confirmed, that
is a bug, not a state.

## Running a worker on this device

The mesh worker is opt-in and **device-local — the flag never syncs**.
Enabling it lets this machine claim account jobs it can satisfy; disabling it
stops new claims. There is no account-level "run jobs everywhere" switch:
every machine decides for itself, which is what keeps a laptop you forgot was
enrolled from picking up work.

## Job history

The Remote executions list shows source and target devices, the placement
explanation, and state — capped at the **most recent 100 jobs**. Older
history is not retained in the list; the attempt journals that mattered are
already entities.

## Current limits

- The dispatch/attempt/lease machinery is covered by worker and artifact
  suites and rehearsed on real deployments; a physical multi-device demo is
  still pending — treat cross-machine UX as unproven until the recorded run
  lands.
- Job history lists the most recent 100 executions.
- Worker opt-in is per-device by design; expect to enable it on each machine
  you want claiming work.
- Placement requires the manifest's workspace readiness — a job targeting a
  workspace the worker can't materialize will not run there.
