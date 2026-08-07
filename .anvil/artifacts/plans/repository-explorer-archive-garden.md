# Repository Explorer and Archive Garden

Status: Proposed  
Target: `anvil-app`  
Visual direction: Archive Garden with dependency paths  
Scope: Production vertical slice

## Product outcome

Turn the repository map into a progressive source explorer that supports:

- Repository → module → directory → file → symbol drilldown.
- Change overlays down to affected files and symbols in pull requests.
- An alternate Three.js “Archive Garden” where users walk around the repository with WASD.
- Contextual conversations with modules through Anvil’s existing Chat, editor, security, and code-review capabilities.
- The existing manual/on-commit refresh policy across both views.

The garden is an alternate representation of the same indexed repository graph. It is not a separate index or decorative demo.

## Confirmed decisions

- Drilldown includes classes, functions, exports, and other useful symbols.
- The first Three.js release is a production vertical slice.
- Module conversations use a lightweight in-world context panel with one-click handoff to persistent Anvil Chat.
- The visual language combines Archive Garden buildings with dependency paths.
- Existing repository evidence controls all change, security, and technical-debt indicators.

## Experience design

### View switcher

The repository-map section gains a segmented control:

- **Map** — precise React Flow explorer.
- **Garden** — walkable Three.js repository world.

Both views share:

- Indexed commit and stale status.
- Manual/on-commit refresh setting.
- Refresh action and progress.
- Current repository scope.
- PR change overlay state.
- Selected module, file, or symbol where practical.

The 3D bundle is lazy-loaded only when Garden is selected.

### Progressive 2D drilldown

The 2D map shows one useful level at a time rather than rendering the entire repository graph.

1. Repository shows its modules.
2. Selecting a module opens its directories and top-level files.
3. Selecting a directory opens its children.
4. Selecting a file shows its indexed symbols.
5. Selecting a symbol opens its details and actions.

Navigation:

- Single click selects and opens the inspector.
- Double click or Enter drills into a node.
- Breadcrumbs return to any ancestor.
- Backspace returns one level when focus is not in an input.
- Search jumps directly to a module, file, or symbol.
- The inspector provides “Open in editor” and “Ask Chat”.
- Dependency highlighting can be toggled between incoming, outgoing, and both.

Symbols initially supported for TypeScript and JavaScript:

- Classes and interfaces.
- Functions and methods.
- React components where detectable.
- Named and default exports.
- Important top-level constants and types.

Other languages retain module, directory, and file drilldown until a language extractor is added. The UI states this plainly instead of pretending the file has no symbols.

### Archive Garden

The garden uses a fixed isometric camera and voxel-style geometry constructed from Three.js primitives.

| Repository concept | Garden representation |
|---|---|
| Repository | Entire garden estate |
| Module | Library, archive, workshop, or pavilion |
| Directory | Floor, wing, courtyard, or adjoining room |
| File | Reading room, shelf bank, exhibit, or worktable |
| Symbol | Book, artifact, desk, machine, or module terminal |
| Dependency | Stone path with restrained directional light |
| Recent addition | Fresh masonry and orange construction canvas |
| Recent modification | Active workbench or renovation light |
| Deletion | Faded foundation or temporary closed plot |
| Security finding | Guarded red lantern based on a real finding |
| Confirmed technical debt | Ivy, repairs, or patched shelving |
| Test area | Practice yard or proving ground |
| Entry point | Main gate or illuminated reception |

Dependency paths are functional:

- Selecting a building lights its direct incoming and outgoing paths.
- Direction is shown through subtle moving light or paving markers.
- Hovering a path identifies its source and destination.
- Interacting with a path opens the dependency in the context panel.
- Paths aggregate at module level and become more specific when exploring a building.
- The world never attempts to show every dependency simultaneously.

### Movement and interaction

Desktop controls:

- WASD or arrow keys: move.
- E or Enter: interact with the nearest module terminal.
- Escape: close the context panel.
- Mouse wheel: controlled camera zoom.
- Click: select a visible building or point of interest.
- Shift: optional faster walking, subject to motion settings.

The camera follows the avatar from a stable isometric angle. Collision is limited to building footprints, boundaries, and major scenery so movement remains predictable.

The avatar is a simple original voxel character, not a recreation of Gather Town artwork.

### Module context panel

Walking to a module terminal opens a side panel containing:

- Module purpose.
- Key files and entry points.
- Incoming and outgoing dependencies.
- Recent changed files and affected symbols.
- Existing code-review findings.
- Existing security findings.
- Index freshness and source commit.

Suggested actions:

- Explain how this module works.
- What changed recently?
- Show its dependencies.
- Look for security risks.
- Investigate technical debt.
- Open the key file.
- View this area in the 2D map.
- Continue in Chat.

