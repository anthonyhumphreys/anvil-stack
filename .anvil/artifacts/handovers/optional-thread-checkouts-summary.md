Open Context → Checkouts before starting a thread.

- Shared checkout remains the default.
- Select an existing feature checkout or create a worktree from main or another branch.
- Checkout selection persists across reloads and resume.
- Started threads keep their checkout; forks share it.
- Missing checkouts and branch drift produce recovery errors.
- Canvas writes cannot silently overwrite another thread’s artifact.

Validation: 614 tests passed, production build passed, and the Electron creation/reload flow worked. Typecheck diagnostics are unchanged from the baseline.

Automatic worktree disposal and automation partial-failure recovery remain outstanding.