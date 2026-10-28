---
title: Agent workflows
navTitle: Agent workflows
description: How to plan, build, review, check security, write docs and hand over work with an agent in Mezair Desktop.
product: Mezair Desktop
section: Guides
journey: build
order: 70
---

# Agent workflows

Mezair Desktop is built around conversations about your code. A good one starts from the code and ends with evidence of what was done.

## Kinds of session

| Session | Use it for | What to keep |
| --- | --- | --- |
| Plan | Understand how things work now, find the files involved, map the acceptance criteria and choose a small way in. | Files inspected, assumptions, risks, proposed checks. |
| Implement | Make a focused change in one repository. | Diff summary, files changed, tests run, unresolved risk. |
| Review | Check changes or a branch for correctness, regressions, security, accessibility and missing tests. | Findings with file references, severity, and follow-up actions. |
| Security | Check auth, permissions, data handling, dependency risk, secrets and unsafe execution. | Findings, what's affected, how it could be exploited where useful, and what wasn't checked. |
| Docs | Write or update READMEs, architecture notes, decision records, setup docs and handover notes. | Source files used, claims made, commands verified. |
| BA | Compare what the work item asked for with what was built, including criteria, risk, dependencies and rollout. | Questions, gaps, feasibility notes, follow-up work. |
| Handover | Summarise what changed and what a teammate needs to know. | Change summary, checks, manual QA, skipped checks, residual risk. |

## A good loop for changes

1. Open the workspace.
2. Confirm the target repository, branch, and work item.
3. Ask how the code works today before asking for edits.
4. Keep the change scoped to the acceptance criteria.
5. Review the diff.
6. Run the narrowest meaningful checks.
7. Escalate to review, security, dependency, CI, or docs checks when the risk warrants it.
8. Record what passed and what was not verified.

Starting read-only isn't ceremony. It stops the agent confidently editing the wrong part of the code, which compiles fine and breaks production.

## Use different providers in one workflow

Settings separates your **primary** agent from the providers that are **active**:

- The primary provider starts new chats and handles app-level AI tasks.
- Active providers appear in each workflow step's provider selector.
- Each step stores its own provider and model, so planning, implementation, and independent reviews do not have to use the same runtime.
- Cursor's models come from your local `cursor-agent` install. You can type in custom Codex, OpenAI or Azure model and deployment names.
- Templates created before provider-aware workflows continue to use Codex unless you change the step.

Codex, OpenAI and Azure steps run through Codex with the model you picked. Cursor steps run through `cursor-agent`. If a saved step names a provider you've since turned off, the workflow stops and tells you.

An agent can also call another provider's CLI from a prompt when that's the simplest handoff. Workflow steps are better when you want the choice of provider to be visible, repeatable and saved with the template.

## Follow work across workspaces

Starting work in one workspace doesn't leave the rest of the app waiting:

- Active conversations continue when you switch workspaces.
- The activity centre shows running work and conversations waiting for approval or input.
- Desktop notifications open the originating workspace and exact thread.
- Completion notifications stay quiet while Mezair is focused; approval and input can still surface because they block progress.
- Workspace terminal processes and buffered output remain available while the desktop process is running.

Notifications take you to the work; they don't approve it. Open the thread and read the request in context before letting work continue.

## What to include in prompts

Good prompts include:

- target repository
- work item or acceptance criteria
- files or modules already suspected
- constraints such as no broad refactor, docs-only, tests required, or read-only
- validation expectations
- external systems involved, such as GitHub, Linear, Jira, Azure DevOps, Notion, Confluence, or Figma

Avoid asking the agent to "make it better" with no boundary. That isn't a requirement, it's a treasure map with no X.

## Review stance

Review sessions should lead with:

- correctness
- security and auth
- data integrity
- accessibility
- production risk
- missing tests

Maintainability and style matter, but they shouldn't bury a real blocker under opinions about naming.

## Handover quality

A useful handover says:

- what changed
- why it changed
- where it changed
- what passed
- what failed or could not be run
- what a reviewer should inspect first
- what risk remains

The aim isn't a prettier transcript. It's leaving enough context that the next person can carry on without digging.
