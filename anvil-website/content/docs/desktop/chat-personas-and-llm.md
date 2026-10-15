---
title: Chat, personas and models
navTitle: Chat and models
description: Connect AI providers, pick personas, set reasoning effort, and see what context Anvil Desktop sends to the model.
product: Anvil Desktop
section: Guides
journey: build
order: 60
---

# Chat, personas and models

Chat sessions in a workspace draw on your repositories, work items and current branch. A persona shapes what the model pays attention to, reasoning effort sets how hard it thinks, and provider credentials stay in the main process where the interface can't read them.

## Providers

| Provider | How to set it up | Notes |
| --- | --- | --- |
| OpenAI API | Add an API key in Settings | Calls OpenAI directly from the main process. |
| Azure AI Foundry | Configure a provider in `~/.codex/config.toml`, with its API key in the environment variable that config names | For teams with Azure OpenAI deployments. Anvil reads the same config Codex uses. |
| Codex CLI | Install Codex and sign in | Runs your local `codex` command. Best for agent sessions that need to read and change files. |
| Apple Foundation Models | macOS 26 or later with Apple Intelligence turned on. On macOS 27, the built-in `fm` tool (after `sudo fm license`) or a Swift toolchain with `FoundationModels` | Optional, on-device, for short helper prompts. Handles image attachments on macOS 27. No API key. Falls back to your main provider when it can't help. |

Cursor, Devin and LLMGateway are set up under **Agent providers**; see [Chat, surfaces and agent runs](/docs/desktop/chat-canvas-and-agent-runs).

Credentials are encrypted and stored in the local database by the main process. The interface never sees raw API keys.

## Set up a provider

1. Open **Settings** and go to the AI section.
2. Choose Codex CLI, OpenAI API or Azure AI Foundry.
3. For OpenAI, enter your API key and model.
4. For Azure AI Foundry, edit `~/.codex/config.toml` and set the environment variable its `env_key` points to.
5. Run the connection test if the provider has one. Apple Foundation Models has its own **Test Apple Models** button.

The provider you choose here is the default for new chats. You can still change reasoning effort for each turn from the composer.

## Reasoning effort

The composer has a reasoning menu for Codex-backed turns:

| Effort | When to use it |
| --- | --- |
| `none` | Fast replies where extra thinking won't help. |
| `minimal` | Simple prompts that need a little structure. |
| `low` | Quick answers and small edits. |
| `medium` | The everyday default for normal coding. |
| `high` | Hard implementation, debugging or review. |
| `xhigh` | Slow and expensive, for the genuinely awkward jobs. |

Anvil sends your choice with every Codex turn. The older low, medium and high default in Settings still applies to direct API calls; the composer menu is the per-turn control for Codex sessions.

## Apple's on-device model

The on-device model is opt-in. In Settings, set **Apple Foundation Models** to **Prefer simple** and click **Test Apple Models**. The status card shows which backend is active, whether the model is available (and why not), and what your Mac supports.

On macOS 27, Anvil uses the built-in `fm` command-line tool. It's a prebuilt binary, so it starts quickly and doesn't need Swift. Run `sudo fm license` once to accept its notice; until then Anvil uses a Swift helper it compiles on first use. On macOS 26 the Swift helper is the only option, so you need a Swift toolchain that can import `FoundationModels`.

When it's on, Anvil tries the on-device model for plain chat messages, including image attachments on macOS 27. Slash commands and file attachments always go to your main provider. The process is deliberately cautious:

1. The normal chat session starts first, so Codex still needs to be installed and signed in for Codex-backed chat.
2. Anvil asks the Apple model whether the prompt can be answered locally.
3. It only answers locally for short, self-contained prompts that don't need your repository, file edits, commands, the web or long reasoning.
4. If the answer is no, or the model fails, refuses, returns nothing, or the prompt is too long, the turn goes to your main provider.
5. A local answer streams into the chat and is saved like any other reply.

### What it's good for

- **Quick questions**, like "what does `git rebase -i` do?"
- **Rewording and summarising**, such as tightening a commit message or condensing pasted text.
- **Questions about a screenshot** on macOS 27, when the vision API is available.
- **Private or offline prompts**. The request never leaves your Mac.

