# PATCH.md

`PATCH.md` is the authoritative intent guide for deliberate, owned deltas in
this repository. It encodes what each owned change is supposed to do in plain
English, not just what the diff happens to look like, so that a human or agent
can re-apply, repair, or reconcile the change after upstream or cross-project
development moves underneath it.

Treat this file as a current-state guide, not a release log.

## How to use this file

- Review the relevant entry before merging, rebasing, or reworking code that
  touches an owned area.
- Update the entry in the same change whenever owned behavior changes. If code
  and this file drift, fix the drift before merging.
- Classify incoming changes against an entry as one of:
  - `adopt`: the change is compatible with the entry; take it as-is.
  - `adapt`: the change conflicts mechanically; re-apply the entry's required
    behavior on top of it.
  - `reject`: the change breaks the entry's intent; do not take it without
    deliberately revising this file first.
- If a merge is unresolvable, rebuild the feature from the entry's intent and
  required behavior rather than from the broken diff, then verify with the
  entry's verification commands.

## Precedence

- An explicit user or maintainer request wins over this file.
- Project-level `AGENTS.md` contracts win over routine defaults.
- This file defines the expected behavior for the entries below; when other
  code differs from an entry, preserve the entry until the project
  intentionally changes direction.

## Entries

### C1: Effect for Mezair Cloud orchestration internals

Status: active
Owner project: `mezair-cloud`

#### Intent

