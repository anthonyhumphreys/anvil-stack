# Candidate macOS previews

Dispatch **Anvil candidate macOS preview** on the PR source branch, with the PR number and its full current head SHA. The workflow requires that SHA to match both its selected Git ref and the current PR head. It uses the selected ref's checkout and cache scope rather than checking out input-selected code in the default branch context. Fork branches that cannot be selected in this repository need a local build. The workflow uses read-only permissions and retains a DMG, ZIP and `preview-manifest.json` for 14 days. It never publishes a release. A build failure remains a failed job; packaging failures also write a failure manifest. Dependency installation failures appear in the job log before a manifest exists.

For a local build, use a clean checkout on macOS:

```sh
node scripts/build-candidate-preview.mjs 7 <full-head-sha> arm64
```

The manifest records the PR, commit, build ID, platform, architecture and artifact SHA-256 digests. Verify the downloaded artifact digest against that manifest before installing. These internal previews are unsigned. Developer ID signing and notarization are unavailable in this workflow, and Gatekeeper acceptance is not claimed. A successful package build does not count as a successful native check.

The preview has a distinct bundle ID and app name. It does not register the normal app URL schemes, so installing or launching a preview cannot claim Anvil deep links or authentication callbacks. Before database startup, it uses `~/Library/Application Support/Anvil Preview/<buildId>` for its database, settings and Electron session data. It does not copy the normal Anvil profile or run automatic updates. Browser bridge discovery stays in `~/.anvil/previews/<buildId>/browser-bridge.json`, and previews cannot register or repair shared Codex browser MCP configuration. Background daemon installation, removal and reconciliation are disabled, so previews cannot replace or unload the normal Anvil LaunchAgent. Each build gets a fresh profile, including rebuilds of the same commit. The build ID includes a random identifier so manual checks cannot silently carry across rebuilt binaries. Repositories explicitly added to a preview remain real repositories; terminal commands, integrations and external tools can still change their files and external state. Use a disposable checkout for verification.

## Native review

In Change Review, record the exact manifest build ID, commit, platform and architecture with the observed result. Include macOS version, signing limitations and which manual checks ran. Use `failed`, `unsupported` or `unavailable` where appropriate. Browser scenario success does not prove native behavior. Evidence is attached to the candidate head; a new head requires a new preview and new checks.

Check launch and restart, window/menu behavior, clipboard, file dialogs, terminal startup, and the changed Electron behavior. Confirm the preview starts with an empty workspace and normal Anvil's existing workspace is untouched. Record only what was observed, including skipped checks and reasons.

## Recovery exercise

No recovery exercise has been performed merely by adding this workflow. Before calling a native candidate verified, use a disposable preview profile to exercise restart after interrupted work, then uninstall and reinstall the same candidate. Confirm the app reopens the expected preview profile, review evidence still identifies its original commit, and the normal Anvil profile remains unchanged. Record the build ID, steps, observed results and any data loss in the native review notes. To reset a preview, quit it and move only its specific `<buildId>` directory aside. Keep the directory until the exercise is reviewed; do not remove the normal Anvil data directory.
