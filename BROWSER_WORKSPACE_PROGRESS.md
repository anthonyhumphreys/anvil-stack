# Browser workspace progress

## Usage checkpoint, 22 September 2026

Anth asked to preserve progress and stop before remaining usage reaches 1%. The root cannot read an exact remaining-usage meter, so work is stopping conservatively. Agents have been asked to finish only their immediate edits and record their checkpoints below. This is an incomplete implementation checkpoint, not a release-ready handoff. Nothing was committed or deployed.

Final checkpoint: UI, transport, Desktop grants, and tools owners returned their notes below. The acceptance-test owner was interrupted to honor the stop request before a final typecheck-fix report; inspect its current test edits and rerun the exact Node typecheck on resume. The independent review identified a blocking approved-grant lookup mismatch. Resolve that before attempting live sign-in acceptance. Root has not rerun final combined checks after these last edits.

### Resume here

1. Read this file, `BROWSER_WORKSPACE_PLAN.md`, project `AGENTS.md` files, and the separate market-readiness notes. Preserve all existing dirty changes. Use Luna at xHigh for implementation subagents as Anth requested.
2. Check final agent checkpoint sections at the bottom, then run Desktop Node and renderer typechecks and website typecheck. The last root run failed; do not rely on earlier agent claims of passing checks.
3. Finish website-to-Desktop integration before more visual work. Root found the access form did not provide repository IDs required by the action. The approved design has Desktop choose repositories, so make that handshake consistent across the contract, backend, grant approval, and browser. Check real result shapes, ongoing chat/approval polling, failed-send draft preservation, async account/repository generation guards, terminal/preview callbacks, and uncertain-command recovery.
4. Finish Desktop durable result outbox handling. Exact ciphertext/fence retry is covered by acceptance, but one expired/revoked/unpublishable result must not starve all later commands. Verify tools dispatch and revocation cleanup are wired into the real runtime, not only standalone tests.
5. Finish isolated screenshot permissions and total-result-size handling. Preview remains noninteractive. No arbitrary URL proxy is authorized.
6. Repeat relevant checks once integration settles: full app tests, backend tests/typecheck, website lint/typecheck/build, app lint/build, and the bounded Impeccable confirmation/reviewer handoff. Native dependencies currently target Node; coordinate before rebuilding them for Electron.
7. Remove the temporary presentation-only `anvil-website/app/docs/workspace-review-local/page.tsx` before shipping. It is dev-only and contains explicitly labelled fixture data. Initial captures omit the real account wrapper; UI owner is correcting the actual workspace layout to avoid duplicate sidebars. Do not treat fixture screenshots as live acceptance.
8. Only after local checks pass, ask permission to deploy the new relay to hosted staging, then ask Anth to sign in and approve the browser from Desktop. Sign-in alone cannot test the relay while staging is still on the old backend.

### Local verification environment

- Website development server: `http://localhost:3000`. WorkOS callback is local; backend points to existing hosted staging. No new backend deployed.
- Initial workspace shell captures: `anvil-website/.impeccable/review/workspace-desktop-initial.png` and `workspace-mobile-initial.png`. Browser viewport override has been reset.
- Earlier local worker: port 8799, persistence `/tmp/anvil-readiness-worker.qKAAm1`. Earlier isolated Electron QA profile: `/tmp/anvil-readiness-desktop.ynXySj`. Recheck process state before using; the running Desktop may have an older build.
- Current work includes the earlier settings, onboarding, marketing, cloud-provider, and backend changes tracked in `MARKET_READINESS_PROGRESS.md`. Do not revert them while finishing this browser phase.

## Decisions

- User approved implementation: primary browser workspace, Desktop-backed first, cloud independence later.
- All implementation subagents: `gpt-5.6-luna`, `xhigh`.
- Existing market-readiness work is preserved; its verification is recorded in the separate market-readiness documents.

## In progress

- Root: architecture/contract, integration, plan, review, verification.
- `browser_execution_map`: Desktop executor, persistent chat/session integration, repository/files/Git/workflow commands and focused tests.
- `browser_relay_map`: shared command contract and backend encrypted relay, authorization and lifecycle tests.
- `browser_desktop_grants`: Desktop grant approval, explicit repository/action scope, durable command pump and IPC.
- `browser_terminal_preview`: grant-scoped terminal lifecycle and safe preview implementation.
- `browser_web_transport`: browser authorization, encrypted transport, hosted forwarding and reconnect handling.
- `browser_workspace_ui`: workspace route, conversation/files/results layout, navigation and drafts.
- `browser_workspace_acceptance`: independent cross-boundary integration tests.

