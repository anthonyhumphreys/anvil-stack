---
title: Automations
navTitle: Automations
description: Schedule recurring checks, run disposable worktrees, and wire automation output back into workspace evidence.
product: Anvil Desktop
section: Working guide
journey: build
order: 116
---

# Automations

Anvil Desktop automations run an agent prompt against one or more repositories. They start manually, on a cron schedule, or when Watchtower observes a matching workflow, pull request, or pipeline event.

## Automation definition

An automation stores:

- a name and agent persona
- the prompt to run
- one or more repository targets
- schedule or Watchtower trigger configuration
- whether the agent may write repository files or run commands
- an optional multi-persona loop and stop condition
- enabled state, timezone, last run, and next run

Every run uses disposable Git worktrees. The automation prompt is constrained to those paths and explicitly forbids pushes, pull requests, remote mutations, and external ticket, document, or comment creation.

## Schedules and Watchtower

| Trigger | Use it for |
| --- | --- |
| Schedule | Run from a cron expression in the selected IANA timezone. |
| Watchtower | Wait for a workflow completion or failure, pull request merge or close, or pipeline completion or failure. |
| Run now | Start the selected automation manually without changing its saved trigger. |

Workflow events come from Anvil's local workflow state. Pull request and pipeline watchers poll supported GitHub or Azure DevOps remotes. A pull request watcher needs a PR number; a pipeline watcher needs a pipeline name, workflow file, or run identifier.

The view shows the latest observed external state and any watcher error. An observed state change only starts a run when it matches the configured event.

## Background daemon

The automation daemon evaluates due schedules and pending Watchtower events outside the foreground window:

- macOS uses a user LaunchAgent through `launchctl`
- Linux uses a user `systemd` service when user services are available
- unsupported platforms fall back to the app process

The Automations view reports whether the daemon is supported, installed, and loaded. Reconcile it after changing platform configuration or the packaged application path.

## Disposable worktrees

Before a run, Anvil creates a dedicated branch and worktree for every target repository. The agent may only edit those worktree paths when write permission is enabled.

Clean worktrees are removed after the run. A worktree with changes is kept for review and appears in the run detail. This prevents an unattended run from mixing changes into the developer's current checkout while preserving work that needs inspection.

Disposable worktrees isolate Git state, not the operating system. An allowed command still runs as the user who launched Anvil.

## Agent loops

An optional loop assigns a list of personas, a maximum of one to eight iterations, and a stop condition. Sequence mode hands work through the personas in order. Dynamic mode lets the orchestrator decide whether a persona is useful for the current iteration.

Each member runs in a separate provider thread and receives the earlier thread outputs as handoff context. Use a small member list and a concrete stop condition. A vague loop is just an expensive way to rediscover ambiguity.

## Results and triage

The run detail has four views:

- Transcript composes the assistant's readable response.
- Activity groups thinking, file edits, commands, and tool calls.
- Worktrees lists the branch and retained state for each repository.
- Raw Events shows the stored event stream without presentation grouping.

Run history records trigger, status, assistant result, error, changed-file count, and worktree state. The triage list lifts failed or changed runs that need review. Notifications and Inbox activity can route back to the exact automation run.

## Limits

- Automations require the local Codex runtime and configured persona access.
- Command and write permissions are broad within the disposable worktrees. Review retained changes before merging them.
- Cancellation and failure do not reverse commands or external effects that already occurred.
- External Watchtower polling depends on local provider credentials and API availability.
- Automations complement hosted CI. They do not prove that a deployment pipeline passed.

## Read next

- [Operating guide](/docs/desktop/operating-guide)
- [Workflow graphs](/docs/desktop/workflow-graphs)
- [Companion surfaces](/docs/desktop/companion-surfaces)
