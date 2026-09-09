# ANV-7 verification record

## Connected browser fixture

On 9 September 2026, the browser runner and connected delivery integration tests passed locally with real Chromium, Git worktrees and SQLite. The connected test follows saved Work Item identity and PR mappings through a seeded mobile failure, finding, retained-worktree repair handoff, passing replay and explicit acceptance input. It closes and reopens the database twice and checks that the source checkout remains unchanged. Screenshots, traces and an evidence export are retained when an output directory is supplied.

The Work Item provider, PR visualisation and human decision inputs are fixtures. This verifies the service integration, not a live Linear/GitHub delivery task or actual human acceptance. The tests are skipped when the browser module directory is absent.

To repeat from `anvil-app`, provide a directory containing `node_modules/playwright` and its installed Chromium browser:

```sh
ANVIL_REVIEW_PLAYWRIGHT_ROOT=/path/to/browser-fixture \
ANVIL_REVIEW_QA_OUTPUT=/path/to/evidence-output \
pnpm exec vitest run --maxWorkers=2 \
  src/main/services/__tests__/change-review-runner.integration.test.ts \
  src/main/services/__tests__/change-review-delivery-journey.integration.test.ts
```

The connected test writes `connected-delivery-journey/evidence.json`, a fixture database and browser artifacts. Review output before sharing it; paths and local reviewer identity are included.

## Native observation

The unsigned arm64 preview for commit `656a9e94158057b45ee9cb67bcf26d4a6822f7fb`, build ID `pr-87-656a9e94158057b45ee9cb67bcf26d4a6822f7fb-darwin-arm64-c0feb18e433d4da487ecb6a68a96e7d6`, was inspected on the development Mac on 9 September 2026.

- The native window displayed fresh role/tool onboarding and no existing workspace.
- A disposable empty workspace named `ANV-7 preview verification` was created without attaching repositories or configuring integrations.
- After quitting and relaunching the same app, that workspace reopened and the Chat view loaded.
- The app's bundle URL scheme list was empty; its process used the build-specific preview data directory.

These observations apply only to that binary. They do not verify later commits, terminal execution, clipboard/file dialogs, clean-machine installation, Gatekeeper acceptance, signing/notarization, interrupted-work recovery or uninstall/reinstall recovery. The normal app was running during the exercise; its live database was not frozen for a byte-for-byte comparison.

## Native development journey, 9 September 2026

An isolated development instance of PR head `89a5c309`, followed by the native-test fixes, was exercised on macOS 26.6.2 arm64. A distinct Electron launcher and preview profile kept it separate from the user's running `main` instance. This is development-runtime evidence, not verification of a signed or distributed binary.

Using the native UI, the test selected `/tmp/anv7-native-fixture` through the folder dialog, created a workspace, entered local acceptance criteria and saved a five-step scenario: navigate, fill invalid input, submit, assert validation text and assert Retry visibility. The baseline passed; the candidate failed only on mobile. A finding was saved against that capture, and Request fix started a real linked repair conversation. That conversation removed the seeded mobile hiding rule in the disposable repository.

Returning to Change Review marked the old evidence stale. The saved scenario passed on replay, including the mobile Retry assertion. Both repaired captures were visually inspected; fixture-only finding and candidate acceptance were entered with a note explicitly excluding approval of PR #87. Evidence preview and Copy redacted evidence worked. After quit/relaunch, the repair conversation, two runs, finding and decision remained persisted.

Review ID: `a6f00a0d-5659-4b90-bd56-db95d77ad37d`. Failed run: `2e52e7ad-aec9-4944-a45c-02fd6c1ef8c4`. Passing replay: `f858d770-7961-4f84-9d4d-4b8dbf1e6835`. Repair thread: `d7fd1a8b-c3b9-4702-bd97-e139fd0f3eb8`.

The exported foreground interaction estimate was nonzero and persisted. These were automated UI interactions, so that value is not a human-effort measurement. The exercise exposed and drove fixes for shared preview browser MCP registration/discovery, ANSI formatting in assertion errors and stale freshness labels in mutation responses. The full suite passed 763 tests under the Electron Node runtime, with both browser integrations enabled.

This fixture has no external Work Item or PR. Native notifications, complete workflow dogfood, clean-machine install and interrupted-work/uninstall recovery are still separate checks.

## PR-to-thread native check

The isolated development instance also exercised durable PR linking against live GitHub metadata for PR #87. A separate four-file fixture, `/tmp/anv7-pr-link-fixture`, advertised the GitHub repository as its remote solely for this metadata test. It was not a checkout of the PR candidate. The original repository was connected but left unindexed and unchanged.

Native UI actions created an empty conversation scoped to the indexed fixture, linked PR #87, refreshed its draft status and observation timestamp, and preserved the association across renderer reload. Opening the PR displayed its linked conversation before diff loading completed; the backlink returned to the same thread. Explicit unlink removed the badge and association. No GitHub comments, pushes or PR changes were made by these UI actions.

The test exposed an unnecessary dependency on AI story generation for navigation. Thread links now open the diff, with linked conversations available independently of story generation and diff loading. Impeccable inspection covered the link popover and diff sidebar. Independent review also drove fixes for competing navigation requests, cancelled linked-thread creation and unsent threads incorrectly remaining busy.

The final feature suite passed 779 tests with both browser integrations enabled. Lint and the production build passed. Explicit typechecks retain baseline failures, with no new file/error-code pairs compared with the base archive. This verifies explicit associations, status refresh and navigation; it does not verify automatic PR checkout, branch discovery or thread settlement.

## Remaining evidence

Live Work Item/PR dogfood, controlled external review feedback, clean-machine native checks and a matched before/after delivery comparison remain pending. Foreground interaction estimates now measure part of review activity; they do not establish full journey effort, interruption counts, attributable usage/cost or escaped regression outcomes.
