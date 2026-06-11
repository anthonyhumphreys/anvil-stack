# Porting Anvil to Windows and Linux

Anvil is an Electron desktop app, so the renderer and most main-process code should be portable in principle. The real work is not "make React run on Windows". The real work is packaging, native modules, shell/process handling, CLI discovery, editor integration, background automation, and enough QA that we are not shipping a desktop app held together by optimism and a YAML file.

This document describes what needs to be done to support Windows and Linux alongside the current macOS-focused distribution.

## Current State

The repository already has some cross-platform foundations:

- `electron-builder.yml` defines `win` targets (`nsis`, `portable`) and `linux` targets (`AppImage`, `deb`).
- The runtime already contains some `process.platform` handling for Windows in process termination, shell execution, and VS Code server paths.
- Native modules are rebuilt after install through `electron-rebuild -f -w better-sqlite3,node-pty`.
- The app uses Electron, React, SQLite via `better-sqlite3`, pseudo-terminals via `node-pty`, and external CLIs such as `git`, `gh`, `codex`, `repobase`, `bun`, `npx`, Docker, and VS Code.

The current release path is macOS-first:

- `package.json` only exposes macOS distribution scripts.
- `.github/workflows/release-macos-arm64.yml` only builds macOS Apple Silicon artifacts.
- `scripts/build-macos-arm64-anvil-notarized.sh` is macOS-only signing/notarization.
- Automation daemon support currently only installs on macOS via `launchctl`.

## Target Support Matrix

Recommended initial support:

| Platform | Architecture | Installer | Priority | Notes |
| --- | --- | --- | --- | --- |
| Windows 11 | x64 | NSIS and portable `.exe` | High | Start with x64 only. Windows arm64 can wait unless there is a real user base. |
| Ubuntu LTS / Debian-family Linux | x64 | AppImage and `.deb` | High | This matches the existing electron-builder config. |
| Other Linux distributions | x64 | AppImage | Medium | Treat as best-effort until tested. |
| Windows arm64 | arm64 | NSIS or portable | Low | Native module support and CI cost need proving first. |
| Linux arm64 | arm64 | AppImage or `.deb` | Low | Useful later, but do not make it the first hill to die on. |

## Packaging Work

### Add Distribution Scripts

Add explicit scripts to `package.json` so CI and developers do not have to remember raw `electron-builder` flags:

```json
{
  "scripts": {
    "dist:win:x64:anvil": "node scripts/dist.mjs --win nsis portable --x64 --publish never --brand=anvil",
    "dist:linux:x64:anvil": "node scripts/dist.mjs --linux AppImage deb --x64 --publish never --brand=anvil",
    "dist:all:x64:anvil": "node scripts/dist.mjs --win nsis portable --linux AppImage deb --x64 --publish never --brand=anvil"
  }
}
```

Keep the existing macOS scripts. Do not replace them with a single giant command until Windows and Linux are proven.

### Review `scripts/dist.mjs`

`scripts/dist.mjs` already forwards arbitrary builder arguments to `electron-builder`, so it should support `--win` and `--linux` without major changes. Confirm:

- Brand overrides apply to Windows and Linux.
- Anvil icon resources are valid for Windows and Linux.
- The default no-args path remains macOS arm64.
- The script works under PowerShell, Git Bash, and Linux shells.

### Icons

Current config uses:

- macOS: `resources/anvil.icns`
- Windows: `resources/anvil.png`
- Linux: `resources/anvil.png`

Windows installers normally prefer `.ico`. Add a Windows icon:

```text
resources/anvil.ico
```

Then update `electron-builder.yml`:

```yaml
win:
  target: [nsis, portable]
  icon: resources/anvil.ico
```

Linux can keep the PNG if it renders correctly in AppImage and `.deb` metadata.

### Signing

Windows and Linux signing are separate from macOS notarization.

Windows:

- Decide whether internal unsigned builds are acceptable.
- If signed builds are required, provision a code-signing certificate.
- Configure `electron-builder` signing through CI secrets.
- Test SmartScreen behaviour. A signed executable can still get warnings until reputation builds.

Linux:

- AppImage and `.deb` do not require signing in the same way.
- If publishing through an internal package repository, add repository signing later.

## CI Work

Add separate build jobs rather than stretching the macOS release workflow until it resembles a filing cabinet falling down stairs.

Recommended workflow shape:

- `build-windows-x64` on `windows-latest`
- `build-linux-x64` on `ubuntu-latest`
- Keep `release-macos-arm64` on `macos-15`

Each job should:

1. Check out the repo.
2. Set up Node using the repo-supported version.
3. Enable or install pnpm.
4. Run `pnpm install --frozen-lockfile`.
5. Run `pnpm lint`.
6. Run `pnpm test`.
7. Run `pnpm build`.
8. Run the platform-specific dist script.
9. Upload artifacts.

