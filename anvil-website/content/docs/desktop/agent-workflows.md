---
title: Agent workflows
navTitle: Agent workflows
description: How to run planning, implementation, review, security, docs, BA, and handover sessions in Anvil Desktop.
product: Anvil Desktop
section: Working guide
order: 112
---

# Agent workflows

Anvil Desktop is built around repo-aware conversations. A useful conversation starts from code and ends with evidence.

## Session types

| Session | Use it for | Evidence to keep |
| --- | --- | --- |
| Plan | Understand current behavior, identify files, map acceptance criteria, and choose a small implementation path. | Files inspected, assumptions, risks, proposed checks. |
| Implement | Make scoped code changes in a target repo. | Diff summary, files changed, tests run, unresolved risk. |
| Review | Inspect current changes or a branch for correctness, regressions, security, accessibility, and missing tests. | Findings with file references, severity, and follow-up actions. |
| Security | Check auth, permissions, data handling, dependency risk, secrets, and unsafe execution paths. | Findings, affected surfaces, exploit notes where useful, verification limits. |
| Docs | Generate or update README, architecture notes, ADRs, setup docs, and handover material. | Source files used, claims made, commands verified. |
| BA | Compare work item intent with implementation, acceptance criteria, risk, dependencies, and rollout questions. | Questions, gaps, feasibility notes, follow-up work. |
| Handover | Summarize what changed and what a teammate needs to know. | Change summary, checks, manual QA, skipped checks, residual risk. |

## A good implementation loop

1. Open the workspace.
2. Confirm the target repository, branch, and work item.
3. Ask for the current code path before asking for edits.
4. Keep the change scoped to the acceptance criteria.
5. Review the diff.
6. Run the narrowest meaningful checks.
7. Escalate to review, security, dependency, CI, or docs checks when the risk warrants it.
8. Record what passed and what was not verified.

The read-only first step is not ceremony. It prevents the model from confidently editing the wrong abstraction, which remains legal in TypeScript but rude in production.

## Follow work across workspaces

Starting work in one workspace does not make the rest of the app a waiting room:

- Active conversations continue when you switch workspaces.
- The activity centre shows running work and conversations waiting for approval or input.
- Desktop notifications open the originating workspace and exact thread.
- Completion notifications stay quiet while Anvil is focused; approval and input can still surface because they block progress.
- Workspace terminal processes and buffered output remain available while the desktop process is running.

Notifications are navigation, not approval shortcuts. Open the thread and review the request in context before allowing work to continue.

## What to include in prompts

Good session prompts include:

- target repository
- work item or acceptance criteria
- files or modules already suspected
- constraints such as no broad refactor, docs-only, tests required, or read-only
- validation expectations
- external systems involved, such as GitHub, Linear, Jira, Azure DevOps, Notion, Confluence, or Figma

Avoid prompts that ask the agent to "make it better" with no boundary. That is not a requirement, it is a haunted treasure map.

## Review stance

Review sessions should lead with:

- correctness
- security and auth
- data integrity
- accessibility
- production risk
- missing tests

Maintainability and style matter, but they should not bury a real blocker under opinions about naming.

## Handover quality

A useful handover says:

- what changed
- why it changed
- where it changed
- what passed
- what failed or could not be run
- what a reviewer should inspect first
- what risk remains

The goal is not to produce a prettier transcript. The goal is to leave enough context that the next person can continue without spelunking.
