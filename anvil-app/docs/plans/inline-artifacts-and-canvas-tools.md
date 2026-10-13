# The thread is the canvas: inline surfaces for Anvil

Scope: `anvil-app` (main, preload, renderer, prompts, bundled MCP server).
Related: [`ui-surfaces-review.md`](./ui-surfaces-review.md), [`../agent-ui-intents.md`](../agent-ui-intents.md), `PRODUCT.md`, `DESIGN.md`.

## Implementation status (2026-10-13)

Built on `develop`:
- The local MCP endpoint and provider injection (§6).
- The surface contract and core (§5).
- Artifacts with revisions, and sketches (§8.9–§8.10).
- The Review (§8.1), Findings (§8.3), Pipeline (§8.4), Dependencies (§8.5), Data (§8.8) and Diagram (§8.7) surfaces.
- Per-turn Changes (§8.2), built as the transcript footer rather than a surface kind. It drafts a turn-scoped review, and offers a guarded Undo plus Commit/PR.
- Inline host, stage and windows, with the Canvas pane removed (§10).
- Sharing, including interactive shares and `share.update` (§11).
- Sidebar consolidation, the Library, and repo Health/Setup (§12).
- Read-only threads hide mutation actions.
- The old PR Review and Changes screens launch reviews in chat.
- Replay fixtures exist for every surface kind, plus a 30-surface heavy thread.

Verified live:
- An isolated dev profile boots, a fresh database migrates to v110, and the endpoint returns 401 without a valid token and 403 for a foreign Host or Origin.
- A copy of a real v107 database migrates cleanly to v110.
- Codex 0.162 and cursor-agent 2026.09.10 connect to the endpoint and call tools.

Not yet verified: Codex `thread/resume`, azure, llmgateway, devin (ACP requires API-key auth before `session/new`).

Open follow-ups:
- Surfaces §8.6 (restyle) and §8.11–§8.16 are not built.
- Visual QA of the replay fixtures in dark, light and flavour themes.
- Sketch `tools/call` from frames is not wired.
- Codex file-change events drop the change kind, so created and deleted files show as "modified" in per-turn Changes (`codex-protocol.service.ts`).
- `diagram-file.service.ts` doesn't list saved Mermaid (`.mmd`) diagrams.
- Serving interactive shares from a separate user-content origin.

## How to use this document

This is a product and system spec for agents building it. It isn't a schedule.

- **Starting point (§3)** is verified current state, with file references. **Sharing (§11)** also has its own verified starting point (§11.1).
- **The surface contract (§5)** and **tool channel (§6)** are the shared foundation. Every surface depends on them.
- **The surface catalogue (§8)** is a set of independent units of work. Pick any unit whose dependencies exist in the code.
- **Invariants (§13)** and **Definition of done (§14)** are non-negotiable for every unit.
- If you change a contract, update this file in the same change. If you find a statement here that's false, fix it here first.

---

## 1. The experience

The conversation is the workspace. When the agent's answer has structure, the answer **is** that structure, rendered natively in the thread where it was produced. Nothing opens in a side pane. Any surface can expand to a full stage or pop out into its own window.

- **"Review my changes."** A **Review** surface streams into the reply.
  - First a verdict line ("Ship after 2 fixes · 14 files · 3 risks").
  - Then the change told as chapters ("1 · Token refresh moves to the gateway").
  - Then findings pinned to the exact diff lines as the agent publishes them.
  - You press `f` on two findings and type "do these". The agent continues in the same turn context. When it's done, the Review surface updates in place: those findings show *Fixed in this thread*, with the diff that fixed them.
- **"Why is CI slow?"** A **Pipeline** graph with the slow jobs highlighted and timing bars. Click a job to see its log excerpt. You can annotate any node.
- **"Are our dependencies OK?"** A **Dependencies** table with an audit overlay. "Create tickets for the criticals" is one action, and it goes through approval.
- **"Visualize how auth works."** A **Diagram**, or a throwaway **Sketch** in Anvil's theme. You draw a box around part of it and say "this is wrong". The agent receives that region as anchored feedback. When the Sketch turns out to be worth keeping, **Keep** promotes it to an artifact.
- **"Compare these three libraries."** A **Sketch**: a themed comparison chart built with Anvil's in-frame kit, with no prose table to squint at. It's disposable. It answers this question and doesn't clutter the Library.
- **"Write the migration runbook."** An **Artifact**: a durable, versioned document saved to the repo or the session. It shows up in the Library and can be shared.
- **"Share this review with Sam."** **Share** opens a preview of exactly what Sam will see: the verdict, chapters and findings, with secrets flagged and your private comments left out. The link is end-to-end encrypted. When the review moves on, **Update link** refreshes what Sam sees without changing the URL.
- **A third-party MCP tool that ships an MCP App** renders inline too, sandboxed.

## 2. Principles

1. **The answer is the interface.** Visuals are part of the reply. They sit on the thread background, aligned with the reply text, without chrome that makes them read as an embedded widget.
2. **Native surfaces first.** When the work matches a first-party domain (review, findings, pipeline, deps, diff, tests, plan…), the agent publishes **structured data** and Anvil renders a crafted native React surface. That surface has real keyboard support, accessibility and actions. The agent never hand-draws the review UI.
3. **Throwaway and durable are different things.**
   - **Sketches** are one-off, agent-authored visuals that answer the moment.
   - **Artifacts** are durable documents: versioned, saved, shareable, and listed in the Library.
   - Both render inline. Only artifacts accumulate. Promoting a Sketch to an Artifact is one action.
4. **Two-way surfaces.** Every surface declares actions. A user action becomes structured input to the agent, or a mutation through approvals. Surfaces are live: the agent patches them by revision, and they update in place.
5. **Point and say, everywhere.** Any surface, sketch or artifact can take an anchored comment: a diff line, a finding, a graph node, a table cell, or a region of a sketch. That comment becomes a feedback message the agent can act on.
6. **Agent visuals look native.** Sketches get Anvil's live theme tokens and an in-frame kit (`anvil-kit`: charts, tables, diff, mermaid, code). Agents then produce on-brand visuals without re-inventing a chart library each time.
7. **A stage and windows.** Every surface has an inline form, a fullscreen **stage** form (a real workbench, not a zoomed card) and a pop-out window.
8. **Open standards at the edges.**
   - Tools are exposed over MCP.
   - Sandboxed frames talk to the host over the MCP Apps protocol (JSON-RPC over `postMessage`, [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps)). The same host can then show third-party MCP Apps.
9. **Every provider.** All six Anvil providers get the same surfaces (§6), with honest fallbacks.

---

## 3. Starting point (verified)

