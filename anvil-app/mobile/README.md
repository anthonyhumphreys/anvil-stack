# Anvil Companion

Expo companion app for steering local Anvil desktop workflows from iPhone, iPad, Android,
WidgetKit live snapshots, and the generated watchOS target.

## What It Does

- Pair with the desktop Mobile Companion server by QR code or manual token.
- Review and resolve Codex approvals without opening the desktop app.
- Refresh from the desktop companion event stream when available, with foreground polling fallback.
- Launch one-tap workspace workflows: status sweep, code review, missing-test hunt, and ship handoff.
- Send custom prompts into the active workspace from the phone.
- Continue, summarise, or interrupt active desktop Codex sessions.
- Open the desktop app from the companion when a full-screen review is needed.
- Publish WidgetKit command-deck snapshots with workflow health, approval/session counts, and
  launch links for status sweep, review, test hunt, and handoff.
- Relay watch approvals, chat controls, interrupts, and workflow launches through WatchConnectivity
  and `anvil-companion://workflow/<action-id>` deep links.
- Provide Anvil Drive Mode contracts for CarPlay and Siri Shortcuts behind build flags. See
  [docs/anvil-drive-mode-carplay.md](docs/anvil-drive-mode-carplay.md).

## Commands

Run these from the repo root:

```bash
pnpm --dir mobile start
pnpm --dir mobile ios
pnpm --dir mobile android
pnpm --dir mobile typecheck
pnpm --dir mobile lint
```

The desktop app must have Settings -> Devices & system -> Mobile Companion enabled before pairing.
