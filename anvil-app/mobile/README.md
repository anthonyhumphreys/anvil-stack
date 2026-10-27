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
pnpm --dir mobile test:mesh-session
```

The desktop app must have Settings -> Devices & system -> Mobile Companion enabled before pairing.

## Account Mesh networking

Account connections share one host-session manager across screens. It prefers advertised direct
routes, prepares authenticated replay before changing an established route, and retains an old
connection while its pending requests settle. Commands are never automatically replayed after a
transport failure. Hosts must advertise `machine.stream-handoff/1` for proactive upgrades.
`EXPO_PUBLIC_ANVIL_MESH_ROUTE_UPGRADES=false` disables upgrades at build time while preserving
ordinary route selection and reconnects.

Native network hints come from `expo-network`, with a 15-second local-address sample while the
app is foregrounded and a host stream has consumers. Backgrounding cancels upgrade preparation
and sampling. The web build does not call the public-IP lookup API. A host's LAN address hint
does not prove the phone and host share a physical LAN; settings label it accordingly.

Local networking requires a new native build after these configuration changes:

- iOS declares its local-network purpose and allows local networking through ATS. Permission
  denial must leave managed HTTPS routes usable.
- Android's `withAnvilMeshNetworking` plugin enables cleartext HTTP/WS in the release manifest
  because dynamically discovered private IPs cannot be listed in static domain rules. The Mesh
  client independently restricts private HTTP origins, authenticates hosts, and encrypts session
  traffic. Account broker credentials still require HTTPS with normal certificate verification.

Config introspection verifies the generated settings; it does not verify device permissions or
release traffic. Before release, test iOS and Android builds without Metro: permission grant and
denial, LAN-to-cellular transitions, same-Wi-Fi address changes, background/foreground recovery,
and a pending command during a route upgrade. Offline broker admission remains out of scope.
