---
title: Data, governance, and evidence
navTitle: Data and evidence
description: How Anvil Desktop treats SQLite persistence, lifecycle gates, governance notes, and handover evidence.
product: Anvil Desktop
section: Assurance
journey: reference
order: 119
---

# Data, governance, and evidence

Anvil Desktop is local-first, but local does not mean casual. The app stores workspace state, repository metadata, connector settings, work evidence, review output, and workflow history in local persistence.

## SQLite persistence

SQLite is the desktop persistence layer. Schema, current version, and migrations live in `src/main/db/schema.ts`; startup and migration execution live in `src/main/db/database.ts`.

When persistence changes:

- add a new migration
- preserve old migrations
- update service behavior
- test the affected path where practical
- document any user-visible data migration risk

## Workspace state

Workspace state coordinates:

- active repositories
- provider connections
- selected roles
- preferences
- chat/session history
- review and security findings
- launch intents
- companion pairing state

Features should respect workspace state instead of inventing parallel global settings. Parallel state is how bugs learn to commute.

## Governance surfaces

Governance features should make lifecycle state visible:

- work item readiness
- acceptance criteria gaps
- impact analysis
- risk notes
- compliance checks
- release readiness
- handover packs
- follow-up ownership

Governance should not become paperwork theater. If a gate does not affect a decision, it is probably decoration.

## Evidence lifecycle

Evidence should move with the work:

1. Planning identifies files, assumptions, and risks.
2. Implementation changes code and records validation.
3. Review and security sessions produce findings.
4. Fixes update evidence and rerun checks.
5. Handover summarizes changed behavior, passed checks, skipped checks, and remaining risk.

The useful artifact is not the chat transcript. It is the reviewable summary with enough source references and command context to trust.

## Connector data

Connector configuration can involve provider tokens, issue metadata, repository state, and documentation systems. Treat those values as credentials or sensitive workflow data.

The renderer should not own secret handling. Main-process services and the preload bridge should keep privileged access behind explicit APIs.
