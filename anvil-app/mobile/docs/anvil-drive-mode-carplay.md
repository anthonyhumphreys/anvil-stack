# Anvil Drive Mode for CarPlay

Anvil Drive Mode is a constrained companion surface for supervising agents while away from the desk.
It is for awareness, interruption, safe delegation, and capture. It is not a mobile version of the
desktop app.

## What CarPlay Can Do

- Show grouped status for approvals, sessions, and items needing desktop review.
- Pause an individual session or pause all sessions. In the current implementation this maps to a
  safe interrupt of active Codex turns.
- Decline an approval.
- Approve an approval only when the host policy classifies it as low risk, explicitly allows
  CarPlay, and says no full review is required.
- Mark approvals for later desktop review.
- Capture parking-lot notes into Workspace Notes.
- Ask the paired desktop host to prepare a handover.

## What CarPlay Cannot Do

CarPlay never exposes code diffs, logs, terminal output, arbitrary prompts, shell execution, merge
actions, deployment actions, package publishing, migrations, secret changes, IAM changes, or
destructive file/repo actions.

Anything ambiguous, destructive, production-affecting, medium/high risk, or requiring context is
shown as:

```text
Requires desktop review
```

## Policy Gate

The policy lives in `src/shared/companion-policy.ts` and is enforced on the host API before approval
resolution. Native UI state is not trusted as the safety boundary.

The CarPlay approval rule is:

- `allowedSurfaces` includes `carplay`
- `risk` is `low`
- `requiresFullReview` is `false`

Unknown risk is treated as high risk. File changes require desktop review.

## Host API

The paired companion server exposes narrow CarPlay endpoints under `/api/carplay` using the existing
bearer token pairing model:

- `GET /api/carplay`
- `GET /api/carplay/approvals/:approvalId`
- `POST /api/carplay/sessions/:sessionId/pause`
- `POST /api/carplay/sessions/pause-all`
- `POST /api/carplay/approvals/:approvalId/approve`
- `POST /api/carplay/approvals/:approvalId/decline`
- `POST /api/carplay/approvals/:approvalId/later`
- `POST /api/carplay/notes`
- `POST /api/carplay/handover`

The event stream also emits companion events for sessions, approvals, notes, CarPlay actions, and
handover preparation.

## Workspace Notes

Parking-lot dictation lands in Workspace Notes. The desktop surface is available in the app sidebar
as `Workspace Notes`, where notes can be accepted or dismissed.

## Feature Flags

Native CarPlay files are generated only when:

```bash
ANVIL_ENABLE_CARPLAY=true
```

Siri Shortcuts/App Intents are generated only when:

```bash
ANVIL_ENABLE_SIRI_SHORTCUTS=true
```

Both flags are optional. The app should continue to build without either flag.

## Entitlements

Real CarPlay use may require Apple entitlement approval for the app identifier before it works on
device or outside local/simulator experimentation. The native plugin only adds the scene delegate and
template structure when enabled; entitlement approval remains an Apple provisioning requirement.

## Testing

Recommended checks:

```bash
pnpm test -- src/shared/__tests__/companion-policy.test.ts
pnpm test -- src/main/services/__tests__/mobile-companion-carplay.service.test.ts
pnpm --dir mobile typecheck
pnpm --dir mobile lint
```

For native experiments, prebuild with the flags:

```bash
ANVIL_ENABLE_CARPLAY=true ANVIL_ENABLE_SIRI_SHORTCUTS=true pnpm --dir mobile ios
```

When CarPlay is enabled the Expo app publishes the paired host connection and latest Drive snapshot
to the App Group. The CarPlay scene reads that state, refreshes `/api/carplay`, and invokes the same
narrow host actions as the mobile wrapper. Use a simulator or local CarPlay-capable development setup
where available. If entitlement support is missing, the JavaScript policy, host API, Workspace Notes,
and Siri/CarPlay source generation remain testable without runtime CarPlay attachment.

## Known Limitations

- Pause currently interrupts active turns rather than persisting a separate paused-session state.
- The native CarPlay scene is intentionally shallow and limited to status, approval detail, pause,
  decline, review-later, and handover actions.
- Full CarPlay runtime verification depends on Apple entitlement and simulator/device availability.