- **Sidebar.** `src/renderer/utils/sidebar-navigation.ts` lists 29 destinations. Most tool entries are views over main-process services the agent can't call.
- **Canvas pane.** `ChatSidePanels.tsx:200-241` renders the canvas as a right pane, an expanded overlay, or a single `window.open` portal (`DetachedCanvasWindow.tsx`, fixed name `anvil-canvas`). It holds artifacts, plans, the goal snapshot, annotations, share and zoom (`ChatCanvasPanel.tsx`).
- **Artifacts.** These are a prompt convention (`buildArtifactCanvasPrompt`, `ChatContext.tsx:4445`), parsed only **after** the turn ends (`extractChatArtifactInputs`, `ChatContext.tsx:4530`).
  - The fence also renders as a raw code block, because `MarkdownRenderer` → `CodeBlock`.
  - `upsertChatArtifact` (`chat-artifact.service.ts:305`) overwrites the head row and bumps `version`, writing each version to `chat_artifact_revisions`. History exists, but nothing in the UI shows it.
- **Agent UI intents** (`src/shared/agent-ui-intents.ts`, `agent-ui-intent.service.ts`, `docs/agent-ui-intents.md`) already define a provider-neutral, revisioned, validated envelope for `plan` and `question`.
  - They render inline (`ChatMessage.tsx:115` → `AgentUIIntentSurface`), and pending questions stay pinned above the composer (`ChatPromptOverlays.tsx`).
  - The doc anticipates `ArtifactSurface`, `DiffSurface` and `TestResultsSurface`. **This is the foundation to extend.**
- **Providers.** codex, azure, openai and llmgateway use the Codex app-server. cursor and devin use ACP v1.
  - ACP sessions start with `mcpServers: []` (`codex-session.service.ts:1215-1221`).
  - The llmgateway provider runs with an isolated `CODEX_HOME`.
  - `anvil-chrome` is registered only in the user's **global** Codex config (`browser.ipc.ts:90-149`).
  - Codex MCP tool calls arrive as `${server}.${tool}` (`codex-protocol.service.ts:883-894`).
  - Temporary chats force `mcp_servers={}` (`codex-session.service.ts:438`).
- **Rich domain data already exists** for native surfaces:
  - `CodeReview` and `CodeReviewFinding` (`types.ts:2091-2118`)
  - `PullRequestVisualisation` with chapters, nodes, edges, risks and evidence (`types.ts:2035`)
  - `RepositoryChangeSummary`, `PullRequestDiff`, and CI/CD `CicdFlowNode` graphs
  - dependency, licence and SBOM results, security findings, the DB Insights analysis, and compliance documents
  - Current renderers: `components/codereview/*` (`PullRequestCanvas`, `CodeReviewReport`, `CodeReviewFindingCard`), `components/review/ChangeReviewPanel.tsx`, `components/security/*`, and `TurnChangesFooter.tsx`.
- **Themes.** `global.css` maps `--color-*` tokens to `--anvil-chat-*`, and `html[data-theme=…]` supplies several themes (dark, light, and flavour variants). Sketches must follow whichever theme is active, live.

---

## 4. Kinds of inline output

| Kind | What it is | Who draws it | Lifetime | When to use it |
|---|---|---|---|---|
| **Native surface** | First-party React component fed by a typed payload | Anvil | Durable. Backed by its domain record (a review, an audit…) | The data matches a catalogued kind (§8). Always preferred |
| **Sketch** | Agent-authored HTML in a sandboxed frame, with Anvil tokens plus `anvil-kit` | The agent | **Throwaway.** Lives in its turn; not versioned; not in the Library | One-off visuals: comparisons, mockups, explanatory diagrams, quick dashboards, "show me" answers |
| **Artifact** | Durable document: markdown, HTML, docx, pptx, pdf, csv, xlsx, code, diagram | The agent | **Durable.** Versioned, saved to the repo or session, in the Library, shareable | Anything the user will come back to, edit, hand over or commit |
| **MCP App** | A third-party tool's `ui://` resource, hosted under the MCP Apps protocol | A third-party server | Snapshot taken with its tool call | A tool the user installed ships its own UI |

**Selection rule** (stated in the agent-facing guide in §7):

- If a native surface fits, publish data to it.
- If the user will want it again, make an Artifact.
- If it just answers the moment visually, make a Sketch.

**Sketch ↔ Artifact.**

- **Keep** on a Sketch promotes it to an HTML Artifact (v1). The user can do this, or the agent can via `sketch_keep`.
- An Artifact can be shown without being edited. Editing always creates a new version.
- Throwaway doesn't mean vanishing. Sketches persist with their message, so reloading the thread shows them. They're deleted with the thread and excluded from sync and the Library.
- Never put structured data in a prose table when a surface exists.

---

## 5. The surface contract

Extend the agent UI intent protocol. Plans and questions become two surface kinds among many. `AgentUIIntent` keeps its envelope (`protocolVersion`, `id`, `kind`, `revision`, `scope`, `lifecycle`, `presentation`, timestamps) and gains the following.

### 5.1 Per-kind definition (registry)

Each kind lives in one triple of locations, wired through one registry entry:

```
src/shared/surfaces/<kind>.ts            payload schema + TS types, action ids, anchor types, digest()
src/main/surfaces/<kind>.ts              validate, hydrate (load from services), execute actions, patch ops
src/renderer/components/surfaces/<kind>/ Inline.tsx, Stage.tsx (optional Window.tsx), skeleton
```

`src/shared/surfaces/registry.ts` exports one `SurfaceDefinition` per kind:

```ts
interface SurfaceDefinition<P, A extends string, X extends string> {
  kind: string;
  schema: JsonSchema;               // validated at the main-process trust boundary
  actions: Record<A, SurfaceActionSpec>;
  anchors: X[];                     // comment anchor types this surface supports
  digest(payload: P): string;       // compact text the agent sees, also used for mobile/export
  feature?: Feature;                // role gating via ROLE_FEATURES
  tool?: SurfaceToolSpec;           // auto-generates the MCP tool(s) that publish/patch it
  share?: {                         // opt-in sharing (§11)
    redact(payload: P): P;          // strip private fields before snapshotting
    snapshot(payload: P, options: ShareOptions): { html: string; css: string };
  };
}

interface SurfaceActionSpec {
  label: string;
  semantics:
    | { type: 'agent-message'; template: string }          // structured follow-up to the agent
    | { type: 'anvil-command'; command: string }            // local, non-mutating, or user-owned state
    | { type: 'mutation'; command: string; approval: true }; // through runtime approvals, hidden in Read only
  shortcut?: string;
}
```

Adding a surface means adding one registry entry plus its three folders. The MCP tool list, validation, renderer routing and digest all derive from the registry. Nothing else should need editing.

### 5.2 Lifecycle and live updates

- **Publish:** `surface_publish(kind, payload)` returns `{surfaceId, revision}`.
- **Patch:** `surface_patch(surfaceId, baseRevision, ops)` applies kind-defined patch operations, following the plan-patch model. A stale `baseRevision` is a conflict.
- **Streaming:** the surface renders a skeleton as soon as it's published with `streaming: true`. Items (findings, rows, nodes) appear as they're patched in. `surface_complete` ends streaming.
- **Anchoring:** the chat event carries turn and sequence, so the surface renders exactly where it was produced in the reply. The raw `anvil.*` tool row collapses into the turn's Activity group as one line ("Published Review · 9 findings"), so tool metadata never fractures prose (DESIGN.md Activity Group rule).
- **Supersede:** when a later turn publishes the same logical surface (same `key`, e.g. `review:<repo>:<scope>`), earlier instances collapse to one line, "Superseded by the review below ↓".