“Continue in Chat” navigates to the existing Chat surface with a structured prompt containing the repository, selected node, relevant files, commit or PR context, and requested question.

The garden does not maintain a separate AI conversation history.

## Repository graph contract

Introduce a versioned graph shared by both views.

### Snapshot

`RepositoryMapGraph` contains:

- Schema version.
- Repository ID and indexed commit SHA.
- Generation timestamp.
- Nodes.
- Dependency edges.
- Index warnings and supported-language information.

### Nodes

`RepositoryMapNode` contains:

- Stable ID derived from repository-relative identity.
- Kind: repository, module, directory, file, or symbol.
- Parent ID.
- Name and repository-relative path.
- Purpose where available.
- File and symbol counts.
- Symbol kind and source range where applicable.
- Key-file and entry-point flags.
- Existing finding references.
- Optional change state.

### Edges

`RepositoryMapEdge` contains:

- Source and target node IDs.
- Kind: contains, imports, exports-to, or calls where confidently available.
- Resolution confidence.
- Optional source range.
- Aggregated edge count for module-level display.

Only resolved, repository-internal dependencies become garden paths. Package dependencies remain contextual metadata unless a later external-dependency district is deliberately designed.

## Indexing approach

Extend the existing repository refresh pipeline rather than adding another watcher.

### Structural extraction

- Reuse the current file and module discovery.
- Build directory and file nodes deterministically.
- Use the existing TypeScript package compiler API for TypeScript and JavaScript symbol extraction.
- Extract imports and exports while parsing each supported source file.
- Resolve relative internal imports to graph nodes.
- Aggregate file dependencies into module dependencies for zoomed-out views.
- Record extraction warnings per file without failing the complete map.

No additional parsing dependency is required for the first vertical slice.

### Persistence

Add a database migration after schema 48.

Persist the versioned graph snapshot as repository-owned indexed data, including:

- Repository ID.
- Indexed commit SHA.
- Graph schema version.
- Serialized graph.
- Generation timestamp.

A JSON snapshot is preferred initially because the graph is generated and replaced atomically. Security and review findings remain in their existing stores and are joined when the graph is requested.

The existing refresh modes remain authoritative:

- Manual stays the default.
- On commit uses the current background watcher.
- Refreshing replaces the snapshot only after successful extraction.
- A failed refresh leaves the last valid graph available and marked stale.

## PR and change overlays

Extend the existing change-summary contract with optional changed line ranges.

The Git service should obtain zero-context diff hunks and return:

- Old and new line ranges.
- Added, modified, deleted, or renamed status.
- Previous path for renames.

Overlay rules:

- Modules and directories aggregate descendant changes.
- Files receive their existing change status.
- Symbols are marked changed when a diff range intersects their source range.
- New exported symbols are explicitly marked as added.
- Deleted files remain visible as temporary tombstone nodes.
- Deleted symbols are shown only when base-revision symbol data is available; otherwise the file carries the deletion state.

In the PR view:

- Map and Garden use the same change overlay.
- Garden opens focused near the most changed module.
- Construction treatment marks added and modified areas.
- The context panel lists exact changed files and symbols.
- Selecting an item can open the existing code-review/editor route.

## Renderer architecture

Refactor the current component into a shared explorer surface:

- `RepositoryExplorer`
  - Owns view mode, scope, selection, breadcrumbs, search, and overlays.
- `RepositoryMap2D`
  - Evolves the existing React Flow implementation.
- `RepositoryGarden`
  - Lazy-loaded Three.js world.
- `RepositoryInspector`
  - Shared semantic content and actions.
- `repository-map-layout.ts`
  - Pure deterministic 2D layout.
- `repository-garden-layout.ts`
  - Pure seeded world layout and path routing.
- `repository-map-prompts.ts`
  - Structured prompts for Chat handoff.

Add:

- `three`
- `@react-three/fiber`

Avoid adding a general game engine. Movement, collision, layout, and interaction are intentionally narrow.

## Garden rendering strategy

- Use instanced meshes for repeated blocks, paving, shelves, foliage, and lights.
- Generate the world deterministically from repository-relative paths.
- Keep buildings within bounded plots so refreshed maps remain recognisable.
- Use simple geometry and procedural colour/material variation.
- Do not ship the generated concept images as runtime assets.
- Pause rendering when the view is hidden.
- Cap device pixel ratio.
- Reduce foliage, animated lights, and decorative objects on low-power mode.
- Apply level of detail so symbol objects appear only inside the selected building.
- Target smooth interaction on a typical Apple Silicon desktop with large repositories.

## Evidence and honesty rules

Visual markers must be backed by existing Anvil data:

- Security lanterns require an actual non-dismissed security finding.
- Review markers require a current code-review finding.
- Change construction requires Git diff evidence.
- Technical-debt decoration requires an existing classified finding.

