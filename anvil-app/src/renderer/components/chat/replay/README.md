# Native processing fixtures

Run the actual Anvil Electron app with a disposable profile from `anvil-app/`:

```sh
ANVIL_DEV_USER_DATA_PATH=/tmp/anvil-processing-preview \
ANVIL_DEV_PROCESSING_PREVIEW=1 pnpm dev
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

The provider selector changes display attribution. Protocol normalization for
the six supported providers is covered by `codex-protocol.service.test.ts`;
turn state and replay behavior are covered by `processing-state.test.ts`.

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
