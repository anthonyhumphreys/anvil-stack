# Review performance pass

Implemented on `feature/review--performance-pass`, based on local `main` at `01cea7e`.
Worktree: `/Users/anthonyhumphreys/Code/anvil-worktrees/review-performance`.
The original checkout and its mobile changes were left untouched. No push or merge was performed.

## Changes

- Review Git helpers use asynchronous child processes. Diff gathering, commit and branch selectors, Azure DevOps PR ref resolution, verification ref resolution, impact analysis, repository indexing and map freshness checks now yield while Git runs. Existing timeouts, buffer limits and fallback behavior remain. Independent PR ref lookups run together.
- Code and security reviews save findings with one prepared insert inside one transaction. A failed batch rolls back instead of leaving partial findings. Existing single-finding APIs remain available.
- Schema migration 62 adds six indexes for repository history, running reviews and findings by review or audit. Both fresh installs and existing databases receive them. The migration preserves existing rows.

## Measurements

Run from `anvil-app` after restoring Node native bindings if the last command was an Electron build:

```sh
pnpm run rebuild:native:node
node --experimental-strip-types scripts/benchmark-review-persistence.mjs
```

The script creates and removes temporary WAL databases. Fixture: 20 repositories, 1,000 audits, 50,000 findings. Results below are medians of five samples on this machine, in milliseconds. Read samples average 50 operations; writes insert 200 findings per sample. Baseline uses the previous unindexed, individually prepared autocommit SQL pattern; optimized uses indexes and a transaction.

| Operation | Baseline | Optimized |
| --- | ---: | ---: |
| Fetch and severity-sort 50 findings | 1.148 | 0.043 |
| Fetch one repository's audit history | 0.057 | 0.032 |
| Save 200 findings | 3.377 | 0.378 |

These are SQLite measurements, excluding LLM latency and application rendering. They are not end-to-end review speedups. A separate regression test verifies that an event-loop timer runs while Git waits on an external diff.

## Verification

- Full suite: 109 files, 605 tests passed.
- `pnpm lint`: passed.
- `pnpm build`: passed, with a mixed static/dynamic import warning for the existing docs provider.
- `git diff --check`: passed.
- Main-process type checking reports 22 existing errors. Its output matches an untouched archive of `main` byte for byte with the same dependencies. No new type errors were introduced.
- Added coverage for Git scopes and missing refs, disconnected-history fallback, event-loop responsiveness, finding metadata and rollback, fresh-schema query plans and migration behavior.

## Limits and further profiling

The pass focuses on Desktop review paths and their shared services. It does not measure cloud, registry or website workloads. LLM prompts, concurrency limits and review coverage are unchanged.

Git diff parsing still runs in the main process after asynchronous collection. Profile large patches before moving parsing to a worker. Both review screens also reload complete history every 2.5 seconds while running; measure long-lived histories before changing the IPC contract to fetch only the active review. Those changes need representative UI measurements.

Index creation adds a one-time startup cost proportional to existing history, plus index storage and maintenance. Production user data was not opened or migrated during this pass.
