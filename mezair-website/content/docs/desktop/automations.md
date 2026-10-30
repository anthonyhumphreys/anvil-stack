---
title: Automations
navTitle: Automations
description: Run an agent on a schedule or when something happens, in its own throwaway worktree, and review what it did.
product: Mezair Desktop
section: Guides
journey: build
order: 150
---

# Automations

An automation runs an agent prompt against one or more repositories. It can start when you click **Run now**, on a schedule, or when Watchtower sees a matching workflow, pull request or pipeline event.

To take GitHub issues all the way to a confirmed merge under a reviewed policy, use [user-definable software factories](/docs/desktop/software-factories) instead. Factories are a separate feature, in beta through 30 November 2026, with their own issue lifecycle, merge modes and controls.

## What an automation contains

- a name and agent persona
- the prompt to run
- one or more repository targets
- schedule or Watchtower trigger configuration
- whether the agent may write repository files or run commands, and whether it may publish branches and pull requests
- an optional multi-persona loop and stop condition, or a saved workflow template
- enabled state, timezone, last run, and next run

Every run gets its own throwaway Git worktree. Persona automations are limited to those paths. Unless you enable publication, they are told not to push, open pull requests, change anything remote, or create tickets, documents or comments elsewhere. Workflow automations follow the chosen workflow's instructions and each provider's persona rules, and need permission to write files and run commands.

## Triggers

| Trigger | Use it for |
| --- | --- |
| Schedule | Run on a cron schedule in the time zone you pick. |
| Watchtower | Run when a workflow finishes or fails, a pull request is merged or closed, gets a review comment or changes head, or a pipeline finishes or fails. |
| Run now | Start it by hand without changing its saved trigger. |

Workflow events come from Mezair itself. Pull request and pipeline watchers check GitHub or Azure DevOps on a timer. A pull request watcher needs a pull request number; a pipeline watcher needs a pipeline name, workflow file or run ID.

The view shows the latest state it saw and any watcher errors. A change only starts a run when it matches the event you configured.

## Publishing branches and pull requests

**Publish branches and pull requests** is off by default, and you can only turn it on once repository writes and shell commands are allowed. It lets the agent push branches, open or update pull requests, and post related review comments in the selected repositories, using your existing CLI tools and provider access. It never grants merge, force-push or branch deletion.

The setting is an instruction to trusted workers, not a credential-isolation boundary. Your provider permissions still apply. A workflow launched by the automation keeps the publication grant from its kickoff, so editing the automation doesn't revoke a paused workflow's grant. Cancel the workflow, or narrow its execution access, to stop that work.

With publication on, pull request feedback can run automatically. Mezair re-reads the pull request and prepares an isolated checkout at the verified current head. It rejects stale or changed heads and unsupported fork targets rather than guessing. Feedback counts as task input, never as extra permission. An agent's report or a local commit doesn't show that publication succeeded; check the pull request.

## Running in the background

A small background service checks schedules and Watchtower events even when the app window isn't open:

- macOS uses a user LaunchAgent through `launchctl`
- Linux uses a user `systemd` service when user services are available
- elsewhere, the app itself does the checking while it's running

The Automations view shows whether the service is supported, installed and running. Reconcile it if you move the app or change system settings.

## Throwaway worktrees

Before a run, Mezair creates a dedicated branch and worktree for every target repository. The agent may only edit those worktree paths when write permission is enabled.

After a persona run, worktrees with no changes are removed. A worktree with changes is kept for you to review and shows up in the run details. That way an unattended run never mixes its changes into the checkout you're working in, and nothing worth reviewing is lost.

Worktrees keep Git state separate, not the operating system. Any command the agent is allowed to run still runs as you.

## Agent loops

A loop runs a list of personas for between one and eight rounds, until a stop condition is met. In sequence mode, work passes through the personas in order. In dynamic mode, the orchestrator decides which persona is useful in each round.

Each persona runs in its own thread and gets the earlier output as context. Keep the list short and the stop condition concrete. A vague loop is an expensive way to rediscover ambiguity.

## Launch a workflow

Select a saved workflow template to run it with the automation's prompt as its kickoff. A workflow template and persona loop cannot be combined in one automation.

Workflow agents use the prepared worktrees. Those worktrees are retained for inspection and for paused workflow runs, including runs waiting for a human decision. Open the linked workflow from run details, resolve its decisions, and resume there. The automation transcript records the workflow state when its scheduler stops; inspect the linked workflow for subsequent progress.

A workflow started by an automation won't trigger Watchtower when it finishes, so automations can't set each other off in a loop.

## Reviewing results

The run detail has four views:

- Transcript composes the assistant's readable response.
- Activity groups thinking, file edits, commands, and tool calls.
- Worktrees lists the branch and retained state for each repository.
- Raw Events shows the stored event stream without presentation grouping.

Run history records what triggered each run, its status, the result, any error, how many files changed and the worktree state. Failed runs and runs with changes rise to the top of the triage list. Notifications and the Inbox link straight to the run.

## Limits

- Persona automations require the local Codex runtime and configured persona access. Workflow automations require the tools and credentials for each selected provider.
- Command and write permissions are broad within the disposable worktrees. Review retained changes before merging them.
- Cancellation and failure do not reverse commands or external effects that already occurred.
- External Watchtower polling depends on local provider credentials and API availability.
- Automations sit alongside your CI. They don't prove a deployment pipeline passed.
- Automations never merge pull requests. Merge policy belongs to [software factories](/docs/desktop/software-factories).

## Read next

- [Operating guide](/docs/desktop/operating-guide)
- [Workflow graphs](/docs/desktop/workflow-graphs)
- [User-definable software factories](/docs/desktop/software-factories)
- [Companion surfaces](/docs/desktop/companion-surfaces)