The existing macOS release workflow currently uses `npm ci`, while the repo is configured for pnpm and has a `pnpm-lock.yaml`. Standardise new Windows/Linux workflows on pnpm. Cleaning up the macOS workflow can be a separate task.

## Native Module Risks

Anvil depends on native modules:

- `better-sqlite3`
- `node-pty`

These are the highest-risk cross-platform dependencies.

Work required:

- Verify `pnpm install` runs successfully on Windows and Linux.
- Verify `electron-rebuild` rebuilds both modules for the Electron runtime on each platform.
- Confirm packaged apps load `better-sqlite3` and create/open the SQLite database.
- Confirm `node-pty` starts an interactive terminal on each platform.
- Add CI cache carefully. Native module caches are very good at preserving yesterday's mistake.

Windows-specific prerequisites may include Visual Studio Build Tools and Python if prebuilds are unavailable. Linux may need build essentials and Python depending on the runner and dependency versions.

## Runtime Compatibility Areas

### Shell Selection

Current default shell behaviour:

- Windows: `COMSPEC` or `cmd.exe`
- macOS/Linux: `SHELL` or `/bin/zsh`

Work required:

- Decide whether Windows should default to `cmd.exe`, PowerShell, or the user's configured shell.
- Test terminal creation through `src/main/services/terminal.service.ts`.
- Test shell command execution in code review and automation flows.
- Make command examples and generated prompts avoid assuming Bash when the active shell is Windows.

Likely improvement:

- Prefer PowerShell on modern Windows if it is available.
- Fall back to `cmd.exe`.
- Keep a user setting for preferred shell.

### PATH and Environment Discovery

`src/main/utils/fix-path.ts` improves GUI app PATH handling for macOS/Linux and currently returns immediately on Windows.

Work required:

- Confirm Windows packaged apps can find `git`, `gh`, `codex`, `npx`, `bun`, `docker`, and VS Code.
- Add Windows PATH probing if needed, including common install locations:
  - `%LOCALAPPDATA%\Programs`
  - `%ProgramFiles%`
  - `%ProgramFiles(x86)%`
  - Git for Windows paths
  - VS Code `bin`
  - npm global prefix
- Keep credential handling out of the docs and logs.

Linux work:

- Verify `fixPath()` behaves under desktop launchers, not just terminal-launched development mode.
- Confirm it handles common shells and package-manager paths.

### Process Termination

Some Windows handling already exists:

- Embedded editor uses `taskkill /PID <pid> /T /F`.
- Code-review and LLM process cleanup avoid Unix process-group killing on Windows.

Work required:

- Test cancellation of Codex sessions on Windows.
- Test cancellation of code review verification commands on Windows.
- Test embedded editor stop/restart on Windows and Linux.
- Add tests for Windows process cleanup branches where practical.

### Embedded Editor

The embedded editor is one of the riskiest runtime areas.

Existing platform-aware behaviour:

- User VS Code settings path handles macOS, Windows, and Linux.
- Cached VS Code server command uses `code-server.cmd` on Windows.
- External fallback opens `vscode://file/...` through Electron `shell.openExternal`.

Work required:

- Verify VS Code detection on Windows and Linux.
- Verify `code --version` returns a commit ID on each platform.
- Verify `serve-web` starts and renders inside Anvil.
- Verify cached VS Code web server paths under `~/.vscode/cli/serve-web`.
- Verify workspace snapshot `.code-workspace` files handle Windows paths correctly.
- Verify `vscode://file/<path>:<line>:<column>` works with Windows drive-letter paths. This is a likely bug source because URI encoding and drive letters love making everyone miserable.

### Automation Daemon

Automation daemon installation is currently macOS-only:

- `src/main/services/automation-daemon.service.ts` uses `launchctl`.
- `reconcileAutomationDaemon()` returns current status without installing anything on non-macOS platforms.

Work required:

- Decide whether background automation is required on Windows/Linux v1.
- If not required, document it as unsupported and keep the UI honest.
- If required:
  - Windows: implement Task Scheduler or a Windows Service strategy.
  - Linux: implement systemd user service support.
  - Add install/uninstall/status checks per platform.
  - Make failure messages explicit.

Recommendation: defer background automation for the first Windows/Linux build and ship foreground app functionality first.

### File Paths and Workspace Behaviour

Work required:

- Test adding repos from Windows drive-letter paths.
- Test UNC paths if network shares matter.
- Test paths with spaces.
- Test Linux paths under home directories and mounted drives.
- Verify file links in chat and editor views remain clickable.
- Verify repo indexing does not assume POSIX separators.

Use `node:path` APIs everywhere possible. Avoid string-splitting paths unless there is no sane alternative.

