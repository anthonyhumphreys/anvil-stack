---
title: Session handoff
navTitle: Session handoff
description: Moving a running provider session between devices — the durable state machine, readiness gates, the sealed checkpoint, ownership generations, and what resumes on the target.
product: Anvil Sync & Mesh
section: Concepts
journey: learn
order: 40
---

# Session handoff

Handoff moves ownership of a running session from the device that started it
to another enrolled device. It is a durable backend state machine, not a
tunnel: no process, socket, or memory image crosses the wire. The target
rebuilds the session from a sealed checkpoint.

## The state machine

```txt
requested
  -> target-prepared
  -> source-quiescing
  -> source-relinquished-and-checkpointed
  -> ownership-transferred
  -> target-activating
  -> completed        (or cancelled)
```

The record is durable on the backend, so a device going dark mid-handoff
leaves the state machine where it was rather than corrupting it.

## Readiness gates first

Readiness is evaluated before anything moves. A dirty working tree or
unpushed commits on the source **blocks the handoff** and reports concrete
remediation — commit or push, then retry — instead of failing halfway through
a transfer. The check exists because the checkpoint pins exact commits: a
target cannot materialize work the source never committed.

## The sealed checkpoint

When the source relinquishes, it captures a checkpoint: the session's
continuation state at an exact commit.

- The checkpoint body is sealed under the ADK like any synced payload —
  AES-256-GCM — with **AAD bound to the handoff id**, so a checkpoint swapped
  into a different handoff fails unseal.
- The two CAS fields stay clear — the content-addressed references the target
  needs to fetch the checkpoint body at all. Everything about the session
  itself is inside the seal.
- The target unseals the checkpoint **before rendering the continuation
  prompt**. A missing key version or a tampered body aborts activation before
  any provider call is made — a failed handoff never spends tokens.

## Ownership generations

Ownership transfers at a fenced generation: each handoff increments the
session's ownership generation, and stale devices acting on an old generation
are rejected. That is the split-brain defense — after transfer, the source
cannot keep driving the session even if it still believes it owns it. The
ownership strip in the run view shows which device holds the session.

## What "no live process migrates" means

The provider process on the source does not move. What moves is the ability
to continue:

- the source quiesces — durably rejects new input — and checkpoints;
- ownership transfers to the target at the new generation;
- the target prepares the workspace at the pinned commits and resumes the
  provider session.

How the resume looks depends on the provider: some providers support
**checkpoint import** (the session continues with its real state), others get
a **summary continuation** (a rebuilt prompt carrying what the checkpoint
says happened). The handoff record states which path was taken. Either way,
the user-visible contract is the same: the conversation continues on the
target, at the same commits, under new ownership.

## Using it

In the run view, the ownership strip under the agent map shows the current
owner. **Move** lists eligible devices — enrolled, reachable, capable of the
workspace — and starts the state machine. The full readiness evaluation runs
first; if it blocks, you get the reason and the fix, not a partial transfer.

## Current limits

- Backend state machine and sealed-checkpoint behavior are covered by tests;
  a physical device-to-device handoff demo is still pending.
- Resume fidelity is provider-dependent. A provider without checkpoint import
  gets summary continuation — functional, but it is a reconstructed prompt,
  not the original session state.
- A blocked handoff requires source-side cleanup (commit, push) before it can
  proceed. There is no "handoff anyway" — the checkpoint pins commits, so
  uncommitted work cannot cross.
