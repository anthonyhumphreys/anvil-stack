Fixed:
- Discovery now recognizes linked worktrees.
- Creation rejects existing branches instead of resetting them.
- Cleanup preserves dirty/locked worktrees and sibling directories.
- Review results retain paths when cleanup fails.

Still required:
- Persistent checkout bindings for threads, resume, and forks.
- Checkout-aware Git actions, terminals, prompts, file mentions, and artifacts.
- Protection against cross-thread canvas filename collisions.
- Recovery for partial automation worktree setup and cleanup.

Validation: 595 tests passed; changed-file lint and formatting passed. Live Electron/provider concurrency remains untested.