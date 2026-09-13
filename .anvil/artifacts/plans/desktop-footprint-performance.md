Scope: Anvil Desktop. Excludes the mobile companion, Cloud, and Registry.

Prioritize package contents and startup loading first. Measure retained memory before changing session lifecycles.

Evidence and limits

The existing macOS arm64 app occupies approximately 620 MiB on disk. Electron frameworks account for 254 MiB, app.asar is 326 MiB, and unpacked resources occupy 39 MiB.

This packaged build is dated July 26 and does not establish the size of current source. The existing renderer output dated September 5 contains a 6.1 MiB entry chunk. Build sizes are not measurements of runtime memory.

The historical archive contains these notable dependency payloads:

| Package | Logical file size |
|---|---:|
| mermaid | 72.4 MiB |
| echarts | 55.7 MiB |
| lucide-react | 24.9 MiB |
| better-sqlite3 | 23.0 MiB |
| typescript | 19.0 MiB |
| @mermaid-js/parser | 10.6 MiB |
| @esbuild/darwin-arm64 | 10.1 MiB |

These are inspection targets, not guaranteed savings. Some packages are required at runtime; others may already be bundled into renderer JavaScript. The archive also predates dependency changes.

No running-app profiling, builds, or tests were performed. Memory leaks and percentage savings remain unproven.

1. Establish a reproducible baseline

Use a production build and an isolated profile with fixed repository and chat fixtures.

Extend the existing diagnostics in src/main/services/diagnostics.service.ts:74, which already collect main-process memory and Electron process metrics. Avoid creating a second diagnostics system.

Measure:

- Installed app size, compressed download size, archive contents, and renderer entry dependencies.
- Cold launch to usable workspace, with startup phases recorded separately.
- Memory and CPU after five minutes idle.
- Long-chat scrolling and streaming, repository mapping, document previews, and multiple terminals.
- Memory after repeatedly opening and closing tools and switching workspaces.
- External editor, agent, shell, and dev-server processes alongside Electron processes.

Report per-process memory consistently. A simple sum of RSS can count shared pages more than once.

Deliverable: a baseline report with fixture sizes, machine details, build revision, and repeated-run results.

2. Remove redundant package contents

Expected impact: high potential disk savings. Effort: medium.

electron-builder.yml:12 includes broad node_modules and scripts patterns. electron.vite.config.ts externalizes main and preload dependencies while bundling renderer code.

Audit the current packaged dependency tree against actual main, preload, helper, and CLI runtime imports. Separate renderer-only dependencies from packages that must remain installed at runtime. Remove redundant source distributions and unnecessary build assets through verified dependency classification and focused packaging rules.

Check Mermaid and icon packages first. Inspect the historical ECharts and esbuild payloads to establish whether current builds still contain them and why.

Preserve native binaries and their runtime support files. TypeScript is actively imported by src/main/services/repository-map-graph.service.ts:3, so moving it to development dependencies without another change would be unsafe.

Validation: launch the packaged app without access to repository node_modules. Exercise SQLite, PTYs, maps, Mermaid, document previews, speech helpers, and bundled CLI integration. Compare archive inventories before and after.

3. Reduce startup JavaScript and unnecessary startup work

Expected impact: startup time and initial memory. Effort: medium.

src/renderer/App.tsx:5 eagerly imports most feature screens. Workflows already uses lazy loading at line 48.

Extend that pattern to infrequently used screens. Load Mermaid at the preview boundary in ArtifactPreview.tsx and AdrMarkdown.tsx. Ensure shared imports do not pull deferred features back into the startup graph.

Preserve existing lazy loading for the repository garden and document viewers. Splitting code defers loading; it does not remove installed bytes or unload modules after use.

App.tsx:46 also imposes a 1,500 ms startup splash minimum. Replace that fixed delay with actual readiness once startup measurements confirm the flow.

