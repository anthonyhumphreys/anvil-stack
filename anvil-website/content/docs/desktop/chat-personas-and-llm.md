---
title: Chat personas, reasoning, and LLM providers
navTitle: Chat and LLM
description: Configure AI providers, switch chat personas, tune reasoning effort, and understand how Anvil Desktop grounds sessions in repository context.
product: Anvil Desktop
section: Working guide
journey: build
order: 111
---

# Chat personas, reasoning, and LLM providers

Anvil Desktop chat sessions are not generic AI chats. They are grounded in repository context, work items, and the current branch state. The persona system shapes what the model optimises for, reasoning effort controls how much work the Codex turn asks the model to do, and the LLM provider configuration keeps credentials out of renderer code.

## Supported LLM providers

Anvil Desktop can route chat sessions through multiple backends:

| Provider | Setup path | Notes |
| --- | --- | --- |
| OpenAI API | API key in Settings | Direct API calls from the main process for configured OpenAI models. |
| Azure AI Foundry | `~/.codex/config.toml` provider config plus the configured API-key environment variable | For organisations with Azure OpenAI deployments. The app reads the same provider config used by Codex. |
| Codex CLI | Codex CLI installed and authenticated | Uses the local `codex` command through the Codex bridge. Good for agentic sessions that need local file access. |
| Apple Foundation Models | macOS 26+, Apple Intelligence support, Apple Intelligence enabled; on macOS 27 the built-in `fm` CLI (after `sudo fm license`) or a Swift toolchain with `FoundationModels` | Optional on-device route for short helper prompts, including image attachments on macOS 27. No API key. Falls back to the configured backend when unavailable or unsuitable. |

Credentials are stored encrypted in SQLite by the main-process settings service. The renderer never sees raw API keys.

## Configuring a provider

1. Open Settings in Anvil Desktop.
2. Choose the AI settings section.
3. Pick Codex CLI, OpenAI API, or Azure AI Foundry as the Settings-level provider.
4. For OpenAI, enter the API key and model in Settings.
5. For Azure AI Foundry, configure `~/.codex/config.toml` and the environment variable referenced by its `env_key`.
6. Use the built-in connection test where the selected provider exposes one. Apple Foundation Models has its own **Test Apple Models** button.

The selected provider is a Settings-level choice. Chat turns can still change reasoning effort per turn, but there is no separate per-session provider picker in the chat surface.

## Reasoning effort

The chat input includes a reasoning effort menu for Codex-backed turns:

| Effort | Use it for |
| --- | --- |
| `none` | Fast responses where extended reasoning is not useful. |
| `minimal` | Trivial prompts that need a little structure. |
| `low` | Quick answers and lightweight edits. |
| `medium` | The everyday default for normal coding work. |
| `high` | Complex implementation, debugging, or review work. |
| `xhigh` | Slow, expensive reasoning for the awkward jobs that have started making eye contact. |

Anvil sends the selected effort with each Codex `turn/start` request. The global Settings page still exposes the older low/medium/high default for direct GPT-5.5-style API calls; the chat menu is the per-turn control for Codex sessions.

## Apple Foundation Models routing

Apple Foundation Models support is opt-in. In Settings, set **Apple Foundation Models** to **Prefer simple**, then use **Test Apple Models** to verify the route. The status card under the provider picker shows which backend is active, the model's availability reason, and which features this Mac supports.

On macOS 27, Anvil prefers the built-in `fm` command-line tool — a prebuilt binary, so calls skip the Swift toolchain entirely and start faster. Run `sudo fm license` once to accept its legal notice; until then Anvil falls back to a bundled Swift helper compiled on first use. On macOS 26 the Swift helper path is the only option, so a Swift toolchain that can import `FoundationModels` is required.

When enabled, Anvil tries the on-device model for plain chat messages — including image attachments on macOS 27 builds with the vision API — while slash-style commands and file attachments stay on the configured backend. The flow is deliberately conservative:

1. The normal Anvil chat session starts first. That still means the Codex CLI must be installed and authenticated for Codex-backed chat.
2. Anvil asks the Apple model to classify the prompt as `local` or `cloud`, using session instructions rather than prompt stuffing.
3. `local` is accepted only for short, self-contained prompts that need no repository access, file edits, command execution, web access, or deep multi-step reasoning.
4. If the classifier says `cloud`, fails, refuses, returns empty output, or the prompt is too large, Anvil sends the turn to the configured backend.
5. If the local answer is accepted, Anvil streams it through the normal chat event stream so the renderer displays and persists it like any other assistant reply.

## What the on-device model is used for

The Apple route exists for prompts where a cloud round-trip adds nothing:

