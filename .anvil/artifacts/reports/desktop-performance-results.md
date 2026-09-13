Measurements compare fresh macOS arm64 builds. The baseline already included Strix removal.

| Measurement | Before | After |
|---|---:|---:|
| App bundle, logical size | 723 MB | 419 MB |
| App archive | 415 MB | 113 MB |
| Initial renderer JavaScript | 6.40 MB | 1.43 MB |
| Median onboarding readiness | 1.69 s | 0.11 s |
| Approximate onboarding JS heap | 24.5 MB | 10 MB |

Renderer results use three runs with fixed onboarding fixtures. They are not full-workspace startup or total application memory measurements. Removing the fixed splash delay accounts for much of the readiness improvement.

Implemented:

- Moved 22 bundled renderer libraries out of production Node dependencies, preserving resolved versions and required runtime packages.
- Limited packaged scripts to the runtime MCP helper.
- Lazy-loaded feature screens, Mermaid, syntax grammars, and the editor.
- Removed the fixed 1.5-second splash delay.
- Paused presentation polling in hidden windows and prevented overlapping requests.
- Changed the garden to render on demand.
- Added terminal replay limits across sessions without stopping active shells, plus diagnostic memory accounting.
- Retained decoded binary preview data instead of base64 strings.
- Corrected highlighting-cache accounting for UTF-16 payloads.
- Moved repository-map parsing into sequential, on-demand workers that exit after completion.

The 1,000-file parsing fixture previously blocked the main thread for 122–172 ms. Worker runs had about 1 ms median maximum event-loop delay, but took longer overall because of worker startup and data transfer.

Verification:

- Full suite: 595 tests passed, with targeted reruns after final corrections.
- Lint and production build passed.
- Packaged SQLite, PTYs, runtime imports, CLI files, MCP helper, and actual worker parsing passed smoke checks.
- Packaged onboarding rendered without console errors.
- Typechecking remains blocked by existing repository errors and unrelated mobile changes. Comparison against HEAD found no additional errors from this work.

Reusable measurement and smoke scripts are in anvil-app/scripts:
measure-footprint.mjs, profile-renderer.mjs, and smoke-package.mjs.

Live editor sessions and complete chat history remain preserved. Long-session leak detection, transcript pagination, and automatic editor suspension require further workload profiling; this pass does not claim those problems are solved.