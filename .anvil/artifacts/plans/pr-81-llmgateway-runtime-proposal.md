Reviewed PR 81 at `071f867` in a separate worktree created from `origin/main`, then checked out at the PR head. No application code changed.

## What the PR actually does

The coding path is:

Anvil → local Codex process → LLMGateway → selected model

Codex supplies the coding engine: running the agent loop, editing files, executing commands, and exchanging session and approval events with Anvil. LLMGateway supplies model access and billing. The model does not have to be an OpenAI model.

The PR launches `codex app-server` with process-specific provider configuration and passes the gateway key through the child process environment. It does not write those settings into the user's global Codex configuration. See [session startup](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/main/services/codex-session.service.ts#L160) and [provider configuration](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/shared/llm-gateway.ts#L5).

App-level LLM calls already use the gateway directly through the OpenAI-compatible SDK, without launching Codex. That distinction should stay. See [LLM client](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/main/services/llm.service.ts#L196).

## Does Codex need an OpenAI login?

No, for this custom-provider configuration. OpenAI documents provider-key authentication and says `requires_openai_auth` defaults to false. The PR supplies `LLMGATEWAY_API_KEY`. [Official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

LLMGateway also documents a successful Codex file-editing and test-running example using DeepSeek. So using a non-OpenAI model through Codex is supported in practice, although that does not establish compatibility with every gateway model. Current Codex uses the Responses API. [LLMGateway Codex integration](https://docs.llmgateway.io/guides/codex-cli)

## What needs fixing before release

1. **Installation is currently the user's problem.** Chat checks for a system Codex installation. If missing, the shared instructions tell users to sign in with ChatGPT, which is wrong for this route. See [installation instructions](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/main/services/codex-bridge.service.ts#L276).

2. **“Connected” does not mean ready to code.** Gateway status currently checks whether a key is stored and downloads model metadata. It does not validate the key or establish runtime readiness. See [connection status](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/main/services/llm-gateway.service.ts#L123).

3. **The model picker promises more than has been verified.** Filtering models by `tool_call` alone does not prove Codex compatibility. Reasoning settings, native web search, context limits, and multi-turn tool exchanges need matching to the chosen runtime. Workflow execution still resolves reasoning through Codex defaults without passing gateway model metadata. See [model filtering](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/main/services/llm-gateway.service.ts#L74) and [workflow turn configuration](https://github.com/anthonyhumphreys/anvil-stack/blob/071f867/anvil-app/src/main/services/workflow.service.ts#L490).

## Proposed implementation

1. Add an Anvil-managed Codex installation under application data. Download a pinned, tested platform binary with integrity verification, atomic installation, repair, and rollback. Users should not need npm, a global installation, or terminal setup. Allow an existing compatible installation as an advanced option.

2. Make chat, workflows, and automations use one runtime resolver for executable path, version compatibility, and readiness. A missing runtime should lead to the installation flow.

3. Keep gateway credentials and configuration scoped to Anvil's child processes. Explicitly disable OpenAI authentication for this provider. Use an isolated runtime configuration and state directory, with deliberate handling of Anvil's MCP and skill integrations.

4. Separate account status from runtime status. Show “LLMGateway connected” and “Coding engine ready” independently. Validate credentials before claiming connection success, and require both states before starting coding tasks. Direct LLM features should remain usable without the engine.

5. Validate a small initial model set across both billing modes. Derive supported settings from gateway metadata and runtime capabilities; omit unsupported reasoning fields and disable native web search unless verified. Supply appropriate context limits to the runtime rather than only displaying them.

Suggested onboarding copy:

> Anvil uses Codex as a local coding engine to edit files and run commands. Your selected model is accessed through LLMGateway and billed to your LLMGateway account. No ChatGPT account is required. Anvil installs and manages the coding engine for you.

Primary action: “Install coding engine”.

## Why not switch to OpenCode now?

OpenCode is a credible alternative. It has a built-in LLMGateway provider and a documented server and SDK integration. [Gateway integration](https://docs.llmgateway.io/guides/opencode), [OpenCode server](https://opencode.ai/docs/server/)

However, Anvil would need an adapter for its sessions, streaming events, approvals, cancellation, resume, and tool integrations. It would also need the same managed installation work.

I would reconsider OpenCode if representative gateway models fail the Codex compatibility checks, or if broad model support becomes the primary requirement. Installation and login alone are not reasons to replace the existing integration.

## Acceptance checks

- A clean machine with neither Codex nor OpenAI credentials can install the engine, connect LLMGateway, edit a fixture, and run its tests.
- Representative supported models complete multiple tool turns, approval flows, cancellation, and resumed sessions.
- Chat, workflows, and automations use the same managed executable and gateway configuration.
- Existing personal Codex settings and credentials remain untouched.
- Invalid keys, unavailable models, interrupted downloads, and incompatible binaries produce actionable errors.
- Direct LLM calls still work without the coding engine.

This was source and documentation analysis. I did not run the test suite or make live authenticated model calls. The PR's reported checks do not substitute for the clean-machine and model-compatibility checks above.