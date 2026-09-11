PR #87 updated through commit adb0f0c.

Verified in the isolated native development instance:
- Failure capture → real repair thread → passing replay → fixture acceptance and export.
- Persistence after process restart.
- Live PR #87 metadata: link, refresh, reload, navigate both ways and unlink.
- Impeccable inspection of the linking popover and PR sidebar.

Validation: 779 tests passed, lint and production build passed. Independent review findings resolved. Explicit TypeScript checks retain baseline errors without new error pairs. Latest application CI passes; packaging checks remain running.

The PR remains draft. Full external Work Item dogfood, enforced autonomous repair permissions/budgets, clean-machine verification and measured delivery comparison remain outstanding. Automatic PR checkout, discovery and thread settlement are not included.