When no technical-debt analysis exists, the module panel offers “Investigate technical debt” as a Chat or code-review action. The garden must not label an area as indebted based only on size, age, or aesthetics.

## Accessibility

The garden is optional; every action remains available from the 2D map.

Required behaviour:

- Complete keyboard operation in the 2D explorer.
- Keyboard and mouse support in the garden.
- Visible focus and interaction prompts.
- Text alternatives for every visual marker.
- Reduced-motion mode disables animated paths, bobbing, and camera easing.
- High-contrast change states do not depend on colour alone.
- Garden selection is mirrored in a semantic DOM inspector.
- If WebGL fails, automatically return to Map with a clear explanation.

## Delivery phases

### Phase 1 — Deep graph contract and indexing

- Add graph and source-range types.
- Extract directories, files, TypeScript/JavaScript symbols, imports, and exports.
- Persist a versioned graph snapshot.
- Extend existing refresh status and IPC.
- Add extractor, resolution, migration, and stale-snapshot tests.

Exit gate: a refreshed TypeScript repository returns a stable repository-to-symbol graph with resolved internal dependencies.

### Phase 2 — Progressive 2D explorer

- Refactor the existing Repository Map into `RepositoryExplorer`.
- Add breadcrumbs, drilldown, search, dependency highlighting, and shared inspector.
- Add editor and Chat actions.
- Preserve compact PR embedding.
- Add component and pure-layout tests.

Exit gate: users can navigate from repository to symbol without rendering an unreadable whole-repository graph.

### Phase 3 — Precise PR overlays

- Parse changed line ranges.
- Map ranges onto current symbols.
- Aggregate changes through ancestors.
- Add deletion and rename treatment.
- Reuse the overlay in repository and PR views.

Exit gate: a PR identifies changed modules, directories, files, and intersecting symbols with traceable Git evidence.

### Phase 4 — Archive Garden vertical slice

- Add lazy-loaded Three.js dependencies.
- Build deterministic garden plots, buildings, paths, avatar, camera, and collision.
- Add Map/Garden switching.
- Add change construction and evidence-backed findings.
- Add performance safeguards and WebGL fallback.

Exit gate: users can walk between modules, follow highlighted dependency paths, and inspect real repository state.

### Phase 5 — Module conversation and Anvil handoffs

- Add the in-world module context panel.
- Add suggested questions and custom prompt entry.
- Hand off to persistent Chat with structured repository context.
- Connect editor, code review, security, and 2D map actions.

Exit gate: a user can walk to a module, understand its current evidence, and continue the investigation through existing Anvil tools.

### Phase 6 — Verification and polish

- Unit-test extractors, graph aggregation, change-range matching, layout, and prompt construction.
- Component-test navigation, accessibility, fallbacks, and refresh states.
- Run focused tests, full test suite, lint, and production build.
- Manually verify small, medium, monorepo, stale, empty, unsupported-language, and large-repository states.
- Verify both repository and PR contexts.
- Check keyboard-only and reduced-motion flows.

## Acceptance criteria

- Users can drill from repository to supported symbols and return through breadcrumbs.
- Unsupported symbol languages degrade to file-level exploration with an explanation.
- Dependencies are inspectable in both views and rendered as paths in the garden.
- WASD movement and keyboard interaction work reliably.
- Repository refresh policy applies equally to Map and Garden.
- PR changes highlight affected files and supported symbols.
- Module interactions can open code and seed existing Chat.
- Security and technical-debt visuals never appear without evidence.
- Large repositories remain usable through progressive rendering and level of detail.
- WebGL failure never blocks access to the repository map.
- Existing repository-map and PR overlay behaviour does not regress.

## Deliberate non-goals for the first release

- Multiplayer presence or real-time shared avatars.
- Voice or proximity chat.
- Editing source code directly inside the garden.
- A general-purpose game engine.
- Full call graphs for every language.
- External package worlds.
- AI-generated findings that bypass existing Anvil review or security records.
- Persisting a separate in-world chat history.

## Implementation checklist

- [ ] Define versioned deep repository graph and source-range contracts.
- [ ] Persist graph snapshots and extend the existing refresh pipeline.
- [ ] Extract TypeScript/JavaScript symbols and internal dependencies.
- [ ] Build progressive repository-to-symbol 2D drilldown.
- [ ] Add search, breadcrumbs, dependency modes, editor, and Chat actions.
- [ ] Extend PR summaries with line ranges and symbol overlays.
- [ ] Add lazy-loaded Three.js Archive Garden.
- [ ] Implement deterministic plots, dependency paths, movement, and interaction.
- [ ] Add evidence-backed change, security, and debt treatments.
- [ ] Connect module terminals to existing Anvil features.
- [ ] Add accessibility, fallback, performance, and regression coverage.
- [ ] Run focused tests, full tests, lint, build, and manual visual verification.