### 5.3 Actions loop

1. A user action produces a `surface_action { surfaceId, action, targetIds, note? }`.
2. Main executes it by semantics.
   - `agent-message` becomes a structured follow-up. It's delivered via Codex turn steering, or queued after the ACP stop reason (the same path plan edits use today; `agent-ui-intents.md` § Provider adapters).
   - `mutation` raises a runtime approval, and only executes on approve.
3. The surface patches itself with the outcome, e.g. a finding becomes `fix-requested` → `fixed`, linked to the diff.

### 5.4 Point and say (anchored comments)

- **Built-in anchors.** Every surface supports `surface` (the whole thing). Kinds add their own: `diff-range`, `finding`, `node`, `row`, `cell`, `step`, `text-selection`, `region` (sketches, via the bridge).
- **Comment flow.** Comments open inline next to the anchor, persist (generalising `chat_artifact_annotations` into `surface_comments`), and send as structured feedback with the anchor's context. Examples of that context: the file and lines with surrounding hunk text, the node label and its upstream nodes, or a cropped screenshot of a sketch region.
- **Agent access.** The agent can list open comments with `surface_comments(surfaceId)` and resolve them through patch ops.

### 5.5 Context economy

- Tool results return the **digest**, not the payload: a few hundred tokens of the key facts plus ids.
- `surface_read(surfaceId, select?)` fetches detail on demand.
- Sketch HTML is never echoed back into model context. The agent gets `{surfaceId, measuredHeight, screenshotRef?}`.

### 5.6 Presentations

- **Inline.** Lives in the reply. Width is the reply column. Kinds marked `wide` (Review, Pipeline, Data) break out to the full transcript width.
- **Stage.** `⤢` opens it over the chat column, keeping the rail and sidebar visible so workspace context stays legible.
  - State lives in the URL (`?surface=<id>`), so back, reload, notifications and launch intents all work. Esc returns focus to the handle.
  - Stage is a different layout of the same data hook, not a scaled-up card.
- **Window.** `⧉` opens a main-process `BrowserWindow` on `#/surface/:id`, subscribed to updates over IPC. Several windows can be open at once.
  - The title includes the workspace name.
  - The window closes when its thread or workspace is deleted.
  - It never swaps content on workspace switch.
  - `setWindowOpenHandler` and the CSP allow only that route.
  - `DetachedCanvasWindow`'s `window.open` portal can be the interim implementation, but key it by surface id.

---

## 6. Anvil as a local MCP server

The app itself is the MCP server. The Electron main process hosts one **Streamable HTTP MCP endpoint on loopback**, and every agent session connects to it.

**Why this design:**
- The services, database, approvals, workspace scope and renderer event bus all already live in main. Hosting the server there means tool calls run in-process, with no extra server process and no bridge hop.
- There's one implementation for all providers.

### 6.1 Endpoint

- **Address.** `http://127.0.0.1:<random port>/mcp`, started at app launch.
  - Bind to loopback only; never `0.0.0.0`.
  - Validate the `Host` and `Origin` headers, as the MCP transport spec requires for local servers (DNS-rebinding defence).
  - Use a random port per app run.
- **Per-session bearer token.** Main mints one token per agent session, held in memory only. The token resolves to `{workspaceId, threadId, repoIds, features, accessLevel, provider, expiresAt}`.
  - Requests without a valid token are rejected before any MCP handling.
  - Tokens are revoked when the session ends, the thread or workspace is deleted, or the access level changes (a new token is issued).
- **Scope enforcement in main, per request.**
  - `tools/list` is computed from the token. Role-gated features are omitted (`ROLE_FEATURES`). Mutating tools are omitted in Read only.
  - Repo arguments must be in the token's repos.
  - Mutations always go through runtime approvals.
- **Server `instructions`.** The MCP `initialize` result carries the surface guide (§7). Codex reads server instructions as tool guidance. For providers that ignore the field, the system prompt still carries the guide.
- **Implementation.** `src/main/services/agent-mcp/`: server, auth, the registry-derived tool list (§5.1), and a handler per tool group. Use the official MCP TypeScript SDK's Streamable HTTP server transport if it's already a dependency. Otherwise add it at a version published at least 7 days ago.

### 6.2 Connecting each provider

