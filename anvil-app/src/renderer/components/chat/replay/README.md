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