Use [Effect](https://effect.website) for retries, timeouts, typed failures,
and multi-step async control flow inside Mezair Cloud platform orchestration,
without changing any external contract. Cell authors, CLI users, and adapter
consumers must never need to know Effect exists.

#### Owner modules

- `mezair-cloud/packages/runtime/src/workflow.ts` — workflow step executor
  (attempts, retry schedule, step timeouts).
- `mezair-cloud/packages/runtime/src/agent.ts` — guarded agent runtime
  (`AgentRuntime.invoke`, `AgentRuntime.executeTool`).
- `mezair-cloud/packages/aws/src/aws-provisioner.ts` — AWS preview provisioner
  and destroyer (artifact uploads, stack apply/poll, destroy/poll).
- `mezair-cloud/packages/aws/src/remote.ts` — AWS remote reader (deployment
  metadata, logs).
- `mezair-cloud/packages/cli/src/index.ts` — preview deploy command flow.
- Docs: `mezair-cloud/docs/architecture/deployment-adapters.md` (Effect usage)
  and `mezair-cloud/docs/architecture/workflows.md`.

#### Required behavior

1. Public APIs stay Promise-based. Every Effect surface runs its program at
   the boundary with `Effect.runPromiseExit` and rethrows both typed failures
   and defects as their original error values via `Cause.squash`. Callers must
   keep receiving the same error instances as before Effect adoption:
   `RuntimeError`, `AwsPreviewProvisioningError`, `AwsPreviewDestroyError`,
   `AwsRemoteReaderError`.
2. Error channels are typed with the surface's failure class. No `unknown`
   error channels and no identity catch functions. Errors that are not the
   expected failure class are defects (`Effect.die`), which the boundary
   runner still rethrows unchanged.
3. Polling and retry use `Schedule`, not hand-rolled loops:
   - CloudFormation create/update and delete polling use a spaced schedule
     bounded by `stackMaxPollAttempts` (total describe-call budget unchanged
     from the pre-Effect loops) with `stackPollDelayMs` spacing, then fail
     with `AWS_STACK_TIMEOUT` / `AWS_DESTROY_TIMEOUT`.
   - Workflow step retries use `Schedule.recurs(retries)` plus the configured
     retry delay. A resumed step keeps counting attempts up but always gets a
     fresh budget of one initial attempt plus `retries` repeats. Persistence
     failures inside an attempt count against that step's retry budget and
     surface as step failures, not run-loop crashes.
4. Workflow step timeouts use `Effect.timeoutFail` and produce the same
   `RuntimeError` (`INTERNAL_ERROR`, step name, `timeoutMs` details) as the
   old `Promise.race` implementation.
5. Workflow progress summaries are derived from persisted run state, not stored
   as a second source of truth. A persisted `running` run with no active local
   executor is reported as `resumable`; an active local executor is reported as
   `in-flight`. Completed steps remain the replay boundary.
6. Fan-out work uses `Effect.all` with bounded concurrency (client asset
   uploads currently use `concurrency: 8`), never `"unbounded"` for inputs the
   platform does not bound.
7. Effect stays out of the Cell authoring surface. Cell code, the app DSL,
   manifests, and adapter contracts remain ordinary async TypeScript. The
   `effect` dependency belongs to `@mezair-cloud/runtime`, `@mezair-cloud/aws`,
   and `@mezairstack/cloud-cli` only.

#### Verification

Run from `mezair-cloud/`:

```sh
pnpm --filter @mezair-cloud/runtime --filter @mezair-cloud/aws --filter @mezairstack/cloud-cli typecheck
pnpm --filter @mezair-cloud/runtime --filter @mezair-cloud/aws --filter @mezairstack/cloud-cli test
```

Behavior that must hold after any reconciliation:

- Missing provider invocation rejects with `RuntimeError` code
  `ADAPTER_ERROR` (see `packages/runtime/test/agent.test.ts`).
- Undeclared tool capability rejects with a `RuntimeError` instance, not a
  wrapped `FiberFailure`.
- Stack polling failure and timeout produce `AWS_STACK_FAILED` /
  `AWS_STACK_TIMEOUT` with the same details shape as before (stack name,
  status, events or attempts/delay).
- Workflow retries exhaust to a failed step run with attempts equal to
  `1 + retries`.

#### Upstream break risks

- New orchestration code added with ad-hoc `setTimeout` retry loops or
  `Promise.race` timeouts should be classified `adapt`: port it to the
  boundary contract above.
- Changes that put `effect` imports into Cell-facing packages or examples
  should be classified `reject`.
- An `effect` major version bump is `adapt`: re-verify `Effect.runPromiseExit`
  boundary behavior and `Schedule` semantics before merging.

### C2: Provider-neutral agent execution control plane

Status: active
Owner project: `mezair-cloud`

#### Intent

Turn Agent Sandbox lifecycle primitives into resumable, inspectable executions
without exposing provider APIs, local OAuth files, raw credentials, or shared
writable workspaces to callers. Keep AWS as the only production-target adapter
during alpha; other providers must implement the same execution conformance
contract later.

#### Owner modules

- `mezair-cloud/packages/runtime/src/agent-execution.ts` — JSON-friendly source,
  policy, event, result, and provider I/O contracts.
- `mezair-cloud/packages/control-plane/src/execution*.ts` and
  `fake-execution-provider.ts` — leases, stores, authenticated HTTP boundary,
  immutable snapshot/grant storage, worker protocol, Node service adapter,
  conformance, budgets, and cleanup receipts.
- `mezair-cloud/packages/aws/src/sandbox.ts` — Lambda MicroVM lifecycle and
  read-only execution transport.
- `mezair-cloud/packages/cli/src/index.ts` — execution conformance, durable
  service, snapshot, and lifecycle client commands.
- `mezair-app/src/main/services/mezair-cloud-execution.service.ts` and the typed
  IPC/UI path — opt-in Desktop execution connection and read-only launch flow.
- Docs: `mezair-cloud/docs/architecture/agent-execution-control-plane.md`,
  `mezair-cloud/docs/architecture/agents.md`, and the Mezair Website Cloud mirror.

#### Required behavior

1. `clientToken` makes execution creation idempotent.
2. Provider events are de-duplicated and receive durable, monotonically
   increasing control-plane cursors. File-backed lease and event mutations are
   serialized within the service process, and malformed persisted collections
   fail closed instead of being treated as valid state.
3. Closing and reconnecting a client cannot duplicate events after its last
   cursor.
4. Git sources are credential-free HTTPS URLs pinned to hexadecimal commits;
   snapshot sources use opaque ids and SHA-256 digests. Source selection records
   the exclusion of `.git`, ignored files, secrets, and unrelated untracked
   files.
5. Model authentication is either control-plane-brokered by credential name or
   an execution-scoped `codex` / `cursor` provider-subscription login. The
   latter stores only provider and `sandbox-session` persistence intent in the
   lease. Local OAuth caches, access tokens, API keys, and credential values
   have no protocol field and must not be copied into snapshots, leases,
   events, results, or artifacts. A provider must reject subscription auth
   unless its worker explicitly advertises that provider.
6. Network policy matches the compiled agent manifest. Read-write execution
   requires the agent filesystem capability. AWS remains read-only and rejects
   working-tree patches in this implementation.
7. TTL, provider-event, and estimated-cost ceilings fail the lease and request
   sandbox cleanup.
8. Collection and cancellation emit cleanup receipts. Teardown is `verified`
   only after provider inspection reports a terminal sandbox.
9. The fake provider conformance loop must pause for approval, resume the same
   run from a cursor, return a patch, and prove teardown.
10. The AWS execution transport uses short-lived MicroVM auth tokens for each
    request and does not persist them.
11. Hosted HTTP handlers fail closed without authentication and call workspace
    authorisation for every user operation. Source-grant downloads use a
    separate execution-bound bearer and bypass user authentication only for
    that exact one-time route. Runnable Node services reject invalid user
    bearer headers before buffering large snapshot request bodies.
12. Snapshot bytes are content-addressed, size-bounded, and served through
    short-lived single-use grants whose raw token is returned once and only a
    SHA-256 verifier is persisted. The worker verifies declared byte counts and
    SHA-256 digests before preparing the workspace. Snapshot and worker grants
    with invalid expiry timestamps fail closed.
13. Desktop keeps the Mezair Cloud bearer encrypted in the Electron main
    process. The renderer sees only endpoint and configured state. Desktop
    uploads a committed Git archive with `.git`, ignored/untracked files,
    working-tree changes, and known secret-file paths excluded; remote launch
    remains read-only and behind the existing Cloud feature flag.
14. The control plane exposes registered execution providers and their
    capability/configuration descriptors without starting a sandbox. A provider
    can be registered but not configured, and clients must show its reason and
    still perform the request-level support check before launch.

#### Verification

Run from `mezair-cloud/`:

```sh
pnpm --filter @mezair-cloud/runtime --filter @mezair-cloud/control-plane --filter @mezair-cloud/aws --filter @mezairstack/cloud-cli typecheck
pnpm --filter @mezair-cloud/control-plane test
pnpm --filter @mezair-cloud/aws test -- agent.test.ts
pnpm --filter @mezairstack/cloud-cli test -- cli.test.ts
mezair-cloud executions conformance --json
cd ../mezair-app && pnpm exec tsc --noEmit -p tsconfig.node.json && pnpm exec tsc --noEmit -p tsconfig.web.json && pnpm lint && pnpm test
```

#### Upstream break risks

- A provider-specific field in the Runtime execution request is `reject`.
- Persisting pre-signed source URLs, auth tokens, credential values, or local
  agent OAuth state is `reject`.
- Treating a worker image as subscription-capable without an explicit
  capability advertisement is `reject`.
- Treating a provider descriptor as proof that a particular execution request
  is supported is `reject`; callers must still use the provider's support
  result when selecting a target.
- Making the hosted handler authentication-optional or returning the encrypted
  Desktop bearer to the renderer is `reject`.
- Replacing cursor reads with an unresumable stream is `adapt`: preserve the
  durable cursor as the recovery boundary even if live delivery uses SSE or
  WebSocket.
- Treating a terminate request as verified cleanup without provider inspection
  is `reject`.
- Enabling AWS writes before patch signing, result review, approval gates, and
  cleanup evidence are implemented is `adapt` or `reject` depending on whether
  it can be restored behind read-only policy.

### C3: Portable application data and background work

Status: active
Owner project: `mezair-cloud`

Keep conditional commits, bounded table pages and the job outbox provider-neutral.
Local, in-memory, DynamoDB and D1 hosts share all-or-nothing compare-and-replace
semantics. Reject stale conditions with `CONFLICT` and retain the original state.
Keep the 25-write, 256-KiB record and 1-MiB total portable limits. JSON local
writes serialize within one process and use atomic file replacement.

Pending jobs can be committed with application records. Scheduled Cell jobs call
`ctx.dispatchPendingJobs` without accessing a provider host. Publication uses bounded
passes, conditional leases, stable logical ids and retained failures. Preserve
those ids through AWS and Cloudflare queue delivery so applications can deduplicate
with transaction receipts. Delivery remains at least once. Do not claim atomicity
for HTTP calls, file storage or queue publication itself.

Cloudflare D1, private R2, queue/Cron and OIDC support are experimental runtime
implementations. Artifacts can refer to existing stage-specific resources and
emit a D1 migration. Keep the normal Cell deployment gate until provisioning and
live lifecycle evidence exist. Require the same release evidence on AWS and
Cloudflare. Do not add consumer-specific matching, source formats or business rules.

Owner modules are `packages/runtime/src/database-{commit,page}.ts`,
`packages/runtime/src/job-outbox.ts`, the local/AWS hosts, the AWS queue bridge,
and `packages/cloudflare/src/{database,files,host,http,resources,artifacts}.ts`.
The behavior and open release checks are in
`mezair-cloud/docs/architecture/application-backends.md`.

Verify from `mezair-cloud/` with `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
`pnpm verify:cloudflare-preview`. Real local D1/R2 tests and AWS SDK tests are
required; neither substitutes for live provider evidence.

### C4: Reviewed Desktop delivery and read-only Mesh candidates

Status: active
Owner project: `mezair-app`

Turn-level delivery captures an immutable main-process review of the current
changes in explicitly selected files. Provider edit events identify the files;
they do not establish the files' final contents. Display the exact candidate
before confirmation and reject stale branch, HEAD, index, file, origin or PR
base state. Preserve unrelated staged and working changes. Create commits with
normal Git hooks and signing in an isolated checkout, then verify the reviewed
tree, parent and message before updating the source branch. PRs use a dedicated
branch whose complete diff against its pinned remote base has been reviewed.
Failed external delivery retains a recoverable local or pushed branch.

Mesh branch combination, verification and application are independent facts.
Empty checks mean verification did not run. Persist reviewed commands and their
tested commit/tree, cap execution by the originating run and current policy,
and invalidate evidence if the checkout changes. Retrying verification never
replays branch combination. Applying a verified repository is an explicit
fast-forward from its recorded base in a clean checkout, with a separate
receipt for each repository. Never force, discard local changes or push as
part of application. Hold real Git index and ref/HEAD locks, persist application
intent before changing the checkout, and reconcile an exact clean destination
match after restart. Retain ambiguous outcomes for inspection.

Current-tracked source candidates are a bounded read-only Mesh feature. Capture
selected tracked text files before approval, preserve source Git state, reject
secret paths and secrets in both removed and added patch content, and freeze
the base, candidate commit/tree, included paths and digest. Carry candidate
bytes only in task-key-sealed inputs. Never publish them in a public manifest,
status result or synced workflow template. Enforce the 128-KiB aggregate
candidate payload, file/count limits and full sealed request limits. Require
backend `mesh-job-capability-requirements/1` and worker
`remote-review-candidate/v1`; an older backend or worker must fail closed.
Freeze every selected repository's base and the approved backend/account scope
before approval. Recheck that identity and backend support before submission
or replay, retaining the original sealed request bytes.
Materialize and validate the candidate in an isolated worker checkout before
provider execution. Read-only review must not report the input candidate as
worker-produced changes. Untracked files, binary patches and write-capable
candidate tasks remain unsupported. Workflow edges continue to carry reports,
not predecessor working directories.

This entry concerns Desktop Mesh. Do not weaken C2's separate Cloud execution
source, authentication or read-only boundaries.

Owner modules: `scoped-git.service.ts`, `remote-review-candidate.service.ts`,
`chat-delegation.service.ts`, `workflow.service.ts`, `mesh-dispatch.service.ts`,
`mesh-integration.service.ts`, `mesh-worker.service.ts`, their shared contracts
and typed IPC/UI paths, and backend worker placement/claim capability checks.

Verify Desktop Node/web TypeScript checks, lint, service/real-Git tests and the
full Desktop suite; run backend tests and typecheck for capability changes.
Native UI and physical-device acceptance remain separate evidence.

### C5: Explicit conversational validation

Status: active
Owner project: `mezair-app`

Validation is introduced only by a user request or an explicit workflow step.
Resolve acceptance criteria from the linked work item or the original request
and clarifications. Plans and per-criterion evidence render as a native inline
surface; there is no separate Changes navigation or scenario form. Explicit
review and validation chat actions submit their scoped prompt once the target
conversation is ready, queueing behind an active run when the provider supports
it. They keep the thread's existing permissions.

Keep source snapshots, criteria versions and execution provenance explicit.
Only the verification executor records command outcomes. Browser, manual and
inspection observations are labelled agent-reported and do not constitute human
acceptance. Changing source or criteria invalidates evidence. Workflow checks
must use the retained execution checkout, not another copy of the repository.
Revisions clear prior outcomes; interrupted or unobserved checks cannot pass.
Preserve existing review records, screenshots and decisions through chat and
work-item history. Save reusable workflow instructions without copying evidence.

Owner modules: `validation.service.ts`, the validation surface triple and its
registry entries, work-item launch/history, legacy review route handling,
workflow validation tools and the shared question lifecycle. Local workflow
tool sessions allow only validation, surface reads and conversational questions,
with current role/access checks and revocation when the worker exits. Saved
validation steps cannot complete without current per-criterion evidence.
Verify Node/web typechecks, lint, service/real-Git tests, the Desktop suite and
production build. Browser replay is presentation evidence, not native acceptance.

### C6: Reviewed thread shares and explicit ticket publication

Status: active
Owner projects: `mezair-app`, `mezair-website`

Share only the exact main-process snapshot reviewed by the author. Include
visible conversation text and explicitly selected artifacts, native surfaces
and attachments; exclude system prompts, provider events and account keys.
Bound preview custody to its options, expiry and backend/account identity.
Updates are explicit, preserve the link's audience and expiry, and atomically
replace reviewed title metadata and encrypted bytes. Changed access requires
a new link. Saved credentials must be scanned in their serialized and HTML
forms; binary content is disclosed as unscanned.

Each share uses an independent browser fragment key. Guest links permit
possession-based reads. Organisation links additionally require a verified
website identity and current membership for every metadata and byte read,
without requiring a paid reader seat. Fail closed when the backend/viewer
cannot enforce the requested audience. Keep keys out of OAuth URLs, server
requests, analytics, logs and SQLite. Revocation and expiry block future reads;
they cannot recall bytes already downloaded. Account changes invalidate
preview publication and transport operations.

Attaching a link to a ticket is a separate explicit action after reviewing the
connection, target and comment. Keep the complete fragment in the provider's
link. Pin connection identity across asynchronous lookups, recheck share
liveness immediately before posting, and retain durable publication intent.
Never automatically retry a pending or uncertain comment publication.

Owner modules: Desktop share/thread-share/share-ticket services, share IPC/UI
and persistence; Sync share contract, coordinator and hosted access checks;
website artifact viewer, signed read client and fragment sign-in restoration.
Verify desktop and backend suites, migration retention, membership denial,
revocation/expiry, frozen preview bytes, redaction and ticket retry boundaries;
also run typechecks, lint, website viewer tests and production builds. Live
identity-provider and external-ticket acceptance is separate from local mocks.

Recipients may explicitly pick up a thread by downloading a `.mezair-thread`
package from the authorised, decrypted viewer. The package contains the same
redacted structured conversation, selected context and inert snapshot; it is a
readable local copy that cannot be recalled by revocation. Keep fragment keys
out of packages and protocol links. `mezair://pick-up-thread` only opens import
review; it carries no conversation data. File association and manual import
must use the same bounded, frozen main-process validation.

Import creates a fresh private thread only after the recipient chooses their
workspace, persona and local repositories. Preserve source references and full
conversation/context as local artifacts, with bounded background supplied to
the first actual agent request. Treat imported messages and plans as quoted
background, never current approvals or proof of repository state. Do not
resume a sender's provider session, activate a goal, post to a ticket, clone a
repository or start an agent during import. The new thread starts with an
explicit on-request access override; the recipient chooses model and access
before sending. Validate filenames and references, write only app-owned files,
and roll back failed imports without removing unrelated data. Preview builds
remain isolated from OS file/protocol association registration.

### C7: Opt-in automation publication and current-head PR repair

Status: active
Owner project: `mezair-app`

Replace the blanket automation publication ban with an explicit saved
`allowRemotePublishing` choice. Existing definitions default to disabled.
Publication requires repository writes and command execution, remains under
the current provider/persona access ceiling, and covers branches, pull requests
and related review comments in the selected repositories. It does not grant
merge, force-push, branch-deletion or unrelated external-mutation authority.
Carry the instructions into persona, loop, ACP and workflow runs, including
the saved workflow kickoff used after a pause. These instructions express
authorisation for trusted CLI workers; they are not a credential-isolation
boundary or a replacement for provider permissions.
Workflow publication authority is frozen in that run's kickoff. Editing the
automation definition does not revoke a paused workflow's existing grant;
cancel the workflow or narrow its execution access to stop that work.

PR feedback may run automatically with publication enabled. Bind it to the
configured repository and PR, re-read the current provider state, and prepare
an isolated checkout at the verified head. Reject stale, unknown or changed
heads and unsupported fork targets rather than guessing their source. Treat
feedback as task input, never as additional permission. Retain committed
publication checkouts even when their working trees are clean, and suppress
head-change repairs for commits already produced by that automation. Agent
reports and local commits do not establish that publication succeeded.

Owner modules: automation services and persistence, Watchtower sources,
automation shared contracts, database migration 115 and Automations editor.
Verify migration retention, permission defaults and prerequisites, execution
context, PR identity/head races, retained worktrees and feedback suppression;
run desktop typechecks, lint and tests. Live provider publication is separate
acceptance evidence. Full factory intake, durable PR lifecycle control and
policy-based merging remain planned in `mezair-app/docs/plans/software-factories.md`.

### C8: Reviewed software factories and typed GitHub delivery

Status: implemented; automated verification passed
Owner project: `mezair-app`

A factory is a reviewed typed definition and immutable workflow revision. Saving
or drafting does not activate it. Activation grants standing authority for its
specified source, label, verification commands, publication and merge policy;
never derive those permissions from an issue, comment, model output or operator
retry. Source repository identity is immutable. Workflow revisions and expanded
grants apply to future intake; current pauses, account/source revocations and
reductions in merge authority fence active effects. Visibility changes apply to
existing history and require current membership, source permission and role on
all discovery, detail and control paths. Organisation membership alone grants no
repository access or execution identity. Backend WorkOS users, sync accounts and
designated executor enrollments are distinct identity domains.

Persist one issue lifecycle, immutable graph/source evidence, leases, command
observations and operation intent/result receipts. Typed provider writes must
reconcile uncertain outcomes using stable operation keys before retrying. Hold
and renew a fenced run lease across external effects. Guard again after awaits
and immediately before publication or merge. Bind acceptance commands and each
criterion to the exact produced commit/tree, recheck the PR source head and all
required checks/reviews before requesting a merge, and invalidate stale evidence
and head approval after changes. An asynchronous request or queue entry is not a
merge. Observe merge and execute post-merge checks before claiming completion.
Cancellation and takeover remain pending while a merge outcome is unknown;
late acknowledgements must be adopted from receipts even if the run CAS changed.
A merge that wins a cancellation race is irreversible and remains visible as a
merged outcome requiring post-merge verification. Takeover claims/stops the run
before creating a fresh private recipient chat; remote claim correlation never
reuses the executor's private thread ID or local repository IDs as authority.

The first execution slice supports GitHub and local Codex app-server workflow
nodes only. Reject unsupported provider, remote node or privileged inline
validation configurations before activation. Isolate HOME/CODEX_HOME, retain
only model authentication, disable inherited MCP tools and provider-native
subagents, clamp to the originating/current sandbox and explicitly disable tool
network access. Factory workers cannot invoke main-process validation, delivery,
factory mutation or merge tools. The controller independently seals, scans and
verifies the candidate and performs typed publication/merge. Host reads are not
fully isolated by the provider workspace sandbox; secret-scan the complete
candidate before every publication. Controller candidate sealing disables repo
hooks/signing commands; reviewed sandboxed checks supply verification instead.
Do not weaken C4's separate interactive delivery or C2's Cloud boundaries.

Each saved revision pins a copy of a saved workflow. A revision keeps the
previous pinned graph unless its template changes or the owner explicitly sets
`repinWorkflow` on preview and save; the review confirmation covers the graph
that will be pinned, so a re-pin is reviewed and activated like any other
revision and never alters runs already in progress. Remote revisions refuse to
re-pin or change the graph. `factoryWorkflowIssues` is the one isolation rule for
activation and the renderer's workflow picker. Factory worker threads are named
by `factoryWorkerThreadId`; that name is the provenance key the Workflows view
uses to label factory-started runs and send control back to the factory. The
renderer may save a pinned graph as a new workflow or relink a factory to a
matching saved workflow, but only through a new reviewed revision.

Supported limits are observed shell command count across workers and repairs,
wall-clock duration, concurrency and repair rounds. Reserve acceptance and
post-merge command capacity, meter command-start events, deduplicate observations
and terminate promptly when exhausted. This is not a hard pre-execution command
allowlist or a spend/dollar ceiling. Pin model/persona choices in the graph. The
pure state machine/store can run without Electron; the shipped runtime binding
is the existing trusted Electron automation daemon on a supported, awake host.
Activation must prepare that service successfully and keep it installed while
factory work needs it; no standalone headless server deployment is claimed.

Organisation definitions and runs use recipient-encrypted snapshots. Authorise
and CAS registry metadata separately from encrypted payload claims; only the
designated executor may claim jobs, publish runs or consume commands. Verified
owners/admins revise and activate policies through the authoritative registry.
Current policy/source gates and recipient enrollment govern history rewrap;
never reuse another member's account encryption key. Keep remote source identity
separate from recipient workspace/repository mapping and maintain idempotent,
leased control receipts on both server and executor.

Owner modules: `shared/factories.ts`, `factory-*.service.ts`, factory IPC/preload,
chat tools and renderer, schema migration116, hosted factory registry/access
routes and migration, and the narrow isolated worker/daemon integration.
Verification passed: desktop suite (348 files, 3,177 tests; 4 files and 12 tests
skipped), full Node/web TypeScript checks, lint, production build, hosted backend
suite (43 files, 483 tests) and backend typecheck. `git diff --check` is clean.
No live GitHub write, production migration or deployment was performed or tested.
The workflow re-pin and renderer change re-ran the desktop suite (362 files,
3,335 tests; 4 files and 12 tests skipped), both TypeScript checks, lint and the
production build. Its layouts were checked against the synthetic `?factories`
replay fixture only, not a live factory.

### C9: GitHub Work Item connection identity

GitHub Work Items bind credentials to the selected named connection, independently
of GitHub Code credentials. Preserve encrypted storage and masked settings reads;
never fall back to the general GitHub token. Canonical issue URLs bind host,
repository and issue number; canonical service references reject bare numbers,
mismatched sources and pull requests. Search accepts `42` or `#42` within the
selected connection and resolves them to canonical references. Scope cached
results to connection/source and credential identity.
Explicit review/share publication revalidates its target, retains the existing
pre-publication connection guard and does not retry ambiguous writes. This
connector does not expand C8's factory intake or organisation source permissions.

Owner modules: `github-workitems.service.ts`, Work Item provider/context/settings,
review publication, shared Work Item references, Settings/Work Items UI and schema
migration117, which additively permits GitHub share receipts and preserves old rows.
Verification passed: desktop suite (354 files, 3,203 tests; 4 files and 12 tests
skipped), Node/web TypeScript checks, lint, production build and `git diff --check`.
No live GitHub write, commit or deployment was performed.

### C10: LAN first Mesh route selection and session migration

Status: implemented locally; automated verification passed; physical-device acceptance and deployment pending
Owner project: `mezair-app`

Prefer validated host LAN-address candidates, other private routes, explicit HTTPS
and managed ingress in that order. Route hints never grant trust or weaken URL,
identity, enrollment, endpoint-generation or authorization checks. Cross-machine
clients exclude loopback. Read-only reachability probes carry no account bearer
or admission ticket, use bounded concurrency/deadlines and reserve prompt fallback
capacity. Authenticate one candidate per host at a time with fresh session keys;
close late and abandoned results. No new transport protocol or subnet scanning.

Desktop/daemon and native mobile own stable consumers across active, preparing
and draining connections. Only hosts advertising `machine.stream-handoff/1` can
upgrade proactively. The authenticated subscription completion watermark follows
ordered replay; live events cannot precede subscription. Bound candidate buffers,
recheck current scope/generation/health/demand and stream coverage at promotion,
and deliver each accepted event once. Keep already-sent requests on their original
connection until completion or deadline. Route changes never resend mutations;
uncertain results remain uncertain for operation-specific receipt reconciliation.
Sign-out, account replacement and revocation fence delayed callbacks, pending
responses and advertisements before they can reach a new scope. Final subscriber
release cancels proactive work without interrupting a pending mutation.

Session ownership spans private and managed ingress listeners. Retiring a stale
socket must not erase its replacement's keys; retire abandoned bootstrap records
and authenticated sessions promptly without raising the 64-session cap. Keep
command receipts separate from transient session state. Preserve backend admission
and the existing continuing authorization deadlines; LAN routing is not offline
Mesh and does not grant worker execution.

Monitor local interfaces only while hosting or serving demand. Changed endpoints
publish the latest scoped revision; unchanged samples do not write to the backend.
Account route-change hints contain enrollment IDs only and require the explicit
`machine.routes-changed/1` socket feature opt-in, since old parsers reject unknown
frames. Periodic active-client discovery covers missed hints. Repeated failures
respect dwell/backoff, and background mobile clients cancel network preparation.
`MEZAIR_MESH_ROUTE_UPGRADES=false` disables desktop/daemon upgrades;
`EXPO_PUBLIC_MEZAIR_MESH_ROUTE_UPGRADES=false` does so for a native mobile build.
Neither switch disables ordinary reconnect or changes authorization.

Selected-path UI is sanitized. `Direct` with host LAN-address detail is a preference
hint, not proof of physical LAN routing. iOS uses the maintained local-network
purpose/ATS settings. Android permits private-IP HTTP/WS through maintained Expo
configuration; application URL restrictions, HTTPS broker credentials and encrypted
machine sessions remain mandatory. Generated config and loopback wire tests do
not establish physical permission, LAN latency or native release acceptance.

Owner modules: shared machine route contracts/policy/scheduler, hosted discovery
and account socket hints, Mesh client/runtime/session services, network monitor
and advertisement integration, mobile account/session/network adapters and the
existing connection status surfaces. Verification and outstanding physical cases
are recorded in `mezair-app/docs/plans/sync-mesh/lan-first-connectivity.md`.

### C11: Mezair identity and coordinated namespace cutover

Status: implemented in source; external provisioning and migration pending
Owner projects: Desktop, Cloud, Registry, website

Use Mezair consistently in source identifiers, package names, CLI commands,
protocols, environment variables, paths, documentation and the shared horse-M
artwork. The SVG in `branding/mezair-mark.svg` owns the mark geometry. Keep light
and dark presentation, reduced motion and accessible live text intact.

This is a coordinated breaking identity cutover. Renamed AAD/HKDF/proof contexts,
stored ownership values and message/file namespaces are not a data migration.
Do not weaken validation or silently adopt ciphertext, credentials or databases
from another identity. Startup selects only the Mezair profile and its
`mezair.db`; retained profile directories are never copied and alternate
database filenames are never selected implicitly. Existing Mezair profiles and
explicit development/preview profile selection remain supported. Retain original
profile data. Any future migration needs explicit key custody, export/import
validation and recovery evidence.

Keep the four workspaces independent. Desktop uses the built local CLI package
surfaces; `.github/scripts/prepare-desktop-clis.mjs` prepares them before a
Desktop install. The new domain, repository, package scopes, images, hosted
resources and signing identities require operator-controlled provisioning.
`docs/mezair-identity-cutover.md` records those prerequisites and acceptance
limits. Preserve every C1–C10 authentication, custody and evidence boundary.
