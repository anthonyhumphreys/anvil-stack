# Desktop settings and interaction fixes

Implemented on `develop` on 7 October 2026. The work was grouped into sidebar
and modal fixes, Markdown rendering, settings persistence, settings navigation,
and keyboard shortcuts so each group could be committed and checked separately.

## Issue coverage

| Issue  | Result                                                                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ANV-12 | Thread actions reserve a constant width; hover changes visibility without reflowing titles or summaries.                                                                                                                                 |
| ANV-29 | Command palette, Settings, terminal, new chat, and new workspace shortcuts have platform defaults and device-local customization, conflict checks, disable, and reset controls.                                                          |
| ANV-31 | The footer shows an actionable failed-connection notice instead of a healthy service count. The OS label in the supplied screenshot was already absent on develop.                                                                       |
| ANV-32 | Settings sections use Appearance & tools, Connections, Review preferences, Devices & local setup, and Setup & reset, with descriptions. Existing route IDs remain valid.                                                                 |
| ANV-33 | Settings uses vertical navigation in a wide content area and horizontal navigation in a narrow area, with an active-section indicator.                                                                                                   |
| ANV-34 | Shared settings sections use flat dividers and heading hierarchy. Advanced local AI, thread assistance, usage, and personal instructions expand on demand.                                                                               |
| ANV-35 | A sticky header shows saving, saved, or pending state and provides Save changes and Discard.                                                                                                                                             |
| ANV-36 | Saves contain only changed fields. Explicit clears remain in the patch; untouched masked secrets are omitted.                                                                                                                            |
| ANV-37 | Discard restores saved values and clears errors and stale connection results.                                                                                                                                                            |
| ANV-38 | Immediate preferences report their own saving/saved state, notify the app after success, and preserve unrelated drafts.                                                                                                                  |
| ANV-39 | Failed saves retain edits and report errors. Saves are serialized; a successful earlier save cannot mark a newer edit as saved.                                                                                                          |
| ANV-40 | Navigation, Back, onboarding preview, and window unload guard pending settings, personal instructions, and agent-limit edits. Native unload offers Keep editing or Discard and leave. Service shutdown waits until quitting is accepted. |
| ANV-41 | A primary-agent dropdown replaces the provider grid and explains that existing conversations retain their provider and model.                                                                                                            |
| ANV-42 | Additional workflow providers use an expandable checkbox list. The primary provider stays enabled; activation does not claim connection validation.                                                                                      |
| ANV-43 | Connection and model sections are adjacent. Local AI and thread assistance have separate expandable sections.                                                                                                                            |
| ANV-44 | Save and test connection saves the relevant fields first, stops on failure, shows progress/results, and ignores late results for edited inputs.                                                                                          |
| ANV-45 | Installing the Codex runtime refreshes provider status. Setup copy explains that model access and billing depend on the selected provider.                                                                                               |
| ANV-46 | Workspace action menus render in a viewport-positioned portal outside the scrolling sidebar.                                                                                                                                             |
| ANV-47 | Run setup controls stay within sidebar bounds; Escape closes the popup and restores the Run trigger. Failed saves retain the command.                                                                                                    |
| ANV-48 | The custom titlebar spacer applies only to macOS outside fullscreen. Windows and Linux use their native titlebars without that reserved gap.                                                                                             |
| ANV-49 | Create Workspace uses the shared modal with contained focus, Escape handling, and trigger-focus restoration. Initial onboarding still requires creating a workspace.                                                                     |
| ANV-50 | Work-item descriptions and acceptance criteria render through the existing safe Markdown component.                                                                                                                                      |

## Persistence decisions

- Credential forms require explicit saving. Ordinary preferences retain their
  existing autosave behavior; theme, role, and cloud toggles save immediately.
- Only the submitted snapshot becomes the saved baseline. Edits made during a
  write stay pending and can be saved or discarded afterward.
- Saving or testing one connector does not submit another connector's draft.
- Keyboard overrides stay on the current device in versioned local storage.
  Standard editing, window, settings-search, and workspace-switch shortcuts
  remain reserved.
- New-chat commands create the thread after navigation succeeds, so the settings
  guard can stop navigation before a thread is created.

## Verification

- Full Vitest suite: 257 files passed, 4 skipped; 2,101 tests passed, 12 skipped.
  The full run needed loopback access for existing server tests.
- Final focused renderer suite: 10 files and 58 tests passed.
- `pnpm lint`, renderer and main TypeScript checks, and `pnpm build` passed.
  The final main/renderer changes also passed `electron-vite build`.
- A disposable Electron session used the built renderer and preload with mocked
  IPC and blocked HTTP/HTTPS. Seventeen behavior checks passed with no renderer
  errors: save failure/retry, changed-field patches, edits during saves, Discard,
  section navigation and Back, personal instructions and agent limits, both
  responsive navigation layouts, menu positioning, modal focus, Run bounds and
  Escape, shortcut recording/use, late test failure suppression, and both native
  unload choices. The native message-box response was simulated.
- Wide and narrow settings screenshots were inspected. The UI detector reported
  no findings in changed TSX files.

## Remaining device and integration checks

ANV-48 still needs native Windows verification in restored and maximized windows
at supported display scales, including menu and dragging behavior. No Windows
host was available for this implementation.

Live provider authentication, billing, Codex installation, and remote connector
tests were not performed. The verification session used fixtures and did not
change real credentials or external integrations.