| Provider | How it connects | Token delivery |
|---|---|---|
| codex, azure, openai, llmgateway | Per-spawn overrides: `-c mcp_servers.anvil.url="http://127.0.0.1:<port>/mcp"` and `-c mcp_servers.anvil.bearer_token_env_var="ANVIL_MCP_TOKEN"` | The token goes in the spawned process **env** (added to the allowlist in `buildCodexProcessEnvironment`). It never goes in args, so it isn't visible in `ps`. This never touches the user's global config and works with llmgateway's isolated `CODEX_HOME`. |
| cursor, devin, when the agent advertises `mcpCapabilities.http` | ACP `session/new` / `session/load` with `mcpServers: [{ type: 'http', name: 'anvil', url, headers: [{ name: 'Authorization', value: 'Bearer …' }] }]` | Over the ACP stdin channel (not args) |
| cursor, devin, stdio only | ACP stdio entry pointing at a tiny bundled **stdio↔HTTP shim** (`scripts/anvil-mcp-shim.mjs`, run as `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, following the `scripts/chrome-mcp-server.mjs` precedent). It forwards frames to the loopback endpoint | `env: [{ name: 'ANVIL_MCP_TOKEN', value }]` in the ACP entry (stdin channel) |
| Temporary chat | No server (keep `mcp_servers={}`) | — |
| Mesh, remote, cloud runs | Loopback isn't reachable. Use the fence fallback until tool calls ride the mesh relay with grant scoping like `browser-workspace-tools.service.ts` | — |

ACP v1 requires every agent to support stdio, and makes HTTP optional. So the shim guarantees coverage, and HTTP is used whenever it's advertised. A future ACP revision may tunnel MCP over the ACP connection itself (an `acp` MCP transport). Adopt that if it stabilises, since it removes the port entirely.

**Verify:**
- The Codex `url` + `bearer_token_env_var` overrides take effect via `-c` on app-server, and survive `thread/resume`. If not, generate a per-session config profile under an Anvil-owned path.
- `cursor-agent acp` and `devin acp` honour session-supplied servers, and which transports each advertises.

### 6.3 Housekeeping

- **Fold `anvil-chrome` into the endpoint** as the `browser_*` tool group. Then remove the global `codex mcp add` registration (`browser.ipc.ts:90-149`) and `scripts/chrome-mcp-server.mjs`.
- **Capability honesty.** Add `agentTools: 'mcp-http' | 'mcp-stdio-shim' | 'fallback'` (with evidence and a `verified` flag) to `provider-capability.service.ts`. Prompts and UI read it, and never guess.
- **Diagnostics.** The Diagnostics view shows endpoint status, the port, active sessions, and per-session tool-call counts and errors. Never show token values.

### 6.4 Fallback (no MCP)

- The fence protocol survives for **artifacts and sketches only**: ```` ```artifact ```` and ```` ```sketch ````.
- Fences are parsed **while streaming** and are never shown as code blocks. `CodeBlock` treats an `artifact` or `sketch` language as a surface placeholder.
- Structured native surfaces, actions and mutations need MCP. The guide tells the agent this when the capability is `fallback`.

### 6.5 Third-party MCP Apps

The provider CLI, not Anvil, is the MCP client for the user's own servers. Inline hosting therefore needs one of two things:

- the provider to surface `_meta.ui.resourceUri` and the resource body in its events, or
- Anvil's endpoint to act as an **aggregating proxy** for user-configured servers.

The proxy is the more ambitious option, and it fits naturally now that Anvil is an MCP server. Decide per provider, record it in the capability matrix, and never fake it.

---

## 7. How "review my code" reaches the Review surface

Routing is explicit. Anvil never infers UI from prose (`agent-ui-intents.md`).

1. **Tools are the vocabulary.** Domain tools exist for the work itself: `review_context` (diff, change summary, rubric, existing PR threads) and `review_publish` / `review_patch`. Calling them *is* choosing the surface.
2. **The agent-facing surface guide.** `buildSurfaceGuidePrompt(capability, features)` replaces `buildArtifactCanvasPrompt`. It's short: the selection rule (§4), a table mapping intents to tools ("code review → `review_context` then `review_publish`"), and the Sketch layout and token rules (§9.3). It's delivered on two channels: the MCP server's `instructions` (§6.1), and the system prompt, which every provider already gets (Codex system prompt; ACP `_meta.systemPrompt` plus a first-turn prefix).
3. **Skills on demand.** Per-domain craft guidance (review rubric, DPIA, AGENTS.md, diagram style, ADR template) comes from the existing `prompts/*.md` bodies through `anvil_skill_get(name)`. This keeps the base prompt small. Anvil can also write these into `.agents/skills` for providers that index skills, but correctness never depends on it.
4. **Explicit intents from the UI.**
   - Composer slash commands (`/review`, `/audit`, `/deps`, `/pipeline`, `/visualize`) attach a structured intent to the turn.
   - Palette and sidebar entry points ("Review PR #42") start or continue a thread with that intent.
   - The intent tells the agent which surface the user expects.
5. **The agent does the reasoning.** The session agent reviews with its full context. Anvil supplies data, rubric, persistence and UI. Services that make their own nested LLM call today (code review, compliance, diagram generation) get replaced by *skill + data tool + surface*. Keep the old paths until output parity is checked on a fixture set.

---

## 8. Surface catalogue

Each unit below is independently buildable once §5 and §6 exist. "Data" names the existing service or type to reuse.

### 8.1 Review (the flagship; set the quality bar here)

**Why it matters.** Review is where Anvil earns trust. Today it's split across `CodeReviewView`, `CodeReviewReport`, `PullRequestCanvas`, `ChangeReviewPanel` and `TurnChangesFooter`. The Review surface replaces all of their visual layers with one surface that serves three scopes:

- this turn's changes
- the working tree
- a PR

**Data.** `CodeReview`, `CodeReviewFinding`, `PullRequestVisualisation` (chapters, nodes, edges, risks, evidence), `PullRequestDiff` and `RepositoryChangeSummary`, through `code-review*.service.ts`, `change-review.service.ts`, `pull-request-visualisation.service.ts` and `git.service.ts`.

**Tools.**
- `review_context({scope})` returns the diff, chapters seed and rubric.
- `review_publish({scope, verdict, chapters[], findings[], risks[]})`.
- `review_patch` operations: add finding, set status, link fix, resolve thread.
- Findings must carry a file path and line range. The tool validates them against the diff and rejects unanchored line claims.

**Inline view** (reading top to bottom):
1. **Verdict line.** One sentence plus three facts, e.g. "Ship after 2 fixes · 14 files +412 −97 · 3 risks". The verdict is computed from severities, not free text.
2. **Risk strip.** Up to 3 risks, each with an icon, a label and the affected chapter. Severity is shown by shape and label, never colour alone.
3. **Chapters.** The change told as a numbered narrative ("1 · Token refresh moves to the gateway · 3 files"). Each chapter expands to its files, with findings shown in the diff gutter.
4. **Findings list.** Grouped by severity and collapsible. Each finding row shows its location (`file:line`), a one-line claim, and actions on hover or focus.
5. **Footer.** Accept all, Ask agent to fix selected, Post to PR (mutation), Create work items (mutation), and Open stage.

**Stage view** (the review workbench, three panes):
- Chapters and file tree, with finding counts.
- A diff with inline finding callouts and comment threads, shown split or unified.
- Finding detail: rationale, the agent's suggested patch as an applyable diff, discussion, and linked work item or PR comment.

Keyboard: `j`/`k` move between findings, `]`/`[` move between files, `a` accept, `d` dismiss, `f` ask fix, `c` comment, `s` toggle split, `?` help.

**Actions.**
- *Ask fix*: agent-message with the finding ids. Patches the finding to `fix-requested`, then to `fixed` with a link to the turn diff.
- *Dismiss with reason*: anvil-command, recorded so the agent learns it.
- *Post to PR*, *Create work items*: mutations.
- *Apply suggested patch*: mutation, reusing the file-change approval path.
- *Share review*: a frozen snapshot of the verdict, chapters, findings and the hunks around them (§11). Comments and the full diff are opt-in in the preview.

**Anchors.** `diff-range`, `finding`, `chapter`.

**Design bar.**
- It should read like a senior engineer's written review, not a linter dump.
- Prose is in Plex Sans near 72ch. Code is in Plex Mono with shiki highlighting (`chat/shiki.ts`).
- Flat layers and 1px borders. Orange only for the focused finding and the primary action.
- Findings appear as they're published, using an opacity transition only (none under reduced motion).
- No nested cards: chapters are sections, not boxes.

**Acceptance.**
- One Review surface renders correctly for all three scopes from replay fixtures.
- Every finding is anchored and jumps to its line.
- Actions round-trip to the agent on all `mcp` providers.
- The stage is fully keyboard-operable.
- The old views are deleted, or reduced to launchers that open a Review.

### 8.2 Changes

This is the per-turn diff: an evolution of `TurnChangesFooter`. It has the file list with stats, an inline diff on expand, Undo turn, Review this (promotes to 8.1 with turn scope), and Commit / Open PR (mutations). Anchors: `diff-range`.

### 8.3 Findings (shared)

One findings surface for security audits, dependency audits and BA findings, sharing its row and detail components with the Review findings.

- **Data:** `security-audit.service.ts`, `dependencies.audit`, BA findings.
- **Actions:** dismiss, ask fix, create work items (mutation), export report.
- **Stage:** a filterable table plus a detail pane.
- **Replaces:** `components/security/*` and the BA findings side panel (`ChatSidePanels.tsx:90-138`).

### 8.4 Pipeline

A CI/CD flow graph built from `CicdFlowNode` and edges (`cicd.service.ts`).

- **Inline:** a compact left-to-right graph with status and timing. Validation issues are pinned to their nodes.
- **Stage:** a pannable graph plus a node detail pane showing the YAML excerpt, validation and run history.
- **Actions:** ask agent to fix a node; create pipeline (mutation, produces a diff that feeds 8.2).
- **Anchors:** `node`.

### 8.5 Dependencies

A dependencies table with audit and licence overlays and an SBOM export (`dependencies.*`).

- **Inline:** the top risks, plus counts by manager.
- **Stage:** the full table with sort, filter and group.
- **Actions:** export SBOM (produces an artifact, 8.9), ask agent to upgrade (agent-message), create work items (mutation).
- **Anchors:** `row`.

### 8.6 Plan and Question

These exist today. Restyle them to the surface system. Add a sticky **Plan 3/7** chip above the composer, in the slot pending questions already use, that expands in place. Plan history moves into the thread's Surfaces list (§10).

### 8.7 Diagram

Mermaid or draw.io, authored by the agent with skill guidance from `diagram-generate.md` and `diagram-iterate.md`.

- **Inline:** a rendered diagram (`StreamedMermaidPreview` already handles partial source).
- **Stage:** pan and zoom, source view, Open in draw.io (`drawio-mcp.service.ts`).
- **Actions:** save to repo (mutation, `diagram-file.service.ts`).
- **Anchors:** `node`, `region`.

### 8.8 Data: table and chart

The agent supplies rows and a chart spec, and Anvil renders natively: bar, line, area, scatter, stacked and heat grid, themed with the chart tokens.

- **Stage:** full table with sort and filter, CSV export.
- **Anchors:** `row`, `cell`, `series-point`.
- Use this instead of a Sketch whenever the visual is just data.

### 8.9 Artifact (durable document)

Markdown, HTML, docx, pptx, pdf, csv, xlsx, code and diagram source: today's artifacts, re-homed and made first-class. Artifacts are the things that **accumulate**.

- **Tools:**
  - `artifact_create({title, kind, path?, storage: 'repository' | 'session', content | filePath})` returns `{artifactId, version}`.
  - `artifact_update({artifactId, baseVersion, content | edits})` rejects a stale version.
  - `artifact_read({artifactId, version?})` and `artifact_list()`.
  - Binary kinds reference files under `.anvil/artifacts` (the existing `encoding=file` rules).
- **Inline:** a height-capped preview with a fade. Binary kinds show a file card. Each turn shows **the version that turn produced**. Older instances collapse to "v1 · superseded by v3 ↓".
- **Stage:** full preview, Preview/Source toggle, version switcher, diff against any earlier version, and the comments rail.
- **Versions:** `chat_artifact_revisions` already gets a row on every create and update. Migration 109 backfills a row for any head version that's missing (`INSERT OR IGNORE`). `chat_artifacts` stays the head row for sync, share and mesh.
- **Actions:** Share… (preview first; §11), Update link / Revoke when shared, open in editor, save to repo (session → repository, mutation), discard (`ConfirmDialog`; lists any live links it will revoke).
- **Anchors:** `text-selection`, `region` (HTML).
- **Library:** every artifact's head is listed in the Workspace Library (§10).
- Reuse `ArtifactPreview` and `ArtifactAnnotationsPanel`.

### 8.10 Sketch (throwaway agent-authored visual)

A one-off, interactive HTML visual that answers the moment. It's cheap to make, it isn't curated, and it doesn't accumulate. Rules for the agent are in §9.3.

- **Tools:**
  - `sketch_show({title, html, height?})` returns `{surfaceId}`.
  - `sketch_update({surfaceId, html})` replaces the sketch in place. There's no version history; the turn shows the latest.
  - `sketch_keep({surfaceId, title?, path?})` promotes it to an HTML Artifact v1.
  - `sketch_snapshot({surfaceId})` returns a screenshot reference, so the agent can check its own work before replying.
- **Storage:** stored with its message as a thread-scoped blob. Deleted with the thread. Excluded from the Library and from sync. Shown as its digest (title plus a static thumbnail) on mobile, remote transcripts and exports.
- **Hosting:**
  - An opaque-origin sandboxed frame.
  - The theme arrives at first paint: Anvil serves the document with a `<style>` block holding the current `--anvil-*` token values, injected ahead of any page script. Live changes follow via the MCP Apps `host-context-changed` notification.
  - Anvil's bridge script, injected in the same way, reports content size (the frame grows to fit and never scrolls inside the thread), routes link clicks to the host, and speaks MCP Apps JSON-RPC.
- **Sizing:** live size reports drive the frame height. To avoid a jump on first paint, main measures the sketch once at the current reply width in an offscreen sandboxed `webContents` when it's shown, and caches heights per width.
- **Interactivity:** beyond sizing and links, the bridge supports:
  - **selection** (region and element anchors for comments)
  - **ask** (a button in the sketch drafts a structured prompt into the composer; the user sends it)
  - **tools/call** limited to an allowlist of read-only `anvil` tools, mediated by main and scoped to the session token. A sketch can then fetch fresh data, e.g. a live dependency chart.
- **Actions:** Keep, Share (runs Keep first, then shares the resulting artifact as a frozen snapshot; §11), download `.html`, copy, comment, stage, window.

### 8.11 MCP App (third-party)

A host for `ui://` resources under spec 2026-01-26.

- An opaque-origin frame, with a CSP built from the declared `_meta.ui.csp` domains (`default-src 'none'`, no host origin).
- Permissions are granted only on explicit user consent.
- Theme comes through `host-context-changed`.
- Availability depends on §6 hosting. If unavailable for a provider, show an honest "This tool has a UI that your provider doesn't expose" card.

### 8.12 Preview snapshot

`browser_screenshot` and simulator frames rendered inline, with Open live preview (the chat Preview pane stays as the live, interactive surface). Anchors: `region`.

### 8.13 Test results and run output

Test runs and command output as a pass/fail summary, failing tests with an assertion excerpt and file anchor, plus Re-run (anvil-command, `run.*`) and Ask agent to fix. Anchors: `row`.

### 8.14 Entity cards

Work item, doc page (with a staleness chip), note, ADR, lifecycle item and PR, each a compact card with its primary actions. Data: `workitems.*`, `docs.*`, `workspace-notes`, `adr`, `lifecycle`, `ThreadPullRequests`.

### 8.15 Repo readiness

A checklist (AGENTS.md, devcontainer, environment) from `onboard.detect` and `checkEnvironment`, with Fix with agent on each row. Generated files become Artifacts with Write & commit (mutation).

### 8.16 Schema (DB Insights)

An ERD and table browser from the DB Insights analysis. Exports are attached through the composer instead of a separate import screen. Anchors: `node`, `row`.

---

## 9. Design direction

### 9.1 Principles

**"The Quiet Workbench, made spatial."** Surfaces are part of the answer, not widgets bolted onto it.

- **Borderless where possible.** Inline surfaces sit on the thread background, aligned to the reply text, so they read as part of the answer. Use structure (a 1px border, the surface token) only where a region must stand apart, e.g. a diff or a code block.
- **The inline form answers; the stage works.** Inline shows the conclusion and the few things to act on. The stage holds the full workbench.
- **One accent.** Orange marks focus, selection and the primary action, nothing else. Severity and status use shape plus label plus semantic colour.
- **Type does the hierarchy.** Plex Sans 14/1.65 for prose, Plex Mono for code, paths and ids. No oversized headings inside replies.
- **Motion only for state change.** Streaming items fade in (opacity and transform only). The stage opens with a short scale-from-handle that's disabled under reduced motion. Never animate layout properties.
- **Density by mode.** The stage can be dense (a tool). Inline stays calm (part of reading).

### 9.2 Shared chrome

Every surface uses one header and handle pattern:
- kind icon, title and a meta line (e.g. "v2 · updated 3m ago")
- on the right, `⤢` stage, `⧉` window and `⋯` overflow, all visible on hover or focus, with `aria-label`s and a 2px accent focus ring

Shared parts:
- **States:** streaming skeleton, ready, updated (a revision chip with a "what changed" toggle), superseded (collapsed to one line), and error (a plain-language reason with Retry).
- **Primitives:** build on `components/ui/` (Dialog, Menu, SegmentedControl, ConfirmDialog). Don't hand-roll buttons, menus or dialogs.

### 9.3 Sketch rules (given to the agent in the surface guide)

- **Tokens on `:root`, following the active theme live.** The names mirror the roles in DESIGN.md:
  - `--anvil-canvas` (identical to the thread behind the frame), `--anvil-surface`, `--anvil-surface-raised`
  - `--anvil-border`, `--anvil-focus`
  - `--anvil-ink`, `--anvil-ink-secondary`, `--anvil-ink-muted`
  - `--anvil-accent`, `--anvil-on-accent`
  - `--anvil-success`, `--anvil-warning`, `--anvil-info`, `--anvil-error`
  - `--anvil-code-bg`, `--anvil-code-ink`
  - `--anvil-series-1…6` (categorical, for charts)
  - `--anvil-radius-sm|md|lg|xl`
  - `--anvil-font-sans`, `--anvil-font-mono`
  
  All are derived from `--anvil-chat-*` for whatever `data-theme` is active. Extend `utils/__tests__/contrast.test.ts` so the series and semantic colours pass against every theme.
- **Layout:**
  - No page background, outer card or banner title.
  - Fluid width with no outer horizontal padding.
  - Content sets the height (no `100vh`). Charts get fixed pixel heights.
  - Any inner panel gets 16px or more of padding and `var(--anvil-radius-lg)`.
- **Sketch or Artifact?** If the user is likely to come back to it, edit it, hand it over or commit it, use `artifact_create` instead.
- **`anvil-kit`** is a small, versioned, self-contained script served into the frame. It provides `Kit.chart(el, spec)`, `Kit.table(el, rows, opts)`, `Kit.diff(el, patch)`, `Kit.mermaid(el, src)` and `Kit.code(el, src, lang)`, all themed from the tokens. The guide tells the agent to prefer the kit over hand-rolled SVG.
- **No network** unless the user approves declared domains. Scripts are inline only.

---

## 10. Losing the Canvas pane

The Canvas pane's jobs and their new homes:

| Canvas did | Now |
|---|---|
| Showed artifacts | Artifacts inline (8.9); throwaway visuals are Sketches (8.10) |
| Tab strip for navigation | **Surfaces (n)** in `ChatHeader`: a popover listing every surface in the thread (kind, title, revision, turn). Click scrolls to it; ⌥-click opens the stage |
| Hosted plans | Inline plan, plus the sticky Plan chip (8.6) |
| Goal snapshot | Header chip next to the thread title |
| Zoom | Stage and window only |
| Annotations | Point-and-say comments on every surface (§5.4) |
| Share | The surface's `⋯` menu and the stage toolbar |
| Expand / detach | `⤢` / `⧉` on every surface (§5.6) |

**Delete:**
- `ChatCanvasPanel.tsx`, after extracting the reusable pieces
- the canvas branches in `ChatSidePanels.tsx`
- `'canvas'` in `ChatPanelId` and its state in `useChatPanels.ts`
- the canvas props in `ChatHeader` and `ChatView`
- `buildArtifactCanvasPrompt`
- the `chat:canvas` panel storage key

The Panels control becomes **Activity · Preview**. Update `docs/agent-ui-intents.md`, since Canvas is no longer a renderer.

**Library.** A Workspace tab, `/workspace?view=library`. It lists the latest version of every artifact and durable native surface (reviews, audits, pipelines) across threads. Sketches are deliberately excluded unless kept. It also lists repo knowledge: ADRs (`adr.listByWorkspace`), diagrams (`diagrams.list`), compliance docs (`compliance.list`) and provider docs. It opens items in the same stage.

---

## 11. Sharing

### 11.1 What exists today (verified)

- **Desktop.** `shareChatArtifact` (`chat-artifact.service.ts:490`) seals the artifact's **head content** under a fresh per-share AES-256-GCM key, then uploads it (`artifact-share.service.ts`: reserve → PUT ciphertext → finalize). The link is `…/artifacts/{shareId}#k={key}`. The key lives only in the fragment, so the backend stores bytes it can't read. Sharing again mints a new share id and revokes the old one, so **the URL changes on every re-share**.
- **Contract.** `cloud/contract/shares.ts` has one blob per share with a `mediaType`. The lifecycle is `reserved → uploaded → published → revoked | expired`, with no update operation.
- **Website** (`anvil-website/app/artifacts/[id]/`). It decrypts in the browser and renders by media type:
  - markdown is sanitised
  - HTML goes in a `sandbox=""` frame with `script-src 'none'`
  - CSV renders as a table and PDF in a frame
  - Mermaid is shown **as source**
  - anything else is offered as a download
  
  The page's UI copy is currently Japanese, an inconsistency to fix while touching it.

### 11.2 What the new model changes

There used to be one shareable thing: an artifact's latest content. Now there are three kinds of inline output, versions, live updates, comments and interactivity. The rules:

| Output | Shareable? | What the recipient gets |
|---|---|---|
| **Artifact** | Yes, the primary case | Binary kinds (pdf, docx, pptx, xlsx) and plain text kinds (markdown, csv, code) keep sharing their raw bytes under their media type, exactly as today. HTML, diagrams and anything richer share a **share bundle** (§11.3) |
| **Native surface** (Review, Findings, Pipeline, Dependencies, Data, Plan, Test results, Diagram) | Yes. Each kind opts in through its registry entry | A share bundle: a read-only, frozen snapshot of the stage view |
| **Sketch** | Only by becoming durable first. **Share** on a sketch runs **Keep** (promoting it to an HTML Artifact), then shares that artifact | An **interactive** share bundle: the live sketch, behind a trust interstitial (§11.3) |
| **MCP App** | No (third-party content and origin policy) | — |

Sharing implies durability. A link must never point at something that gets deleted with its thread.

### 11.3 Share bundle

A new media type, `application/vnd.anvil.share+json`, sealed and uploaded through the existing pipeline. No change to encryption or upload is needed.

```ts
interface AnvilShareBundle {
  format: 'anvil-share/v1';
  title: string;
  kind: string;                    // 'artifact:html' | 'surface:review' | …
  version: number;                 // artifact version or surface revision that was shared
  sharedAt: string;
  digest: string;                  // plain-text summary (accessibility, link previews, fallback)
  snapshot: {                      // static, script-free rendering (always present)
    html: string;                  // static markup
    css: string;                   // inlined; light + dark token sets via prefers-color-scheme
    images?: Record<string, string>; // data URIs for canvases/charts frozen to images
  };
  interactive?: {                  // present for sketches and HTML artifacts
    html: string;                  // the full document, including scripts
    kitVersion?: string;           // anvil-kit version inlined into html
  };
  payload?: unknown;               // typed surface payload (schema = registry kind), for "Open in Anvil"
  schemaVersion?: number;
}
```

- **The snapshot is produced by the desktop app**, not the website. The registry gains `share?: { snapshot(payload, options): {html, css}; redact(payload): payload }` per kind. Native kinds render their **read-only stage layout** to static markup with inlined CSS:
  - collapsible sections use `<details>`
  - no script is needed
  - Anvil's own type and token system is used, with light and dark sets so the snapshot follows the recipient's OS appearance rather than the sharer's flavour theme
- **Sketches and HTML artifacts share interactively (decided).** Anyone with the link can view and use them on the web.
  - The bundle carries the full document in `interactive.html`. `anvil-kit` and both light and dark `--anvil-*` token sets are inlined, so it needs no network.
  - It also carries a frozen `snapshot`, made by loading the document in an offscreen sandboxed `webContents`, letting it settle and serialising the DOM (canvases become images). The snapshot shows behind the interstitial and is the fallback where scripts can't run.
- **Website: trust interstitial, then load.** When a bundle has `interactive`, the share page first shows the title, digest and frozen snapshot with a standard warning: *"This page runs code that came with the link. Only continue if you trust the person who shared it. It can't access your Anvil account, this site's cookies or the network."* Pressing **Load interactive version** runs the document in an iframe with:
  - `sandbox="allow-scripts"` only: no `allow-same-origin`, so the origin is opaque, with no cookies or storage; no `allow-top-navigation`, `allow-popups`, `allow-forms` or `allow-modals`
  - a CSP meta tag injected ahead of the document: `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'`
  - `referrerpolicy="no-referrer"` and content-driven height (the bridge's size messages are accepted only from that frame's `contentWindow`)
  
  Hardening later: serve interactive frames from a separate user-content origin.
- **Website change:** handle `application/vnd.anvil.share+json` in `SealedShareView`. Parse it, put `snapshot.html` and `snapshot.css` in the existing script-free `SandboxedHtml` frame, show `digest` as the accessible summary, size the frame to its content, and render `images` from data URIs (already allowed by its CSP). For `interactive`, add the interstitial and the scripted frame above. The website still never sees plaintext server-side.
- **Mermaid and diagram artifacts** share as bundles with the diagram pre-rendered to SVG inside the snapshot, so recipients see the diagram instead of its source.

### 11.4 Versions and stable links

- A share records **which version or revision** it captured. Add a `shares` table keyed by the shared item:

  | Column | Holds |
  |---|---|
  | `id` | Primary key |
  | `item_type` | `'artifact'` or `'surface'` |
  | `item_id` | The shared artifact or surface |
  | `version` | The version or revision captured |
  | `share_id` | Backend share id |
  | `expires_at` | Share expiry |
  | `created_at` | When it was shared |
  | `revoked_at` | When it was revoked, if it has been |

  This supersedes the `share_id`, `shared_url` and `shared_at` columns on `chat_artifacts`; migrate existing rows into it.
- The full URL with the key is stored locally in the OS-backed credential storage (`credential-storage.service.ts`), not in plain SQLite, because it's a bearer credential. The table keeps only the share id.
- **The inline card and stage show share state:** "Shared v2 · expires 12 Nov". When the item has moved on, they show "Shared v2 · you're on v4", with **Update link** next to it.
- **Update link keeps the URL stable.** Add a contract operation, `share.update({shareId, byteLength, sha256})`, which reserves replacement bytes for a published share. `share.finalize` swaps them atomically after verification.
  - **The fragment key is reused (decided: least impact).** Each seal uses a fresh random nonce. The link keeps working, and recipients holding it see the new version. "Share as new link" covers rotation.
  - The page shows "Version 4 · updated <date>".
  - **Share as new link** stays available for when the user wants the old link frozen.
  - This changes `cloud/contract/shares.ts`, the backend share handlers (`cloud/backend/src/…`, `shares.test.ts`) and the website. Treat it as one contract change across all three.
- **Live share (deliberately not v1).** Auto-updating a link on every agent edit leaks work-in-progress. Updates are always an explicit user action.

### 11.5 Safety

Sharing publishes outside the workspace boundary, which is a real-world side effect.

- **Share preview is mandatory.** Share opens a dialog showing the snapshot exactly as the recipient will see it, with title, expiry (backend-bounded `expiresInDays`) and include options. Nothing uploads until the user confirms.
- **What's included is explicit.**
  - **Comments are excluded by default** (review notes are private); "Include resolved comments" is opt-in.
  - **Review shares include only the hunks around findings by default**; "Include full diff" is opt-in, with a size shown.
  - Absolute local paths are reduced to repo-relative paths.
- **Secret scan before upload.** The kind's `redact()` runs, then a secret scan over the bundle (env-style keys, tokens, private keys, connection strings, and secrets known to `secret-vault.service.ts`). Hits are listed in the preview with redact or cancel. The scan runs on desktop; the backend never sees plaintext.
- **Agents can't share silently.** An `artifact_share` / `surface_share` tool exists only as an approval-gated mutation that opens the same preview, and is absent in Read only. **Share URLs and keys never enter model context.** The tool returns `{shared: true, shareId, expiresAt}`; the link goes only to the user's clipboard and the UI. The same applies to mobile companion, sync and logs.
- **Revocation follows deletion.** Deleting an artifact, surface, thread or workspace that has live shares lists them in the confirmation ("2 shared links will be revoked") and revokes them. The Library gets a **Shared** filter, backed by `share.list` plus the local `shares` table, with expiry, version and Revoke.

### 11.6 Open in Anvil

- A recipient with Anvil can import a bundle that carries a `payload`. The share page offers **Open in Anvil**, a deep link carrying the share URL. The fragment key stays client-side and is handed straight to the app.
- The app fetches the ciphertext from the existing raw endpoint, verifies and decrypts it locally, and imports it into the active workspace's Library as `source: 'imported'` (already a `ChatArtifact` source value). A surface comes in as a read-only snapshot of its kind, and the recipient can start a thread from it, e.g. "continue this review".
- Imports never execute code and never bind to the sender's repos. Anchors that don't resolve locally render as plain text.

## 12. Sidebar

**Rule.** An entry stops being a destination when its output is a **result about the current task**: a report, document, table, graph or findings. It stays when it's a queue, a live tool, a cross-workspace dashboard, configuration, or a stateful editor.

| Entry | Becomes | Surface(s) |
|---|---|---|
| Overview, Activity, Chat, Workspace (+ Library tab) | Keep | — |
| Automations, Workflows, Dojo | Keep | — |
| Editor | Keep | "Open in editor" on file anchors |
| Browser | Demote (palette, pinnable); the live view stays the chat Preview pane | Preview snapshot (8.12) |
| Repo setup | Remove → repo detail checklist | Repo readiness (8.15), Artifact (8.9) |
| Argent | Remove → Settings for config | Preview snapshot (8.12), Test results (8.13) |
| Work Items | Keep (queue) | Entity card (8.14) |
| Changes | Keep as the working-tree queue; visuals are the Review surface | Changes (8.2), Review (8.1) |
| PR Review | Keep as the PR queue; opening a PR opens a Review | Review (8.1) |
| CI/CD | Remove → repo detail status | Pipeline (8.4) |
| Git | Keep | — |
| Cloud | Keep | — |
| DB Insights | Remove | Schema (8.16) |
| Dependencies | Remove → repo detail Health | Dependencies (8.5), Findings (8.3) |
| Security | Remove → repo detail Health (history) | Findings (8.3) |
| Meeting Notes, Workspace Notes | Merge into **Notes** | Entity card (8.14) |
| Documentation | Remove → Library | Entity card (8.14) |
| ADRs | Remove → Library | Artifact (8.9) |
| Diagrams | Remove → Library | Diagram (8.7) |
| Lifecycle | Keep | Entity card (8.14) |
| Data & Compliance | Remove → Library | Artifact (8.9) via skills |
| Settings, Diagnostics | Keep | — |

**Result:** 29 destinations become 18. Every removed route redirects to its new home: Library filter, repo detail, or Settings. Before removing a route, check `navigate('/…')` callers, launch intents, notifications, mobile companion deep links and the pinned-tool storage.

**Chat right-hand panels.** Canvas is removed. Findings becomes 8.3. Activity and Preview stay. The Design and ITSM workbenches are out of scope.

---

## 13. Invariants

1. **Workspace scope is a trust boundary.**
   - Every tool call, surface and window is bound to a workspace and thread.
   - Out-of-scope repos are rejected in main.
   - Windows never re-bind on workspace switch.
2. **No prose inference.** Surfaces come only from tool calls, fences (fallback) or explicit UI intents.
3. **Every action has execution semantics.** Mutations go through runtime approvals and are hidden in Read only. There are no placeholder buttons.
4. **Sandboxing.**
   - Sketches and MCP Apps run in opaque-origin frames: `default-src 'none'`, no host origin, no network without consent.
   - Bridge messages are authenticated by the source window.
   - A frame's `tools/call` is allowlisted and mediated by main.
5. **Themes.** Every surface and render follows the active `data-theme` live and passes AA contrast.
6. **Accessibility.** WCAG 2.2 AA: full keyboard operation, visible focus, non-colour status, reduced motion, text zoom, and wrapping for long paths and ids.
7. **Readable without surfaces.** Each surface's `digest` is shown wherever a surface can't render: mobile companion, `RemoteThreadTranscript`, exports, share pages, and providers on fallback.
8. **Performance.**
   - Heavy surfaces and frames mount only near the viewport, with reserved heights and no layout shift.
   - A 30-surface thread stays within the chat-replay benchmark budget (`docs/chat-replay-benchmark.md`).
9. **Provider honesty.** Capability differences are recorded in `provider-capability.service.ts` and reflected in the guide and the UI. Never claim parity that hasn't been verified.
10. **Context economy.** Tools return digests. Payloads and HTML never flood model context.
11. **Sharing is deliberate.**
    - Nothing is published without the share preview and user confirmation.
    - Share URLs and keys never enter model context, logs or sync.
    - Native-surface snapshots are script-free. Interactive sketch shares run only behind the trust interstitial, in an opaque-origin, network-less sandbox.
    - Deleting a shared item revokes its links.
    - Only durable things are shared: a sketch is kept first.

## 14. Definition of done (per surface)

- [ ] Registry entry: schema, actions with semantics, anchors, `digest`, feature gate, tool spec.
- [ ] Main: validation (rejects malformed payloads), hydration from the existing service, action execution, patch ops with a revision conflict check.
- [ ] Renderer: Inline, Stage and skeleton; all shared states (§9.2); keyboard map; comments on every declared anchor.
- [ ] Works on every `mcp`-capable provider. The fallback behaviour is documented and shows the digest.
- [ ] Sharing decided. Either a `share` entry (redact + static snapshot), with a website check that the bundle renders correctly in light and dark, or an explicit "not shareable" note with the reason.
- [ ] Tests: schema validation, digest, patch and conflict handling, action round-trip, renderer state reducer, and redaction (when shareable).
- [ ] Replay fixture added to `chat-replay-fixtures.ts`. Visual check in the replay preview (`scripts/chat-replay-machine.mjs`) for dark, light and one flavour theme. The impeccable detector is clean on changed UI.
- [ ] The old view or panel it replaces is deleted or reduced to a launcher. Redirects are in place.
- [ ] This document and `docs/agent-ui-intents.md` are updated.

## 15. Open questions

1. Do `cursor-agent acp` and `devin acp` honour session-supplied MCP servers, and over which transports? If they don't, those providers get Sketches and Artifacts via fences only, recorded as such.
2. Do per-spawn Codex `-c mcp_servers.*` overrides survive `thread/resume`?
3. Third-party MCP Apps: rely on provider events, or have `anvil` proxy the user's servers? The proxy is the more ambitious path, but it changes where the user's MCP config lives.
4. Should version history and surface comments sync across devices, or only the head state?
5. Do the old nested-LLM review, compliance and diagram outputs reach parity when the session agent does the reasoning? Check on a fixed fixture set before deleting the old paths.
6. ~~Interactive shares?~~ **Decided:** yes, always viewable on the web by anyone with the link, behind a trust interstitial (§11.3). Open follow-up: move interactive frames to a separate user-content origin.
7. ~~Rotate the key on `share.update`?~~ **Decided:** keep the key (least impact; stable link).