It's never used for work that needs your repository: reading or editing files, running commands, approvals or multi-step agent turns. That's a deliberate choice; the on-device model has no tools.

The status card also shows the model's context size and whether streaming, image prompts and token counting work on your Mac. If the `fm` notice hasn't been accepted, it shows the command to run.

## Temporary chat

Press **Cmd+K** and choose **Temporary chat** for a throwaway conversation. You don't need a workspace or repository. The header marks it as temporary, and **End temporary chat** discards it.

The transcript and any unsent draft live in memory until you end the chat or quit. Temporary chats don't appear in your thread list, don't get automatic titles and aren't recorded in run history. They run in an empty folder, read-only, with no workspace, repository, governance or MCP context.

Temporary chat is text-only and works with providers that run through Codex. Cursor, Devin, attachments, pasted images and dropped files aren't available.

## Thread titles and summaries

A new thread is titled from its first message, or from the persona or work item that started it. **Settings → AI → Thread assistance** can write a short title and a one-line summary after each turn instead:

| Option | What happens |
| --- | --- |
| Off | The default. Titles stay as the first message until you rename them. |
| Primary provider | Uses your main agent model. |
| Apple Intelligence | Uses the on-device model. Free, private and works offline. macOS only. |
| A connected provider | Uses any provider you've turned on under **Agent providers**, with a model you pick or its default. |

Summaries show under the title in the sidebar and refresh as turns finish. If you rename a thread yourself, its title is locked; the summary keeps updating.

You can also link a thread to a pull request (the chain icon on the thread). Link a GitHub or Azure DevOps pull request by number and Anvil keeps track of it, showing its checks and review status in chat. When the pull request is merged or closed, the thread archives itself.

## Personas

Personas change the instructions and priorities the model works to, not the model itself. They're a convenience, not a security control.

| Persona | Pays attention to | Use it for |
| --- | --- | --- |
| Coder | Working code, tests and the smallest safe change | Writing code, debugging, new features |
| Architect | Module boundaries, dependencies, APIs and migration paths | Refactoring, designing services, tech debt decisions |
| Security | Auth, permissions, data handling, secrets, injection and unsafe execution | Security review, threat modelling, dependency audits |
| Reviewer | Correctness, regressions, missing tests and readability | Code review, pull request prep, handover notes |
| Docs | READMEs, decision records, setup steps, API docs | Documentation, onboarding, architecture notes |
| BA | Gaps in acceptance criteria, feasibility, risk and compliance | Clarifying requirements, planning spikes, impact analysis |

Switch persona mid-conversation when the job changes, say from building to reviewing. The thread keeps its context; only the lens changes.

## What the model sees

Anvil sends:

- the active workspace and its repositories
- indexed summaries of the relevant repository
- branch state and recent commits, when they matter
- the linked work item or acceptance criteria
- any files you mention
- constraints such as read-only, no tests or docs only

It doesn't send:

- your whole codebase (it wouldn't fit in the context window)
- secrets, tokens or connector credentials
- data from other workspaces

## Kinds of session

- **Plan**: understand how things work before changing them.
- **Implement**: make a scoped change and show the evidence.
- **Review**: check a diff for correctness and risk.
- **Security**: check auth, data, secrets and dependencies.
- **Docs**: write or update documentation.
- **BA**: compare what was asked for with what was built.
- **Handover**: summarise what changed and what hasn't been checked.

See [Agent workflows](/docs/desktop/agent-workflows) for how to run each one.

## Limits

- Context windows still matter. Large repos need summaries, not whole files.
- A persona doesn't change what a model can do. A security persona won't make an unsafe model safe.
- Apple Foundation Models needs macOS 26 or later, a Mac that supports Apple Intelligence, and Apple Intelligence turned on.
- The on-device model's quality and availability vary. Use it where it fits, and check anything important with your main provider.
- Codex sessions depend on your local `codex` install and sign-in.

## Read next

- [Agent workflows](/docs/desktop/agent-workflows)
- [Operating guide](/docs/desktop/operating-guide)
- [Security and review](/docs/desktop/security-and-review)
