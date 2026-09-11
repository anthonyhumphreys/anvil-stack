Both candidates are prepared in isolated worktrees. Unrelated checkout edits remain untouched.

| PR | Candidate commit | Tests | Lint / build |
| --- | --- | --- | --- |
| #84 | 16d7211 | 642 passed, 1 skipped | Passed |
| #86, including #84 | 87ab862 | 666 passed, 1 skipped | Passed |

Migration 63 adds review indexes and reconciles databases from development builds that reused version 62. Migration 64 adds the automation workflow association. Existing migrations through 62 remain unchanged.

Type checking still fails on existing main-branch errors. Neither candidate adds errors; #86 removes three.

Paid cross-provider workflow execution was not exercised end to end.

Local worktrees:
- /Users/anthonyhumphreys/Code/anvil-worktrees/pr84-merge
- /Users/anthonyhumphreys/Code/anvil-worktrees/pr86-merge

Pending: confirm main, push candidates, verify refreshed CI, then merge #84 followed by #86 using merge commits.