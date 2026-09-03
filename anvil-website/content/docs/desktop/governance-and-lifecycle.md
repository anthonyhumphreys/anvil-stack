---
title: Governance and lifecycle
navTitle: Governance and lifecycle
description: Organise governance documents, track delivery stages and gates, run impact analysis, and export handover packs.
product: Anvil Desktop
section: Governance
journey: reference
order: 120
---

# Governance and lifecycle

The Governance view combines a document register with a configurable delivery lifecycle. Both are scoped to the active workspace.

## Governance boards

A board is a named group for local governance documents. Create, rename, describe, or delete a board, then add files from disk and assign each document to a board. Documents can also remain unassigned.

Anvil stores the file path and board metadata. It does not copy the source document into a managed content system. Removing a document from the board removes its Anvil record, not the file on disk.

Use boards for bounded review contexts such as architecture, risk, or release evidence. Do not duplicate the same document across several boards to simulate a taxonomy.

## Lifecycle items

A lifecycle item records a delivery change. It can include:

- title and description
- standard, minor, or major change classification
- a linked work item and provider
- one or more linked repositories
- current stage
- gate decisions, impact analyses, and handover packs

The default stages can be changed per workspace. You can update their labels, order, and other supported stage configuration, or reset the workspace to the defaults.

## Gates and decisions

Gate templates define the evidence expected at each checkpoint. Readiness checks inspect the current lifecycle item against a selected gate and report missing or available evidence.

A recorded decision includes the gate, outcome, decision maker, and optional conditions or rationale. Decisions are durable workspace evidence. Record the actual reviewer and reason; a model-generated name defeats the audit trail with impressive efficiency.

Gate templates are configurable and can be reset. Changing a template affects future readiness checks. It does not rewrite past decisions.

## Impact analysis

Impact analysis runs against the linked repositories and chosen scope. It reports progress and stores the result with the lifecycle item. Run it again when the branch, repository links, or intended scope changes.

An analysis is only as complete as the indexed repositories and selected scope. External services, undocumented operational processes, and runtime-only behavior may need manual evidence.

## Handover packs

Anvil can generate a handover pack from the lifecycle item and its accumulated evidence. Generation reports progress by section. Stored packs can be reviewed and exported.

A useful pack names the change, repositories, linked work, decisions, review results, validation, skipped checks, and remaining risk. Export is the last formatting step, not a substitute for checking the evidence.

## Relationship to other tools

- Work Items owns ticket search and planning context.
- Code Review, Security, Dependencies, CI/CD, and Compliance produce specialist evidence.
- Governance boards organise source documents.
- Lifecycle ties a delivery change to stages, gates, decisions, impact, and handover.

Keep each fact in its owning system, then link or summarise it in the lifecycle record. Copying everything into governance creates a very complete stale document.
