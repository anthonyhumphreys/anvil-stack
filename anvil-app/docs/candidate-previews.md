# Candidate desktop previews

Dispatch **Anvil candidate preview** on the PR source branch, with the PR number and its full current head SHA. The workflow requires that SHA to match both its selected Git ref and the current PR head. It uses the selected ref's checkout and cache scope rather than checking out input-selected code in the default branch context. Fork branches that cannot be selected in this repository need a local build. The workflow uses read-only permissions and builds macOS arm64 and Linux x64 previews in one run. It retains separate platform artifacts for 14 days: macOS DMG and ZIP, Linux AppImage, `.deb` and `.pacman`, and a `preview-manifest.json` for each platform. It never publishes a release. A build failure remains a failed job; packaging failures also write a failure manifest. Dependency installation failures appear in the job log before a manifest exists.

For a local build, use a clean checkout on the target operating system:

```sh
# macOS
node scripts/build-candidate-preview.mjs 7 <full-head-sha> arm64 darwin
# Linux
node scripts/build-candidate-preview.mjs 7 <full-head-sha> x64 linux
```

The manifest records the PR, commit, build ID, platform, architecture and artifact SHA-256 digests. The workflow summary also lists the artifact checksums. CI checks Linux package names against the preview identity. Verify the downloaded artifact digest against the manifest before installing. These internal previews are unsigned. Developer ID signing and notarization are unavailable in this workflow, and macOS Gatekeeper acceptance is not claimed. Linux installation and desktop launch are also manual acceptance gates. A successful package build does not count as a successful native check.

The preview has a distinct app ID and app name. Linux previews also have a distinct package name and executable so installing one cannot replace the ordinary Anvil package. It does not register the normal app URL schemes, so installing or launching a preview cannot claim Anvil deep links or authentication callbacks. Before database startup, it selects a separate directory for its database, settings and Electron session data. On macOS this is `~/Library/Application Support/Anvil Preview/<buildId>`. On Linux it is `Anvil Preview/<buildId>` beneath Electron's application-data directory, normally `~/.config` or the configured `XDG_CONFIG_HOME`. It does not copy the normal Anvil profile or run automatic updates. Browser bridge discovery stays in `~/.anvil/previews/<buildId>/browser-bridge.json`, and previews cannot register or repair shared Codex browser MCP configuration. Background daemon installation, removal and reconciliation are disabled, so previews cannot replace or unload the normal Anvil LaunchAgent or Linux systemd user service. Each build gets a fresh profile, including rebuilds of the same commit. The build ID includes a random identifier so manual checks cannot silently carry across rebuilt binaries. Repositories explicitly added to a preview remain real repositories; terminal commands, integrations and external tools can still change their files and external state. Use a disposable checkout for verification.

Candidate previews target staging. Host-local Mesh sessions and the managed connector are available by default in all app builds, so testers need no feature flags. Sync still requires a signed-in active scope, and Mesh job execution requires a separate worker opt-in. The staging Worker must have managed provisioning enabled, and the host needs a trusted `cloudflared` binary. The resolver checks an explicit `ANVIL_CLOUDFLARED_PATH`, the packaged resource, `/opt/homebrew/bin/cloudflared` and `/usr/local/bin/cloudflared` on macOS, then `PATH`; it does not download the binary. The preview does not contain tunnel credentials.

## Native review

In Change Review, record the exact manifest build ID, commit, platform and architecture with the observed result. Include the operating-system version, installation limitations and which manual checks ran. Use `failed`, `unsupported` or `unavailable` where appropriate. Browser scenario success does not prove native behavior. Evidence is attached to the candidate head; a new head requires a new preview and new checks.

Check launch and restart, window/menu behavior, clipboard, file dialogs, terminal startup, and the changed Electron behavior. Confirm the preview starts with an empty workspace and normal Anvil's existing workspace is untouched. Record only what was observed, including skipped checks and reasons.

## Recovery exercise

No recovery exercise has been performed merely by adding this workflow. Before calling a native candidate verified, use a disposable preview profile to exercise restart after interrupted work, then uninstall and reinstall the same candidate. Confirm the app reopens the expected preview profile, review evidence still identifies its original commit, and the normal Anvil profile remains unchanged. Record the build ID, steps, observed results and any data loss in the native review notes. To reset a preview, quit it and move only its specific `<buildId>` directory aside. Keep the directory until the exercise is reviewed; do not remove the normal Anvil data directory.
