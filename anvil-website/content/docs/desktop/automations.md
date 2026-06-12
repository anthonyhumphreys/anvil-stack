---
title: Automations
navTitle: Automations
description: Schedule recurring checks, run disposable worktrees, and wire automation output back into workspace evidence.
product: Anvil Desktop
section: Working guide
order: 116
---

# Automations

Anvil Desktop automations are scheduled or on-demand tasks that run against repositories and report findings back into the workspace.

## What automations can do

- Run a script on a schedule and record output.
- Create disposable git worktrees for isolated test runs.
- Scan dependencies and report drift or new vulnerabilities.
- Run test suites and record pass/fail trends.
- Check code quality metrics and record changes over time.

## Automation definition

An automation has:

- **Name and description** — What it does and why it exists.
- **Target repository** — Which repo to run against.
- **Command or script** — What to execute.
- **Schedule** — Cron expression or manual trigger.
- **Environment** — Working directory, env vars, and tool versions.
- **Output handling** — Where results are stored and how they surface in the workspace.

## Scheduling

Automations support two trigger modes:

| Mode | Use when |
| --- | --- |
| Cron | The task should run repeatedly: nightly dependency scans, weekly report generation. |
| Manual | The task runs on demand: pre-release checks, one-off audits. |

Cron expressions use standard Unix cron syntax. The automation daemon evaluates schedules and queues execution.

## The automation daemon

On macOS, the automation daemon can register with `launchctl` for background scheduling even when Anvil Desktop is not foreground. On other platforms, automations run while the app is open.

The daemon:

1. Evaluates cron schedules.
2. Creates disposable worktrees when configured.
3. Runs the command in a PTY-like environment.
4. Captures stdout, stderr, and exit code.
5. Writes results to SQLite and surfaces them in the Automations view.
6. Cleans up worktrees after a configured TTL.

## Disposable worktrees

Automations can run in a temporary git worktree so the main working directory stays untouched. This is useful for:

- Running tests on a clean checkout.
- Building release candidates in isolation.
- Running lint or format checks without polluting the current branch.

Worktrees are deleted after the automation run unless configured otherwise.

## Viewing results

Automation results appear in:

- The Automations view with pass/fail history.
- Workspace status when an automation has recent failures.
- Notifications when a scheduled run fails.

Each result includes:

- Exit code.
- Stdout and stderr excerpts.
- Duration.
- Git commit at time of run.
- Any artifacts produced.

## Limitations

- Automations run as the user who launched Anvil Desktop. They do not run in an isolated sandbox.
- Background scheduling on Windows and Linux is still being hardened. See the porting guide.
- Very long-running automations may be killed if the app is closed.
- Automations are not a CI replacement. They are a local convenience.

## Read next

- [Operating guide](/docs/desktop/operating-guide)
- [Companion surfaces](/docs/desktop/companion-surfaces)
