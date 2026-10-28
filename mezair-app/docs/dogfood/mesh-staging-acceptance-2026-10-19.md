# Sync and Mesh staging acceptance evidence — 19 October 2026

**Result: staging acceptance remains blocked.** This record captures sanitized,
read-only remote status and local tests. It does not claim a signed-in or
physical-device pass.

## Candidate and remote evidence

- Current checkout: `develop` at
  `112c12822491a75368bd9f1cb299a1b885aac1ee`. The working tree is modified;
  that SHA does not identify its uncommitted edits.
- Current staging backend: workflow run [#39230703438](https://github.com/anthonyhumphreys/mezair-stack/actions/runs/39230703438)
  completed successfully on the same SHA at `2026-10-19T09:31:23Z`. The public
  descriptor matched `mezair-backend/1`, `sync/2`, `mesh/2`, `workos-device`,
  absence of legacy `enrollment-code`, and the staging issuer and desktop client.
  This confirms the deployed commit and
  descriptor shape, not account sign-in or device acceptance.
- That deployed SHA predates the local capability-enforcement change; its
  committed descriptor advertises `browser-workspace/1` but not
  `mesh-job-capability-requirements/1`. Enforcement and the new descriptor tag
  are uncommitted and undeployed. Candidate clients must fail closed until a
  staging backend advertises the capability-requirements feature.
- Exact-SHA desktop preview for `develop` is unavailable. The latest preview
  found was run [#37632715813](https://github.com/anthonyhumphreys/mezair-stack/actions/runs/37632715813)
  on `7f7b09b2bb7c2a22beb1983ee0dedf65ec614b43`, so it is not a preview of the
  current checkout commit.
- Explicit `--pr 91` resolves PR 91 as **merged** at that same older SHA. Its
  nine checks passed; its historical staging workflow run #37632724336 and
  preview #37632715813 match that PR SHA. They are not evidence for the current
  `develop` candidate.
- GitHub reports the required staging secret **names** and expected Worker
  flags/domain configuration present. Secret values were not read. This check
  does not establish tunnel-token permissions or ingress connectivity.
- One `--ref feature/sync-mesh--foundations` read could not fetch the public
  descriptor and correctly returned BLOCKED; the later default and explicit PR
  reads passed. No persistent descriptor mismatch was observed.
- The sanitized status did not provide a Cloudflare Worker version identifier
  or the applied D1 migration list. Keep those two metadata fields open in the
  acceptance record.

## Local checks

- `node --test scripts/staging-status.node-test.mjs`: **PASS**, 8 tests. Covers
  candidate selection, dirty-tree separation, relation reporting, and fail-
  closed status summaries.
- `pnpm exec vitest run src/main/services/__tests__/mesh-host-wire.integration.test.ts`:
  **PASS**, 1 test. It exercised encrypted reads, a mutation, events, and cursor
  replay over a real loopback socket with synthetic broker/host fixtures. It
  does not use the staging account or public network.
- Historical pre-capability baseline: the earlier backend harness completed 42
  test files and 450 tests with local Cloudflare Vitest Worker bindings. The
  final full-suite result below supersedes that count.
- `pnpm test`: **PASS**, all 42 backend test files and 454 tests, including
  current-incarnation capability requirements for device, auto, and environment
  targets. Environment jobs wait until their linked worker qualifies; claims
  and retry claims recheck current capabilities. The `worker.describe` response
  omits the private incarnation stamp. Bindings were local test fixtures;
  development-only fixture auth was not used against hosted staging.
- `pnpm typecheck` in `cloud/backend`: **PASS**.
- The desktop SQLite suite was not run in this Node v24.10.0 / ABI 137 shell;
  no native modules were rebuilt. No isolated disposable staging profile for
  the exact current desktop candidate was available, so no hosted sign-in or
  account mutation was attempted.

## Acceptance gates

The later combined Desktop check ran the normal Node suite successfully: all
333 files passed, with 2,945 passing tests and 12 skipped. Native dependencies
were restored to Electron ABI 140 afterward. A fresh isolated app profile
migrated to schema v113 and passed SQLite integrity inspection. The locked Mac
prevented native window inspection. These local checks do not change the hosted
and physical-device gates below.

| Gate                                                                        | Result  | Evidence or blocker                                                                                       |
| --------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| Staging backend commit, base protocol, and candidate feature                | BLOCKED | `112c128…` passes the base protocol checks but does not advertise `mesh-job-capability-requirements/1`.   |
| Worker version and applied D1 migration inventory                           | BLOCKED | Not present in the sanitized preflight result.                                                            |
| Current desktop preview matching `develop`                                  | BLOCKED | No preview run for `112c128…`; latest preview is for `7f7b09…`.                                           |
| Website preview matching the candidate                                      | BLOCKED | No website preview SHA was verified in this run.                                                          |
| Disposable account sign-in and two active devices                           | BLOCKED | No exact-current desktop candidate or isolated disposable staging profile.                                |
| Sync in both directions across physical devices and separate WANs           | BLOCKED | Requires two physical hosts, a disposable account, and separate WANs.                                     |
| Mesh opt-in, read-only limit, approval, denial, and reconnect deduplication | BLOCKED | Loopback wire coverage is local protocol evidence only.                                                   |
| Revocation, re-enrollment, and recovery                                     | BLOCKED | Requires the hosted disposable account and physical devices.                                              |
| Managed endpoint allocation, real ingress, revocation, and cleanup          | BLOCKED | No live endpoint was allocated; the local harness does not prove provider access or public reachability.  |

Do not mark staging accepted while any required gate remains blocked. The next
required step is to produce a current desktop preview for the selected open
candidate, then run the hosted acceptance gates from
[`staging-acceptance.md`](../runbooks/hosted-sync/staging-acceptance.md) with a
disposable account and two physical devices on separate WANs.