Profile the main-process import graph and startup sequence in src/main/index.ts:310. Defer expensive optional service implementations and setup where justified, while preserving automation scheduling, recovery, and IPC availability.

Validation: compare launch timings and loaded chunks; test direct routes, tool windows, onboarding, and first use of deferred features.

4. Reduce memory retained by inactive tools

Expected impact: potentially high during long sessions. Effort: medium to high.

src/renderer/components/layout/Shell.tsx:153 keeps the editor mounted behind a hidden container. Profile memory before opening it, while active, and after navigation.

Consider mounting the editor UI on first use, then separating its persistent server/session from its webview lifetime. Add an explicit suspend or close path where state can be restored safely. Preserve unsaved buffers and active work.

Terminal sessions intentionally survive workspace switches. src/main/services/terminal.service.ts:11 already caps replay at 500,000 characters per terminal, but the session map has no aggregate memory budget. Account for replay, chunk-object overhead, renderer scrollback, and exited sessions.

Consider compact replay storage and bounded retention for exited terminals. Do not stop active shells merely because their UI is hidden.

Validation: repeated workspace/tool cycles should reach a stable memory range. Reattachment must preserve terminal sequence handling, editor state, and running jobs.

5. Keep long chats and previews responsive

Expected impact: lower peak memory and smoother interaction. Effort: medium.

ChatContext.tsx:133 already batches streaming updates every 80 ms. Profile before altering that cadence.

Inspect provider consumers and transcript rendering during long streams. If history dominates, paginate persisted history and window the rendered transcript while preserving search, selection, scroll position, and active output. Separate frequently changing state only where profiling demonstrates unnecessary renders.

ArtifactPreview.tsx:172 converts base64 content into binary buffers. Measure overlapping copies during large PDF, spreadsheet, and presentation previews. Release obsolete payloads and viewer resources promptly; consider bounded loading or a scoped file-serving path only if copies dominate peak memory.

chat/shiki.ts:101 already limits its cache. Its size calculation counts string lengths, despite the byte-oriented constant name. Calibrate the budget and consider loading grammars on demand if retained highlighter memory matters.

Validation: long transcripts, fast streaming, large previews, rapid navigation, and cancellation. Check both peak memory and recovery after closing a preview.

6. Address measured CPU stalls and idle work

Expected impact: responsiveness and battery use. Effort: medium.

repository-map-graph.service.ts:161 reads files synchronously and parses TypeScript in the main process. Existing graph limits help bound work, but do not prevent event-loop stalls.

Profile a large repository. If parsing blocks interaction, move the bounded parsing job to an on-demand worker, return compact results, and release it after completion. Preserve existing size limits and cancellation. A permanent worker could increase idle memory.

StatusBar.tsx:52 polls Git every five seconds; ChatView.tsx:329 and :354 also schedule refreshes. Pause presentation-only refreshes when hidden and deduplicate shared work across windows where useful. Keep background jobs independent of visibility.

RepositoryGarden.tsx:141 uses a Canvas with capped pixel ratio and a useFrame loop at line 1365. Measure stationary and hidden CPU/GPU use, then consider rendering only when the scene changes while preserving camera motion.

Validation: compare idle CPU, input latency during mapping, foreground refresh correctness, and garden interaction.

Delivery order

1. Baseline and current package inventory.
2. Verified packaging reductions.
3. Renderer lazy loading and splash readiness.
4. Inactive-tool retention changes.
5. Profile-driven chat, preview, and parsing improvements.

Deliver each as a focused change with before-and-after measurements. Run the relevant regression tests, the desktop test suite, and packaged smoke checks.

Set numeric budgets after obtaining the baseline. Require repeatable improvement beyond run-to-run variation, with no lost session state or material first-use regression.

Avoid an Electron replacement, blanket dependency removal, forced garbage collection, or global GPU disabling in this first pass.

The measurement-first approach and deferred loading follow Electron's official performance guidance:
https://www.electronjs.org/docs/latest/tutorial/performance