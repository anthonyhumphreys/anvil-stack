---
title: Chat personas and LLM providers
navTitle: Chat and LLM
description: Configure AI providers, switch chat personas, and understand how Anvil Desktop grounds sessions in repository context.
product: Anvil Desktop
section: Working guide
order: 111
---

# Chat personas and LLM providers

Anvil Desktop chat sessions are not generic AI chats. They are grounded in repository context, work items, and the current branch state. The persona system shapes what the model optimises for, and the LLM provider configuration keeps credentials out of renderer code.

## Supported LLM providers

Anvil Desktop can route chat sessions through multiple backends:

| Provider | Setup path | Notes |
| --- | --- | --- |
| OpenAI API | API key in Settings | GPT-4o, GPT-4 Turbo, o1, o3-mini. Direct API calls from the main process. |
| Azure AI Foundry | Endpoint, key, deployment name in Settings | For organisations with Azure OpenAI deployments. |
| Codex CLI | Codex CLI installed and authenticated | Uses the local `codex` command through the Codex bridge. Good for agentic sessions that need local file access. |
| Apple Foundation Models | macOS 15.4+ with Apple Intelligence | Local on-device inference where available. No network call, no API key. |
| Local assists | Ollama or LM Studio when configured | Experimental. Useful for offline work or sensitive codebases. |

Credentials are stored encrypted in SQLite by the main-process settings service. The renderer never sees raw API keys.

## Configuring a provider

1. Open Settings in Anvil Desktop.
2. Choose the LLM provider tab.
3. Enter the required fields. API keys are masked after save.
4. Test the connection with the built-in ping.
5. Set the default provider for new sessions.

You can override the default per session by choosing a different provider in the chat header.

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
- Local models (Apple Foundation Models, Ollama) vary in capability. Use them for sensitive or offline work; verify important output with a stronger model when possible.
- Codex CLI sessions depend on the local `codex` binary and its auth state.

## Read next

- [Agent workflows](/docs/desktop/agent-workflows)
- [Operating guide](/docs/desktop/operating-guide)
- [Security and review](/docs/desktop/security-and-review)
