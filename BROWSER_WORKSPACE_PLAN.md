# Desktop-backed browser workspace

Approved direction: a primary browser workspace, with Desktop execution first and independent cloud execution later. Implementation agents use Luna at xHigh. Existing market-readiness changes remain intact.

## Experience

Extend the established Anvil website design: compact workspace navigation, a central conversation or file editor, and contextual changes/results. Use divided regions rather than nested cards. Keep the active repository, executing Desktop, connection freshness, and outstanding approvals visible. On narrow screens, switch between views rather than squeezing three columns together.

The browser and Desktop share persisted sessions, repositories, runs, and changes. Closing a tab does not cancel execution. Disconnected controls explain what cannot run; drafts survive navigation and reload. Never silently switch to paid cloud execution.

## Implementation sequence

1. Map existing session, repository, execution, grant, and hosted relay APIs. Define one typed, encrypted command/result contract before parallel implementation.
2. Add grant-bound browser authorization: explicit Desktop and repository scope, individual action permissions, expiry and revocation, possession checks, bounded payloads, and no browser access to device/account keys.
3. Implement a durable encrypted relay and Desktop dispatcher. Commands have stable IDs, finite expiry, recoverable results, and explicit uncertain outcomes; never automatically replay a potentially executed mutation.
4. Build the workspace: select an authorized repository, list/resume/create sessions, send messages, follow execution, cancel, and resolve supported approvals. Preserve browser drafts and recover after reconnect.
5. Add repository browsing, guarded file edits, diff review, tests/command results, workflow controls, and Git handoff using existing Desktop services and permission checks.
6. Add explicitly scoped terminal interaction and authenticated development previews where the transport can safely support them. No arbitrary unauthenticated machine proxy.
7. Verify contract, authorization, replay/expiry/revocation, paths/revisions, session continuity, and failure states. Run relevant project checks and a bounded desktop/mobile visual review; fix findings and document actual limits.

## First end-to-end acceptance

Authorize one repository from Desktop; start work in the browser; inspect changes; run tests on Desktop; close and reopen the tab; continue the same persisted session. Also verify unauthorized repositories/actions, Desktop offline, expired grants, duplicate delivery, and stale edits are rejected or explained correctly.

## Authorization and recovery decisions

- Website sign-in identifies the account. It does not authorize Desktop actions or decrypt their contents.
- Desktop chooses the workspace and repository allowlist when approving a browser. The browser need not know local repository IDs before approval.
- Read, file-write, agent-task, approval, terminal, and preview permissions are separate. Existing dashboard-only grants cannot execute workspace commands.
- The approving Desktop alone claims commands. It authenticates encrypted command content using its grant key and checks the operation, repository, workspace, and deadline again before execution.
- Commands and results use different authenticated-data domains. Routing metadata is authenticated with the ciphertext; payloads remain encrypted through the website and relay.
- Retries retain the original command ID and ciphertext. An abandoned execution claim becomes an uncertain outcome, never an automatic repeat of a shell command or file write.
- Browser keys persist through tab closure in a deliberately scoped browser store. A browser that cannot retain keys must say so. Revocation, expiry, locking, and sign-out clear local access state.
- Repository authorization controls which project APIs the browser may call. A shell's starting directory is not an operating-system sandbox. Shell permissions must say this explicitly and remain opt-in.
- Browser revocation stops further access and command admission. Work already started belongs to Desktop and must have an explicit cancellation path; closing a tab is not cancellation.

## Boundaries

- No deployment, production configuration, provider spend, or commits without separate authorization.
- No new cloud-independent execution in this phase.
- No security/maturity claims beyond verified behavior. Any unavailable transport or live-account prerequisite remains a named verification gate, not a simulated success.
- Preserve existing uncommitted work; each implementation agent owns a bounded file area.

## Tracking

Live findings, ownership, checks, and remaining work are recorded separately in `BROWSER_WORKSPACE_PROGRESS.md`.