### External CLIs

Anvil calls several external tools:

- `git`
- `gh`
- `codex`
- `repobase`
- `bun`
- `npx`
- `docker`
- VS Code `code`

Work required:

- Add platform-specific diagnostics for missing tools.
- Make onboarding guidance platform-aware.
- Verify CLI invocation with spaces in paths.
- Verify authentication state for `gh`, `codex`, Azure DevOps, Confluence, and any MCP tooling.
- Avoid shell interpolation for user-controlled arguments. Use `execFile` wherever possible.

## Installer and App Behaviour

### Windows

Validate:

- NSIS installer runs without admin rights if possible.
- Portable build starts from a user-writable directory.
- App data lands under the expected Electron userData path.
- SQLite database can be created, migrated, and reopened.
- Windows Defender and SmartScreen behaviour is understood.
- Deep links/custom protocol handling works if Anvil relies on `open` links.
- Window chrome and titlebar affordances feel acceptable without macOS traffic-light assumptions.

### Linux

Validate:

- AppImage runs on Ubuntu LTS without extra system packages beyond expected desktop libraries.
- `.deb` installs cleanly and registers desktop entries/icons.
- App data lands under the expected Electron userData path.
- Sandbox/AppImage permissions do not block child processes or terminal spawning.
- Desktop launch has a useful PATH.
- Protocol handling works if needed.

## UX Adjustments

Areas to check visually:

- Sidebar titlebar spacing currently references macOS traffic lights in comments and layout assumptions.
- Status bar platform labelling already has platform-specific display logic; verify Windows and Linux labels.
- Keyboard shortcuts should use platform-appropriate modifier labels.
- Settings copy says "Follow macOS, Windows, or Linux light/dark mode"; verify the actual theme detection works on all three.
- Terminal UX should make the active shell obvious.

## Test Plan

Minimum platform acceptance:

1. Fresh install.
2. First launch.
3. Role selection.
4. Connector setup skip and configured paths.
5. Create workspace.
6. Add local repo.
7. Index repo.
8. Ask read-only chat question with file citations.
9. Run a small Codex task in a throwaway repo.
10. Open embedded editor.
11. Open terminal.
12. Run Git status and inspect diff.
13. Run code review.
14. Run security audit if dependencies are available.
15. Open Work Items if ADO is configured.
16. Restart app and verify state persists.
17. Uninstall and reinstall.

Package verification:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm run dist:win:x64:anvil
pnpm run dist:linux:x64:anvil
```

Run the Windows command on Windows and the Linux command on Linux. Cross-building Electron apps with native modules is technically possible in places and a hobby-grade source of pain in others. Build on the target OS first.

## Suggested Implementation Sequence

### Phase 1: Prove Development Mode

- Install dependencies on Windows and Linux.
- Fix native module rebuild issues.
- Run `pnpm dev`.
- Verify repo indexing, chat, Git, terminal, editor, and work items.
- Add platform-specific bug notes directly to this document.

### Phase 2: Prove Packaging

- Add Windows and Linux dist scripts.
- Add `resources/anvil.ico`.
- Build unsigned Windows and Linux artifacts locally or in CI.
- Launch packaged apps and verify SQLite/native module loading.

### Phase 3: Harden Runtime

- Fix PATH/tool discovery.
- Harden shell selection and terminal behaviour.
- Fix embedded editor path/URI issues.
- Make unsupported automation daemon states explicit.
- Add targeted tests for platform branches.

### Phase 4: Add CI and Release

- Add Windows and Linux CI jobs.
- Upload artifacts from workflow runs.
- Decide signing strategy.
- Publish internal builds only after platform smoke tests pass.

### Phase 5: Support Policy

- Document supported OS versions.
- Document required external tools.
- Document which features are platform-specific.
- Add a triage label for Windows/Linux issues.

## Known Likely Blockers

- `node-pty` rebuild or runtime loading failures.
- `better-sqlite3` rebuild or packaged native binding path issues.
- Windows PATH discovery for `codex`, `git`, `gh`, `npx`, and VS Code.
- Embedded VS Code server startup and `vscode://file` URI handling on Windows.
- Shell command assumptions in verification/code-review flows.
- Background automation daemon parity.
- Installer signing and Windows SmartScreen warnings.

## Definition of Done

Windows/Linux support should not be called done until:

- The app builds on target OS CI runners.
- Installers/artifacts launch on clean machines.
- Native modules load in packaged mode.
- Core workspace/repo/chat/Git/editor/terminal flows pass smoke testing.
- Platform-specific unsupported features are clearly labelled in the UI.
- Release artifacts are produced repeatably.
- The support matrix is documented and agreed.

Anything less is not a port. It is a screenshot with a calendar invite attached.
