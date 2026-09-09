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

## Remaining evidence

Live Work Item/PR dogfood, controlled external review feedback, clean-machine native checks and a matched before/after delivery comparison remain pending. Foreground interaction estimates now measure part of review activity; they do not establish full journey effort, interruption counts, attributable usage/cost or escaped regression outcomes.
