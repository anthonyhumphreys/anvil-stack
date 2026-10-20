# Market readiness progress

## Current status

2026-09-22: this implementation and local verification pass is complete. Hosted deployment and real-provider launch gates remain open. Working tree was clean at the start. No commit, release, deployment, or paid resource creation has been performed.

## Final verification summary

| Check | Final result |
| --- | --- |
| Desktop full suite | 1,426 passed, 11 skipped, 190 passing files |
| Real local-worker acceptance | Two-profile 8/8 plus device-security 1/1 passed in a separate run |
| Desktop TypeScript | Actual node and web project checks passed |
| Desktop lint | Passed with no warnings |
| Desktop build | `pnpm build` including native rebuild passed; final renderer bundle rebuilt after visual corrections |
| Backend | 347 tests, typecheck, 11/11 fixture conformance passed |
| Real HTTP conformance | 11/11 passed against isolated local Worker |
| Cloud execution | Control-plane 30, AWS 7, CLI 71 tests passed; changed-package typechecks passed; 6/6 execution conformance |
| Website | Typecheck, lint, build, and public route smoke checks passed |
| Visual/function checks | Public web desktop/mobile/light/dark; native first-run setup, Sync/Mesh activation, Settings; flattened cloud panel and onboarding scrolling confirmed |
| Not verified live | Hosted identity/billing/D1, authenticated dashboard, physical devices, actual cloud-provider jobs and teardown |

The default Desktop suite still skips the two environment-dependent worker files and two unrelated delivery/runner integration files. The worker files were explicitly enabled and passed in the separate real-HTTP run above.

## Work log

- Read root and all relevant project instructions, `PATCH.md`, product and design context, and the Impeccable and Unslop skills.
- Located Desktop sync/mesh settings, first-run onboarding, backend services and tests, website dashboard, and cloud execution contracts.
- Assigned four independent workstreams. Implementation uses Luna at xHigh as requested.
- Created [the implementation plan](MARKET_READINESS_PLAN.md) before implementation results land.
- Initial finding: cloud execution has an implemented control-plane boundary but its architecture lists several unresolved production dependencies. Marketing must describe this as alpha until live proof exists.
- Follow-up inspection found a separate, already implemented multi-provider mesh environment path, including Vercel, AWS, Cloudflare, managed workers, and workflow placement. Added an implementation workstream for its missing Desktop setup/lifecycle UI. This corrects any implication that Anvil as a whole only has an AWS adapter.
- Found a possible immutable-source race in Desktop remote execution: `rev-parse HEAD` and `git archive HEAD` run concurrently. Assigned a fix to resolve the commit first and archive that exact commit, with regression coverage.
- Found cleanup state defects in mesh environments: a termination request is immediately stored as `terminated`, AWS `TERMINATING` and Vercel `stopping` are classified as terminal, and cleanup sweeps skip terminal rows. Assigned truthful state/verification fixes to the environment workstream.
- First remote-execution implementation landed with immutable commit archives, authenticated redirect rejection, malformed-response rejection, repository/workspace filtering, and clearer run controls. Integration review requested stale-request guards and more precise connection/auth wording before acceptance.
- First website implementation passed build/typecheck/lint and added dashboard refresh, job filtering, recovery, and attention states. Root opened a native Chrome guest session and inspected the rendered homepage. Requested one revision batch to remove the remaining internal architecture-heavy sales copy and shorten the page around product outcomes and actual screenshots.
- First onboarding review caught a fresh-setup blocker in the new implementation: pinning creates a paused backend, while sign-in UI initially required an active backend. Requested reuse of the existing setup path and complete enrollment-code support.
- Backend review fixed a managed-environment concurrency race by repeating cap enforcement inside the job insertion transaction. The regression test starts overlapping creates and requires exactly one accepted request at a one-worker cap.
- Backend review also found a BYO worker bootstrap URL mismatch and repeated managed-request enrollment-code creation. Both remain assigned for implementation; they are not being deferred as review-only findings.
- Website revision removed the generic principles section and long repository ownership table, shortened documentation links, added a concrete repo-to-handoff flow beside the real Desktop screenshot, and corrected the two cloud execution stories.
- Cloud execution now exposes authenticated provider capability/configuration discovery through `GET /v1/execution-providers` and `anvil-cloud executions providers --json`. Configuration status is explicitly not a live-provider probe. `PATCH.md` and architecture docs were updated.
- Bounded cloud-environment review found cross-scope environment ID overwrite risk, connection deletion without service-level cleanup protection, and overly permissive provider configuration fields. Assigned narrow service fixes and regression tests. The renderer's disabled button is not the authorization boundary.

## Findings to resolve

