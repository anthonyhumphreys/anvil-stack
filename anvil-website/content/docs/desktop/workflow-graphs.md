---
title: Workflow graphs
navTitle: Workflows
description: Build reusable multi-step agent workflows, assign providers and models, run them against repositories, and inspect supervisor state.
product: Anvil Desktop
section: Automation
journey: build
order: 117
---

# Workflow graphs

Workflows turn a repeated agent process into a named graph. They are useful when a task needs explicit handoffs, independent review, or the same sequence across several repositories.

## Templates

A workflow template stores its name, description, nodes, edges, and visual positions. Every node has its own execution strategy. Create a template manually or ask the configured model to draft one from a plain-language request. Review drafted steps before saving because a plausible graph can still aim at the wrong repository or validation command.

Each step records its prompt and can select an active provider and model. This makes the runtime choice visible. A template fails plainly if a saved step references a provider that is no longer active.

## Execution strategies

The workflow contract supports four strategies:

| Strategy | Use it for |
| --- | --- |
| Focused | Keep the run on a narrow ordered path. |
| Adaptive | Let the supervisor choose the next useful handoff from current evidence. |
| Parallel | Run independent branches at the same time where the provider and thread limit allow it. |
| Review team | Ask separate reviewers to inspect the same work from different angles. |

Edges define the allowed handoffs. Parallelism is still bounded by the configured agent thread limit and provider behavior.

## Run a workflow

1. Choose a template.
2. Select the workspace repositories the run may use.
3. Write a kickoff that names the outcome and constraints.
4. Start the run and watch node status in the graph.
5. Open node output when a handoff needs inspection.
6. Ask the supervisor what is happening if the graph state is unclear.
7. Cancel the run if its assumptions or target are wrong.

Run history remains attached to the workspace. The workflow view can reopen a stored run and its node state. The Inbox also reports running, waiting, failed, and completed work when those states need attention.

## Providers and models

The primary provider is only the default for new chat and app-level drafting. Workflow nodes may use any active provider. Codex, OpenAI, and Azure nodes use the Codex app-server route with the selected model configuration. Cursor nodes use `cursor-agent` and its locally reported model catalog.

Mix providers when independent implementation and review are worth the extra setup. Do not add a second provider merely to make the graph look busy.

## Workflows versus automations

Use a workflow for agent reasoning and handoffs. Use an automation for a command or loop that should run manually, on a schedule, or when Watchtower detects a repository change.

An automation may launch agent-backed work, but it also owns disposable worktree execution, cron state, run events, and local scheduling. See [Automations](/docs/desktop/automations).

## Limits

- Workflow execution depends on the installed and authenticated provider tools.
- Cancellation asks the active run to stop; it cannot reverse file or external-system changes already made.
- A graph records coordination, not correctness. Review its output and run the repository's checks.
- Provider quotas and the configured concurrent-thread limit still apply.