- **Quick questions and explanations** — "what does `git rebase -i` do", "difference between `let` and `const`". Short answers stream in place like any other reply.
- **Rewording and summarising** — tightening a sentence, condensing pasted text, suggesting a clearer phrasing for a commit message or review comment.
- **Image questions on macOS 27** — attaching a screenshot and asking what it shows, when the installed build exposes the vision API.
- **Offline or privacy-sensitive prompts** — the request never leaves the Mac; nothing is sent to an API key or remote provider.

It is deliberately *not* used for repository-aware work: file reads, edits, commands, approvals, multi-step agent turns, and anything needing repo context always go to the configured backend. That boundary is a design choice, not a model limitation — the on-device model has no tools.

The Settings status card shows what this Mac can actually do: which backend is active (`fm` CLI or a compiled Swift helper), the model's availability state, its context size, and whether streaming, image prompts, and token counting are supported. If the `fm` legal notice is pending, the card shows the `sudo fm license` command to run once.

Local routing is not a replacement for agentic Codex work. It is useful for small wording, summarisation, or helper prompts where involving a larger backend would be theatre with an invoice.

## Thread titles and summaries

Threads start with a title taken from the first message (or the persona or work item that created them). Settings → AI → **Thread assistance** can instead generate a short title and a rolling one-line summary after each completed turn:

| Provider | Behaviour |
| --- | --- |
| Off | Default. Titles stay as the first-message text until you rename the thread. |
| Primary provider | Uses the configured agent model through the shared LLM gateway path. |
| Apple Intelligence | Uses the on-device model — free, private, and works offline. macOS only. |
| A connected provider | Uses any provider activated under **Agent providers** — pick a specific model from its catalog, or leave the provider default. |

Summaries appear under the thread title in the sidebar and are refreshed periodically as turns complete. Renaming a thread manually locks its title so assistance never overwrites it; the summary keeps updating.

Threads can also carry a **linked pull request** (the chain icon in the thread row). Linking attaches an existing GitHub or Azure DevOps PR to the thread by number — Anvil snapshots its state, watches for drift as the PR moves, and surfaces checks and review status from the chat surface instead of sending you back to the provider UI. Linked PRs are re-observed periodically, and when a linked PR is merged or closed the thread settles itself out of the active list.

## Chat personas

Personas change the system prompt and review priorities without changing the underlying model. They are a UX convenience, not a security boundary.

| Persona | Optimises for | Good for |
| --- | --- | --- |
| Coder | Implementation, file changes, test coverage, smallest safe diff. | Writing code, debugging, adding features. |
| Architect | Module boundaries, dependency direction, API contracts, migration paths. | Refactoring, new service design, tech debt decisions. |
| Security | Auth, permissions, data handling, secrets, injection risks, unsafe execution. | Security review, threat modelling, dependency audit. |
| Reviewer | Correctness, regressions, missing tests, readability, style. | Code review, PR preparation, handover notes. |
| Docs | README, ADRs, setup instructions, API docs, handover clarity. | Documentation, onboarding material, architecture notes. |
| BA | Acceptance criteria gaps, feasibility, risk, dependencies, compliance. | Requirements clarification, spike planning, impact analysis. |

Switch personas mid-session when the conversation changes from implementation to review, or from coding to documentation. The context window keeps repo state; the persona changes the lens.

## Prompt context

Anvil Desktop sends the model:

- The active workspace and repository list.
- Indexed module summaries for the target repo.
- Branch state and recent commits where relevant.
- The work item or acceptance criteria if linked.
- Any files the user explicitly referenced.
- Constraints such as "read-only", "no tests", or "docs only".

The model does not receive:

- Raw source code for the entire repo (that would exceed most context windows).
- Secrets, tokens, or connector credentials.
- Unrelated workspace data.

## Session types

Use the right session type for the work:

- **Plan** — Understand current behaviour before changing it.
- **Implement** — Make scoped changes with evidence.
- **Review** — Inspect diffs for correctness and risk.
- **Security** — Check auth, data, secrets, and dependencies.
- **Docs** — Generate or update documentation.
- **BA** — Compare intent with implementation.
- **Handover** — Summarise what changed and what remains unverified.

Read [Agent workflows](/docs/desktop/agent-workflows) for the full session playbook.

## Limitations

- Context windows still matter. Large repos need module summaries, not full file dumps.
- Personas do not change model capabilities. A security persona cannot make an unsafe model safe.
- Apple Foundation Models require macOS 26 or later, an Apple Intelligence-compatible Mac, and Apple Intelligence enabled. The fastest path on macOS 27 is the built-in `fm` CLI (one-time `sudo fm license`); otherwise a Swift toolchain that can import `FoundationModels` is needed.
- The Apple on-device model varies in capability and availability. Use it for sensitive or offline helper work where it fits, but verify important output with the configured backend when possible.
- Codex CLI sessions depend on the local `codex` binary and its auth state.

## Read next

- [Agent workflows](/docs/desktop/agent-workflows)
- [Operating guide](/docs/desktop/operating-guide)
- [Security and review](/docs/desktop/security-and-review)
