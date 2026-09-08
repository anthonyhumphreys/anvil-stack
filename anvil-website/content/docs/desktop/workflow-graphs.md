---
title: Workflow graphs
navTitle: Workflows
description: Coordinate agents across providers with specialist teams, bounded delegation, persisted handoffs, and human decisions.
product: Anvil Desktop
section: Automation
journey: build
order: 117
---

# Workflow graphs

Workflows turn a repeated agent process into a named graph. Each step has an instruction, persona, provider, model, and reasoning level. Edges make downstream steps wait for completed upstream work.

## From outcome to run

1. Describe the outcome and choose a delivery, review, or research starter, an existing template, or an AI-drafted flow.
2. Edit the steps and connections. Expand team settings when a step needs specialists.
3. Preview the graph. Preview does not start agents.
4. Select the workspace repositories and write the kickoff with constraints and expected evidence.
5. Choose Run. Anvil saves the configuration before starting, including a previously unsaved template.

Review generated steps before running them. A valid graph can still target the wrong repository or ask for the wrong checks.

## Specialist teams

Profiles name a specialist's persona, provider, model, reasoning level, and capabilities. A step can use an explicit subset of profiles; an autonomous step without a subset uses the configured pool.

| Strategy | Runtime behavior |
| --- | --- |
| Single agent | Runs the step's configured agent directly. |
| Map / reduce | Creates specialist tasks and asks the coordinator to combine their handoffs. Task instructions describe each share; Anvil does not partition files automatically. |
| Independent review | Specialists inspect independently before the coordinator reconciles their findings. |
| Debate | Specialists propose alternatives before the coordinator evaluates them. |
| Autonomous delegation | The agent requests tasks from the approved pool through a final delegation block. Anvil adds child nodes and calls the parent again to synthesise their results. |

Child tasks appear in the live graph. Providers can differ between the coordinator and specialists. Codex, OpenAI, and Azure steps use the Codex app-server route; Cursor steps use `cursor-agent`. Providers must be enabled and authenticated locally.

Older templates may retain focused, adaptive, parallel, or review-team execution hints. Those are provider instructions. The team strategies above are managed by Anvil's scheduler.

## Limits and handoffs

The default run policy allows one concurrent agent, 64 total nodes, delegation depth three, three attempts per step, and 30 minutes of wall-clock time. Team settings can change these within validated ranges. Delegation and parent synthesis consume the same bounded attempt budget.

Upstream handoffs include node and attempt references. Output is truncated to fit the configured handoff allowance; open the source thread when the full result matters.

All agents in a run share its execution workspace. Concurrent edits can conflict. Use concurrency one unless task scopes are independent. Anvil does not automatically integrate per-agent branches, enforce hard token or cost budgets, or turn a reported handoff into independent evidence. Provider-native delegation remains instruction-controlled.

## Inspect and intervene

Run history stores node state, attempts, events, provider details, errors, and handoffs. Select a node to inspect its attempts and open its thread. The supervisor can explain the persisted snapshot but does not silently modify the graph.

- Pause stops new dispatch. Active agents finish their current attempts.
- A human step waits for an accept or reject decision and an optional note. Resolve pending decisions, then resume the paused run.
- Retry queues a failed or interrupted agent step after inspection. Resume executes it, subject to its remaining attempt budget.
- Cancel stops further work and requests that active workers stop. It cannot reverse edits or external effects already made.

On recovery after an owning process exits, Anvil marks unfinished attempts as interrupted and pauses the run. It does not automatically replay uncertain work. Inspect the workspace before retrying. Resuming preserves the original deadline, including time spent paused.

Human workflow decisions record an operator's judgement. For acceptance tied to a specific source snapshot and replayed browser evidence, use [Change review](/docs/desktop/change-review).

## Scheduled workflows

An [automation](/docs/desktop/automations) can launch a saved workflow in its disposable repository worktrees. Configure both repository write and command permissions; restricted persona automations remain available separately. Workflow runs retain their worktrees for inspection and resume. Open a linked workflow from the automation's run details to resolve human steps.

Workflow-originated automation events are filtered to prevent a workflow automation from recursively triggering another automation through its own completion event.
