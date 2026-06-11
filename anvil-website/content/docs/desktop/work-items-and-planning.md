---
title: Work items and planning
navTitle: Work items
description: How Anvil Desktop brings Linear, Jira, Azure DevOps, BA notes, acceptance criteria, and implementation planning into repo-aware work.
product: Anvil Desktop
section: Working guide
order: 114
---

# Work items and planning

Work item context belongs next to code. Anvil Desktop treats tickets, acceptance criteria, branch state, implementation notes, and agent sessions as one delivery surface instead of five browser tabs and a prayer.

## Supported planning sources

Anvil is designed around provider-backed work item systems and local planning state:

- Linear
- Jira
- Azure DevOps
- GitHub pull requests and issues where relevant
- BA session notes
- acceptance criteria pasted into a session
- local follow-up tasks created from review or security findings

The exact connector surface depends on configuration. The important behavior is that planning work stays attached to the workspace and repository being changed.

## Planning flow

1. Select a workspace.
2. Open or import the work item.
3. Attach the relevant repository or branch.
4. Ask Anvil to inspect the current code path.
5. Compare implementation reality with acceptance criteria.
6. Identify dependencies, unknowns, risks, and likely files.
7. Decide whether the change is ready for implementation, needs a spike, or should be split.

## BA mode

BA sessions are useful when the work item needs clarification before implementation. They can identify:

- ambiguous acceptance criteria
- mismatches between expected and current behavior
- missing data, auth, accessibility, reporting, or compliance considerations
- implementation dependencies
- follow-up questions for product, design, or stakeholders
- likely test coverage

BA output should feed the work item or handover. If it only creates a second place to lose context, the tool has failed politely.

## Planning output

Good planning output includes:

- repo and branch inspected
- source files or modules likely involved
- assumptions
- decision points
- risks
- proposed implementation steps
- suggested validation
- follow-up work if the original item is too broad

## When to split work

Split the work when:

- acceptance criteria span unrelated modules
- one change touches data model, auth, UI, and release behavior at once
- a security finding needs separate review ownership
- a dependency or migration blocks safe implementation
- the implementation would require broad refactoring to make a small feature work

Anvil should make the split visible. It should not pretend one ticket is small because the heading is short.