## Findings

- Existing dashboard grants only authorize encrypted read projections. No executable browser command route existed at the start of this phase.
- Existing Desktop session services can run work, but renderer-owned message persistence is insufficient when the browser is the only active view. Main-process persistence must cover browser-origin sessions without duplicating Desktop history.
- Existing general file helpers are not safe browser authorization boundaries. Browser file commands need approved repository lookup, path/symlink validation and content-revision checks.
- Dashboard request polling currently returns pending requests only. Execution cannot infer ongoing authorization from the local mirror; the relay must enforce current grant state and issuer on each claim.
- A closed tab loses sessionStorage. The new workspace needs deliberately scoped browser-key persistence or a fresh authorization flow that still resumes persisted Desktop history.
- Interactive development preview transport remains under investigation. An unauthenticated tunnel or arbitrary URL proxy is not an acceptable shortcut.

## Checklist

- [x] Record approved direction and implementation plan.
- [x] Finish service/relay discovery and establish shared command/envelope contract.
- [x] Implement scoped authorization and encrypted durable relay.
- [x] Implement Desktop command dispatch using existing services.
- [x] Implement persistent browser workspace and reconnect handling.
- [x] Implement file/edit/diff/test/Git interactions.
- [x] Implement scoped terminal and authenticated preview support.
- [x] Run focused security/reliability tests and project checks.
- [ ] Exercise first end-to-end acceptance and responsive visual review.
- [ ] Record verified behavior and unresolved launch gates.

## Verification / blockers

Local checks are in progress below. Hosted production configuration and live identity/provider prerequisites from the prior phase remain unresolved; local fixture verification is not real hosted acceptance.

Local website authentication is configured with a localhost callback, but its backend URL points to existing hosted staging. The new relay has not been deployed there. Anth offered to sign in for final acceptance; wait until the implementation and appropriate backend are ready, then request the real sign-in/approval step. Do not deploy staging implicitly.

## Checks during integration

- Root `git diff --check`: clean at the time checked.
- Root backend `pnpm typecheck`: pass.
- Root backend browser-workspace unit/transport acceptance: 2 files, 6 tests pass.
- Executor agent: 12 focused tests and 29 combined executor/Codex tests passed before root review follow-ups. Follow-ups are in progress; root caught an intermediate file-list regression, assigned back for correction.
- Tools agent: 14 focused tests passed for grant-bound terminal ownership and preview adapter. Real preview capture integration is now being added and needs re-verification.
- Acceptance agent: 3 crypto interoperability tests pass, using the actual website WebCrypto and Desktop Node implementations. This is not live hosted acceptance.
- Root interim Desktop and website typechecks caught integration errors in preview unions and a test result type. Agents are correcting those; final project checks have not run.
- UI route and presentation layer exist. Authentication, real command mapping, and local fixture visual review are still being integrated.

## Integration review follow-ups

- Backend owner reports 32 files / 354 tests and typecheck passing after queue limits, operation-aware entitlement checks, terminal/preview operations, and large encrypted payload coverage.
- Desktop executor owner reports 33 focused executor/session tests passing. File reads, history, and diffs now account for serialized result limits; large results fail explicitly.
- Cross-component acceptance covers real SQLite, temporary Git repositories, the grant pump, the executor, and browser/Desktop crypto. The hosted RPC and provider process remain fixtures. Latest owner run: 8 tests pass, including lost completion acknowledgement with no command redelivery, exact ciphertext/fence retry, and one execution only.
- Root's Node typecheck still found acceptance-test cross-project import/type errors and a grant-service constant import error. Assigned to the owners; do not count the project typecheck as passing yet.
- Root's website typecheck caught an in-progress syntax error in pending-command persistence. Final checks wait for transport integration.
- Durable command result publication now needs an outbox, not resealing and waiting for the backend to redeliver a claimed command. Review also requires a failed/expired result not to starve new commands.
- Browser recovery must retain the same command ID and ciphertext. Lock/account changes must invalidate in-flight responses, not merely clear the visible state.
- Root captured the presentation fixture at desktop and 390px mobile in `.impeccable/review/workspace-*-initial.png`. This is shell evidence, not signed-in end-to-end evidence. Timestamp hydration, mobile approval navigation, and the actual account-layout wrapper need correction before the final visual check.
- Preview is a bounded screenshot of an approved repository's already-running Desktop dev server. Interactive browser preview is not implemented. Terminal access is explicit Desktop-user shell access, not an operating-system filesystem sandbox.

