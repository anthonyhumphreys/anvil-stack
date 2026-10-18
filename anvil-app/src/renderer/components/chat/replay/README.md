# Native processing fixtures

Run the actual Anvil Electron app with a disposable profile from `anvil-app/`:

```sh
ANVIL_DEV_USER_DATA_PATH=/tmp/anvil-processing-preview \
ANVIL_DEV_PROCESSING_PREVIEW=1 pnpm dev -- \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows
```

Complete the welcome flow with **Continue without Sync** if prompted. The app
opens `/_dev/processing` inside its normal shell with the real preload, styles,
and transcript components. The preview flag requires an isolated development
profile. The fixture route and its content are excluded from production builds.
Isolated startup also skips shared Codex MCP and application protocol registration.

Use the provider and state selectors to inspect live work, approval waits,
completion, failures, interruption, sparse history, and initial activity. All
fixture content is synthetic; no agent run is started. Expand a turn and then
individual operations to check tool inputs, outputs, and command output. Approval
buttons exercise real IPC against a synthetic session, so inspect their layout
without submitting them.

**Chat interactions** opens a second native fixture with the production composer,
questions, approvals, provider input, plan decisions, tool requests and recovery
notices. **Compact pane** constrains the conversation to 740px. Dark and light
themes use the real application tokens. Sending and stopping use in-memory fixture
callbacks; decision forms use the real preload against synthetic request IDs, so
they return an error and retain the user's answers. No agent is started by a fixture.

The provider selector also applies the composer's provider rules. Codex, OpenAI,
Azure and LLMGateway offer Guide, Queue and a read-only side question. Cursor and
Devin offer Queue while work continues, with their own access options. These
fixtures do not connect to a provider or verify its credentials or plan.

Protocol normalization is covered by `codex-protocol.service.test.ts` and
`codex-agent-ui.adapter.test.ts`; turn state and replay behavior are covered by
`processing-state.test.ts`. Saved local chats also expose Anvil's `question_ask`
MCP tool across all providers and permission modes. It waits for the question
panel's response and returns structured answers directly. Native provider
questions continue through the same form when the provider emits them.

`agent-question.service.test.ts` covers provider contexts, answer types,
validation, duplicate submissions, cancellation, timeout and restart cleanup.
`agent-mcp-server.test.ts` covers request cancellation, disconnects and MCP
session deletion. Answer receipts persist in the conversation, with sensitive
native answers redacted. These checks verify the shared bridge; live provider
availability and end-to-end rendering still need a desktop check.

# Chat replay and inline surface fixtures

The standalone transcript replay (no Electron, no IPC) runs from `anvil-app/`:

```sh
pnpm exec vite --config scripts/chat-replay.vite.config.ts
```

Open `http://127.0.0.1:4179/` and pick a fixture. `Surface · …` fixtures cover
each inline surface kind (`chat-replay-surface-fixtures.ts`): a streaming
working-tree Review, Findings, Dependencies, Pipeline, Data with a chart, an
Artifact created then updated (the older surface collapses as superseded), a
Sketch, and a 30-surface heavy thread for the performance budget in
`docs/chat-replay-benchmark.md`. Use **Step** to watch a surface stream and
update in place, and the **Theme** selector for the dark, light and flavour
visual check. The preview entry (`dev-preview/main.tsx`) serves artifacts,
revisions, sketches and comments from memory; actions and sharing are inert.
`chat-replay.test.ts` validates every fixture payload against its kind schema.
