---
title: Chat, canvas, and agent runs
navTitle: Chat and agent runs
description: Threads, providers, permissions, attachments, plans, canvas artifacts, agent activity, and handoffs in Anvil Desktop Chat.
product: Anvil Desktop
section: Core workspace
journey: build
order: 110
---

# Chat, canvas, and agent runs

Chat is the main workbench in Anvil Desktop. A thread belongs to a workspace and can carry repository context, a work item, a persona, provider state, a plan, a goal, attachments, artifacts, and the event history from one or more agent turns.

## Threads and context

Create a general thread or attach it to a work item. Work-item threads are grouped by their ticket so planning and implementation do not split into unrelated transcripts. A thread can reference more than one repository and has one active repository for actions that need a single target.

You can rename, settle, reopen, or delete a thread. Forking copies the conversation up to a selected point and asks the provider to fork its own thread when that provider supports it.

File mentions search the connected repositories. File and image attachments pass through the main process before the agent receives them. Check the visible repository chips and attachment list before sending a request that could change files.

## Providers, models, and reasoning

The configured primary provider starts new chats. Anvil supports Codex CLI, Cursor CLI, OpenAI API, and Azure AI Foundry routes. The model selector follows the provider, and reasoning effort is stored as a run control rather than buried in the prompt.

Codex, OpenAI, and Azure-backed sessions use the Codex app-server path. Cursor sessions use the local `cursor-agent` CLI. Availability therefore depends on local installation and authentication as well as saved settings.

Optional local models handle only eligible short helper prompts. Apple Foundation Models, Ollama, and LM Studio do not replace the agent runtime for repository tools, commands, approvals, or long-running turns.

## Permissions and live control

Each session starts with a permission mode:

| Mode | Expected boundary |
| --- | --- |
| Read only | Inspect and explain without changing files. |
| On request | Ask before file changes or commands that need approval. |
| Workspace auto | Work within the selected workspace under the provider's supported policy. |
| Full access | Use the provider's broadest supported local access. Review this choice carefully. |

While a turn runs, you can steer it with more context, interrupt the current work, or stop the session. Approval and input requests remain visible in the thread and Inbox. Approving an action should follow inspection of the command, path, permission, or requested data.

## Plans, questions, and goals

Provider events can become native Anvil UI instead of raw transcript text:

- plan intents show steps and accept progress patches
- question intents show structured choices and collect a resolution
- goals expose the current objective and progress state

These records persist with the thread. You can dismiss and restore supported intents without deleting their history.

## Canvas artifacts and annotations

Agents can produce persistent canvas artifacts, including Markdown, diagrams, HTML, documents, presentations, spreadsheets, code, data, and text. The canvas keeps these outputs separate from the conversational stream so they can be inspected and reused.

Artifacts can reference a file written under `.anvil/artifacts`. You can read the file, discard the artifact record, and attach annotations to a specific artifact. Annotations support create, update, and delete operations and should identify the concrete change needed rather than becoming a second chat thread.

Treat artifact previews as review surfaces. A generated plan or report is not proof that its commands were run, and a generated binary still needs layout or content checks appropriate to its format.

## Agent activity and fan-out

The activity pane separates the parent turn from delegated agent work. Subagent events show status and progress without forcing every internal event into the main conversation. The current execution topology can fan work out when the provider and task allow it, then settle child activity back into the parent turn.

Anvil records active sessions and recent agent runs so the Inbox, repository twin, sidebar indicators, and companion views can report work that continues outside the visible thread.

## Usage and completion

When the Codex CLI exposes usage limits, Anvil displays the current usage snapshot. This is informational and depends on what the installed CLI returns.

A good completed thread leaves a short result, changed files, checks run, failures or skipped checks, and remaining risk. Settle the thread when the work is genuinely done. Use [Agent workflows](/docs/desktop/agent-workflows) for planning, implementation, review, and handover patterns.
