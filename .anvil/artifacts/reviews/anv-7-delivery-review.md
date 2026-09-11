# ANV-7 handover

PR: https://github.com/anthonyhumphreys/anvil-stack/pull/87
Commit: 656a9e94158057b45ee9cb67bcf26d4a6822f7fb

Implemented candidate/work-item identity handoffs, manual PR-to-evidence mappings, freshness checks, retained-worktree repair, workflow presets, actionable triage, deduplicated PR observations and isolated macOS preview packaging.

Validation:
- 742 tests passed; one optional browser integration skipped.
- Lint, production build and CodeQL passed.
- Independent code and Impeccable reviews completed; identified findings fixed.
- Unsigned DMG and ZIP built for the recorded commit.
- Existing TypeScript baseline errors remain.

Outstanding:
- Autonomous PR repair rounds and enforceable publishing permissions.
- Full Work Item-to-PR repair/replay dogfood.
- Native installation, interaction and recovery verification. UI inspection timed out.
- Human-effort, interruption, cost and regression measurements.

The PR remains draft and does not close ANV-7.