## Remaining handoff gates

- Obtain explicit authorization before deploying the new relay to hosted staging. Then use Anth's offered sign-in and explicit Desktop approval for real browser-to-Desktop acceptance.
- No production rollout or cloud-independent browser execution is included in this change.

## Continuation checkpoint — 2026-09-22 (Devin)

All four outstanding handoff items are now implemented; nothing is committed or deployed.

- **Terminal/preview through the real runtime.** `browser-workspace-executor.service.ts` dispatches `terminal.*` and `preview.screenshot` through a shared `BrowserWorkspaceTools` instance after scope/expiry/grant/workspace/repo binding checks. `browser-workspace-tools.service.ts` exposes `getSharedBrowserWorkspaceTools()`/`revokeSharedBrowserWorkspaceGrant()`/`disposeSharedBrowserWorkspaceTools()`; grant revocation, denial, expiry, and remote terminal-state transitions in `dashboard-grant.service.ts` close that grant's PTYs. Executor disposal is wired into `resetSyncRuntimeForTests()` and `app.quit` in `src/main/index.ts`.
- **Preview hardening.** The hidden capture window denies all permission/check/device/display-media requests, rejects auth dialogs, fails closed on certificate verification (`-2`), strips cookie/authorization/proxy-authorization headers, fails closed on unsafe main-frame navigation and redirects, tolerates blocked optional subresources, runs load+`capturePage` under one deadline, and destroys the window in `finally`.
- **Post-revocation result policy (strict).** `account-coordinator.ts` no longer serves result ciphertext for any grant that is not `approved`: `dashboardCommandStatus` omits `result`, `handleDashboardRevoke` purges stored results immediately, and `expireDashboardRequests` removes results for terminal/non-approved requests. Command state stays honest (`completed`) and `result_sha` remains so Desktop's durable outbox can retry completion idempotently. The browser maps completed-without-result to uncertain/unknown outcome. Backend test covers: readable before revoke → suppressed after → idempotent re-complete still works.
- **Browser UI wiring.** `workspace-client.tsx` now runs the real command loops: `terminal.create`/`terminal.write` on command submit (creating/reusing the repo's scoped terminal), `terminal.read` polling at 1.5s with `afterSequence` cursoring while a live terminal exists, `terminal.close` on repository switch, and `preview.screenshot` on start/refresh with `available`/`unavailable` mapping. The pending gate renders the `SHA-256(browserPub|challenge)` verification code (`AB12-CD34-EF56`) derived by `dashboardVerificationCode()` in `lib/mesh-crypto.ts`, matching `sync-runtime.service.ts`, so the user can confirm it against the Desktop approval panel.

Checks after this session's edits: `tsc -b` (app node+web) pass; focused Vitest `browser-workspace-tools`/`browser-workspace-executor` 30/30 pass; backend typecheck pass; backend `browser-workspace.test.ts` 4/4 pass; website typecheck/lint/build pass (one pre-existing `no-img-element` warning for the runtime PNG preview); `git diff --check` clean.

Still outstanding: deploy the new relay to authorized staging (`anvil-sync-hosted-staging`), verify the descriptor advertises `workos-device`, then run the real sign-in + Desktop approval acceptance — including revocation-closes-terminals and no-replay-after-reconnect checks.

## Independent integration reviewer checkpoint

These are review findings from the current dirty worktree, not all independently reproduced by root. Recheck after agent edits before fixing.

- **P0: approved grant revalidation is contract-broken.** `sync-runtime.service.ts` calls `dashboard.requests({requestId})`, but `account-coordinator.ts` dispatch ignores params and its handler returns pending rows only. Claimed commands cannot pass the subsequent live-grant check. Add an issuer-bound exact request lookup with live state, `decidedBy`, `workspaceBindings`, and `grantedScopes`; add an actual runtime/backend contract regression.
- **P1: executor failures may be marked completed.** Grant dispatch stores executor `{ok:false,error}` as completed, and publication derives relay outcome from the receipt state. Browser may catch the nested failure, but the relay outcome is wrong. Persist/publish failed results as failed.
- **P1: rejected commands become uncertain.** Pre-execution checks publish `rejected`, but the runtime ignores that status. Claims expire into unknown-outcome instead of a deterministic encrypted denial. Complete known denials where the grant/key and backend policy allow it.
- **P1: ready browser grants need revocation/expiry observation.** The transport's status polling was pending-only in the reviewed snapshot. Ready grants must stop exposing usable state on revocation/expiry, with stale async work invalidated. Recheck the transport owner's final edit.
- **Policy decision: completed result ciphertext remains retrievable after revoke.** Hosted command status does not recheck the revoked grant for completed results. The approved plan says revocation stops further access; enforce that for result retrieval or explicitly reconcile the narrower policy before shipping.
- Reviewer found file-write expected revisions, history shapes, and command/result AAD domain separation consistent in the inspected snapshot. This does not substitute for full signed-in acceptance.

Resume verification update: `anvil-app` Node TypeScript check passes after changing cross-project crypto acceptance imports to runtime-only absolute URL imports. Browser crypto + pump/executor acceptance passes 8/8. Backend browser-workspace tests pass 7/7 and backend typecheck passes. Desktop grant + pump tests pass 11/11 after failed-outcome and deterministic-denial fixes. Website typecheck and `git diff --check` pass. The backend owner also reports 17 taskkey/dashboard tests passing for issuer-bound request lookup.

Root also added ready-grant status polling in `anvil-website/lib/browser-workspace.ts`: approved sessions recheck every 15 seconds, while pending sessions retain the 5-second poll. Revocation, denial, and expiry now clear the session through the existing account-scoped cleanup path. Website typecheck passes; lint has one intentional dynamic-PNG `<img>` warning.

Website production build completed successfully after that transport change. The build-generated `next-env.d.ts` path change was restored to the development references so it does not become accidental source churn.

Full local app suite now passes: 195 files passed, 4 skipped; 1,466 tests passed, 11 skipped. Full backend suite passes: 32 files, 355 tests. App Node typecheck, website typecheck, focused browser acceptance, backend typecheck, website build, website lint, and `git diff --check` are green. Website lint retains one `no-img-element` warning for the runtime Desktop PNG preview.

Resume update: the acceptance tests now load the website crypto implementation through an absolute runtime-only URL, keeping it out of the app TypeScript root while still exercising the real implementation. `anvil-app` Node typecheck passes, website typecheck passes, the two cross-component acceptance files pass 8/8, and `git diff --check` passes. The P0/P1 contract fixes below are still pending owner reports.

## Grant checkpoint — Desktop scoped grants and relay pump

- [x] Added explicit local workspace/repository approval state and action scopes; no workspace/repository is auto-selected, and action checkboxes start clear.
- [x] Extended sealed grant inner data with `workspace { workspaceId, repoIds }` and `enrollmentId`; legacy grants remain readable but fail closed for workspace execution.
- [x] Added independent 1.5s Desktop command pump, real `dashboard.command.claim` / `dashboard.command.complete` runtime wiring, DSK AES-GCM command/result AAD, grant/enrollment/workspace/scope revalidation, and main-process-only key handling.
- [x] Added durable encrypted receipt/result outbox with claim fences and exact sealed-envelope retry; completed execution is not replayed after a lost completion acknowledgement, while interrupted execution becomes unknown.
- [x] Added schema migration 95 and focused lost-ack/real-executor acceptance coverage; focused checks: 4 files / 70 tests and acceptance 5 tests pass; renderer typecheck and targeted lint pass; Impeccable detector reports no findings.
- [x] Relay status/revalidation extension finalized: issuer-bound `dashboard.requests({ requestId })` returns the live request state, `decidedBy`, `workspaceBindings`, and `grantedScopes`; pending-list behavior remains bounded and separate. Backend browser-workspace tests/typecheck pass after this change.
- [ ] Browser UI still needs to display the matching verification code derived from `browserPub|challenge`; Desktop approval now shows this code and explicitly treats origin/user-agent as hints only.

## Tools checkpoint (2026-09-22)

- `src/main/services/browser-workspace-tools.service.ts` and its focused test remain the owned Desktop tools files; `terminal.service.ts` has the narrow scoped-session/environment changes.
- Previously verified baseline: 16 focused Vitest tests pass across browser tools and terminal service; focused ESLint and Prettier pass. Node typecheck has unrelated cross-project acceptance-test/website alias diagnostics and is not a project-wide pass.
- Concrete preview currently discovers only a running approved repo terminal target, uses a fresh hidden sandboxed/context-isolated partition, strips auth/cookie headers, uses direct proxy mode, blocks non-loopback origins, and caps load/PNG output. No tunnel or interactive HTML proxy exists.
- In-flight edit adds `BrowserWorkspaceTerminalReadResult` with `truncated`/`droppedBeforeSequence` and a serialized-read budget that accounts for JSON metadata/escaping. This edit was not rechecked after the checkpoint.
- Remaining hardening requested by root and not yet applied: deny Electron permission/check/display-media requests, reject auth dialogs and certificate verification, include capturePage in the preview deadline, and allow optional blocked subresources without failing an otherwise valid main-frame screenshot while still failing closed on main navigation/redirect.

## browser_workspace_ui checkpoint — 2026-09-22

Status: bounded UI integration is saved in the shared worktree. The account workspace page now owns its page-level `loadAccountContext` guard and passes `ctx.user.id` into `BrowserWorkspaceClient`; the client uses the existing encrypted browser transport hook and maps repository/thread/history/approval/file/CAS/git/workflow data. Workflow rerun/cancel uses the current command contract with the granted repository allowlist. Drafts remain account/workspace scoped in local storage.

Presentation: `WorkspaceShell` is a full-width Desktop-backed surface with conversation, compact repository/session navigation, files/editor, changes/diffs, runs, terminal and PNG-preview slots, contextual approvals/connection state, mobile view tabs, and keyboard-visible controls. Timestamps use deterministic UTC formatting for hydration. “Approval needed” jumps to the contextual approval section. `/account/workspace` now keeps the global header but removes the account sidebar/footer; the workspace header links back to Account.

Temporary review: `anvil-website/app/docs/workspace-review-local/page.tsx` is a development-only, public-fixture route for visual review at `/docs/workspace-review-local`. It imports no transport, disables mutations, labels “Local UI fixture,” and reports preview unavailable rather than inventing an image. Root should remove this route before the final build. The existing AuthKit sign-in tab was left untouched.

Current blockers: the access request contract currently requires exact non-empty repository IDs, so the gate asks for IDs selected in Desktop; no wildcard/discovery shortcut is used. Terminal and preview command callbacks remain intentionally absent until `browser_web_transport` / `browser_terminal_preview` expose the typed tool-result bridge. Tests have no separate browser operation yet, so the run-tests control stays disabled. Mutation errors now throw from send/create-session paths so composer drafts are preserved; broader uncertain-command recovery remains transport-owned. Root should finish the generation/polling review against the final hook contract.

Files owned by this checkpoint: `anvil-website/components/workspace/types.ts`, `workspace-shell.tsx`, `workspace-route.tsx`, `workspace-client.tsx`; `anvil-website/app/account/workspace/page.tsx`; temporary `anvil-website/app/docs/workspace-review-local/page.tsx`; `anvil-website/components/account/account-chrome.tsx`; `anvil-website/app/account/layout.tsx`; and the Workspace item in `anvil-website/lib/site.ts`.

Last local website checks before this checkpoint: `pnpm typecheck` passed; `pnpm lint` had no errors and one existing `@next/next/no-img-element` warning for dynamic Desktop PNG data. No deployment, commit, hosted sign-in, or production write was performed.

## Browser transport checkpoint — 2026-09-22

Status: website transport/actions are implemented in `anvil-website/lib/browser-workspace.ts`, `lib/browser-workspace-auth.ts`, `lib/mesh-crypto.ts`, `app/account/workspace/actions.ts`, and the hosted client/type mirrors. Commands use the shared browser-workspace/1 operation list (including terminal/preview), distinct command/result AAD, bounded 384 KiB envelopes and 256 KiB decrypted results, stable IDs, opaque hosted forwarding, and no blind mutation retry. Pending command metadata plus the exact encrypted envelope is persisted before submit; reconnect polls the same command ID without resubmitting. Command results returned from the hook intentionally expose only public metadata, not DSK/account/backend internals. IndexedDB wrapping keys use a conditional single readwrite transaction and are stored as `{id,key}` records.

Checks: website `pnpm typecheck`, `pnpm lint` (one existing dynamic PNG `<img>` warning), and `pnpm build` passed. Desktop/website crypto interoperability test `src/main/services/__tests__/browser-workspace-crypto.acceptance.test.ts` passed 3 tests directly. The broader Desktop test command remains noisy/failed on unrelated schema-version and executor-constant work in the shared dirty tree.

Known handoff blockers: the current workspace access UI sends a workspace ID but no repository IDs, while Desktop approval requires a non-empty repository-scoped binding; the UI owner must add repository selection/input before end-to-end approval can succeed. Ready grants currently do not continuously poll hosted status, so revocation/expiry observation after approval remains to be wired; execute-time backend rejection still fails closed. Browser/Desktop verification-code display derived from `browserPub|challenge` remains a cross-owner integration item. No deploy, commit, hosted sign-in, or production write was performed.