| Finding | Evidence | Disposition |
| --- | --- | --- |
| Setup complexity | `anvil-app/src/renderer/components/settings/SyncMeshSettingsPanel.tsx` combines connection, trust, sync, mesh, grants, and portability | Shared setup/onboarding implemented and checked natively; advanced controls grouped |
| Two cloud paths need distinct UX and claims | Mesh `cloud-environment.service.ts` versus `PATCH.md` C2 execution service | Mesh provider UI/workflow choices and C2 provider discovery implemented; lifecycle regression checks passed; live-provider proof remains open |
| Production dependencies remain | Same architecture document, remaining production work | Keep explicit launch gates; source changes cannot prove deployment |

## Verification

- Hosted configuration check: `node scripts/verify-hosted-config.mjs` from `anvil-app/cloud/backend` failed with one issue. `HOSTED_DB.database_id` remains `<placeholder-not-created>` in `wrangler.hosted.jsonc`. Provisioning/deployment is outside this local implementation task.
- An initial invocation from `anvil-app` failed because the script lives in `cloud/backend`; reran from the correct directory as recorded above.
- Desktop remote execution agent reports 7/7 focused service tests passing, plus TypeScript, scoped ESLint, Prettier and diff checks. Additional integration-review changes are pending.
- Website agent reports `pnpm typecheck`, `pnpm lint`, and `pnpm build` passing. Homepage and Sync route HTTP smoke checks passed. A final content revision is pending.
- Root visually inspected the homepage at `http://localhost:3000` in a Chrome guest window. Authenticated dashboard and responsive verification remain pending.
- Sync backend agent reports typecheck, the full backend suite with 345 tests across 30 files, and 11/11 fixture conformance checks passing after the concurrency fix. Follow-up fixes still need verification.
- Cloud execution agent reports 30 control-plane tests, 7 AWS agent tests, 71 CLI tests, changed-package typechecks, scoped lint and diff checks passing. `pnpm anvil-cloud executions conformance --json` passed 6/6 checks.
- Final website revision passed typecheck, lint, build, and route smoke checks. Root inspected the homepage at desktop width, homepage and Sync page at 390px, and light/dark presentation. No layout blocker or runtime error remained in that pass. Development console showed non-blocking image preload and smooth-scroll warnings. Authenticated dashboard controls remain unverified against a real account.
- Root `pnpm test` in `anvil-app` passed 1,417 tests across 190 files; 11 tests in four files were skipped.
- Root `pnpm lint` completed with no errors and two warnings in in-progress UI edits. Final lint pending after those edits.
- Verification correction: app `tsconfig.json` contains `files: []` and project references, so `pnpm exec tsc --noEmit` does not check the app. Actual `-p tsconfig.node.json` and `-p tsconfig.web.json` checks exposed one new remote-lease validation error, in-progress setup extraction errors, and existing provisioner/workflow typing errors. Assigned all relevant fixes; do not count the earlier root-only invocation as type safety evidence.
- Started an isolated local Worker at `http://127.0.0.1:8799` with `wrangler dev --env dev --local`, using `/tmp/anvil-readiness-worker.qKAAm1` for disposable local state. No production bindings or deployment.
- Real local-worker wire conformance passed 11/11, including enroll, revoke, refresh, replication, portability, and account deletion against fixture accounts.
- Real device-security integration passed 1/1. Real two-profile acceptance failed 6/8 tests: replication convergence, restore, artifact retrieval, two workspace-preparation cases, and handoff authorization. Assigned a separate Luna xHigh agent to distinguish stale trust fixtures from product defects and fix without weakening security. These failures are unresolved launch evidence, not covered by the green unit suite.
- Two-profile acceptance diagnosis: the fixture was redeeming `issueEnrollmentCode().code`, which authenticates but does not carry the one-time E2E key secret; it also handed off before the new target's first authenticated RPC provisioned its backend enrollment. The acceptance fixture now publishes and redeems `pairingPayload`, asserts that it exists, and awaits target bootstrap before handoff. The real worker currently rejects the published `keyring-pairing` payload as `envelope-invalid` in generic `sync.push` validation; backend validation must exempt crypto-boundary entity types while retaining their own payload validation before this gate can pass.
- Actual app node and web TypeScript projects now pass after fixing provisioner source inclusion/test fixture typing, automation trigger fallback, workflow attempt initialization, and changed-file errors. Targeted provisioner/workflow/automation tests passed 33/33.
- Desktop remote-run follow-up passed 8/8 service tests. It now suppresses stale scoped responses, separates saved connection state from successful reachability, and uses provider discovery to disable unsupported execution/auth combinations before launch.
- Cloud-environment service follow-up passed 25/25 focused tests, both app TypeScript projects, and scoped lint. Cross-account environment ID collisions fail before provider calls; provider connections cannot be deleted before cleanup; provider config and secrets have explicit allowlists, with legacy secret-shaped fields removed from renderer summaries.
- Root reran actual app node/web TypeScript checks and `pnpm lint`: all passed with no lint warnings. `pnpm exec electron-vite build` passed; existing dynamic/static import warnings remain. Native Electron rebuild is intentionally deferred until Node-based acceptance tests finish.
- Final dashboard code review caught a nonfunctional Retry path outside the unlocked state and attention filters using incorrect job-state names. Assigned a bounded functional correction using the real job contract, without another visual redesign.
- Dashboard correction is complete. Retry now handles locked, pending, and unlocked states; attention uses the real job states; a successful no-change refresh clears stale network errors. Website typecheck, lint, and build passed again. No website unit-test harness exists, and authenticated visual acceptance still requires a real account.
- Root's second full app test run passed 1,424 tests across 190 files, with 11 tests skipped across four files. Later backend/acceptance changes still require final focused checks.
- Backend final checks passed 347 tests across 30 files, typecheck, and 11/11 fixture conformance. Managed retries use additive source-scoped `job.list({ requestId })`, bounded old-backend fallback, and same-process single-flight protection. Cloud-environment service tests passed 26/26.
- Crypto-boundary payloads now receive their own structural validation instead of being misclassified as domain envelopes. Valid/invalid pairing regressions pass. Root repeated real HTTP conformance successfully, 11/11.
- The second real-worker acceptance run passed handoff and device-security, but still failed five cases involving replication, restore, artifacts, and workspace preparation. Acceptance investigation continues; the unit and conformance results do not supersede this gate.
- Native QA used `/tmp/anvil-readiness-desktop.ynXySj`, a disposable Desktop profile, and an isolated local-worker account. Backend discovery, identity review/pinning, enrollment, adoption review, Sync activation, live status, explicit Mesh opt-in, and onboarding completion worked. No real repositories, provider credentials, or paid resources were used.
- Native QA found clipped expanded onboarding and viewport-based two-column rules inside a narrow onboarding card. The overlay now scrolls from the top; compact cloud setup stays single-column. Removed a duplicate Settings heading and corrected active Sync copy.
- Anth flagged nested cloud cards in the running build. Flattened form/connections/list surfaces into one outer panel with dividers, removed the false-success empty-state checkmark, and shortened protocol-heavy copy. Root confirmed the flattened result in native Desktop after rebuilding and reloading.
- `pnpm build` completed successfully, including the Electron native rebuild. After initial UI QA, native modules were rebuilt for Node so acceptance tests could resume. The prebuilt SQLite download process was killed; its supported source-build fallback completed successfully.
- The third real-worker run passed 8/9 tests. Replication, full restore, workspace preparation, approval denial, handoff, and device security now pass. Artifact retrieval remains under investigation. In-progress sync-engine/runtime fixes also had two TypeScript errors assigned to their owner.
- Final acceptance is green. The fixture now waits for encrypted pairing readiness before dispatching artifact-producing work. Production fixes persist paused-enrollment pairing in the existing encrypted store, preserve delayed encrypted records without false conflicts, validate schemas on retry, and retry after scan activation. Runtime tests passed 39/39; engine/keyring tests passed 61/61. The two TypeScript errors and temporary debug logs were removed.
- Root independently reran the final combined code: 1,426 Desktop tests passed; actual node/web TypeScript and lint passed; all nine real-worker acceptance/security tests passed. `git diff --check` is clean.
- Final native confirmation found the flattened cloud section readable and onboarding content reachable from its header to Continue when expanded. No further visual revision was made.

## Local review environment

- The isolated Desktop window and local Worker remain available for Anth's review, alongside the website preview. They contain only generated QA data.
- Desktop profile: `/tmp/anvil-readiness-desktop.ynXySj`; local backend state: `/tmp/anvil-readiness-worker.qKAAm1`; backend listens only on `127.0.0.1:8799`; website preview uses `localhost:3000`.
- Native modules are currently built for Node after testing. `pnpm dev` or `pnpm build` performs the normal Electron rebuild before a new Desktop launch.

## Remaining launch evidence

- Real multi-device sync and mesh acceptance run.
- Hosted identity, billing, entitlement, recovery, and revocation checks.
- Cloud worker image, credentials or subscription login, real-provider execution and teardown.
- Durable hosted persistence and concurrency evidence.
- Provider-specific conformance for any newly advertised Vercel or Cloudflare executor.
- Authenticated dashboard grant expiry, revocation, freshness, and action controls against a configured account. Native Desktop and public website visual inspection are complete.
