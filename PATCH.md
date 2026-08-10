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

### C1: Effect for Anvil Cloud orchestration internals

Status: active
Owner project: `anvil-cloud`

#### Intent

Use [Effect](https://effect.website) for retries, timeouts, typed failures,
and multi-step async control flow inside Anvil Cloud platform orchestration,
without changing any external contract. Cell authors, CLI users, and adapter
consumers must never need to know Effect exists.

#### Owner modules

- `anvil-cloud/packages/runtime/src/workflow.ts` — workflow step executor
  (attempts, retry schedule, step timeouts).
- `anvil-cloud/packages/runtime/src/agent.ts` — guarded agent runtime
  (`AgentRuntime.invoke`, `AgentRuntime.executeTool`).
- `anvil-cloud/packages/aws/src/aws-provisioner.ts` — AWS preview provisioner
  and destroyer (artifact uploads, stack apply/poll, destroy/poll).
- `anvil-cloud/packages/aws/src/remote.ts` — AWS remote reader (deployment
  metadata, logs).
- `anvil-cloud/packages/cli/src/index.ts` — preview deploy command flow.
- Docs: `anvil-cloud/docs/architecture/deployment-adapters.md` (Effect usage)
  and `anvil-cloud/docs/architecture/workflows.md`.

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
   `effect` dependency belongs to `@anvil-cloud/runtime`, `@anvil-cloud/aws`,
   and `@anvilstack/cloud-cli` only.

#### Verification

Run from `anvil-cloud/`:

```sh
pnpm --filter @anvil-cloud/runtime --filter @anvil-cloud/aws --filter @anvilstack/cloud-cli typecheck
pnpm --filter @anvil-cloud/runtime --filter @anvil-cloud/aws --filter @anvilstack/cloud-cli test
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
Owner project: `anvil-cloud`

#### Intent

Turn Agent Sandbox lifecycle primitives into resumable, inspectable executions
without exposing provider APIs, local OAuth files, raw credentials, or shared
writable workspaces to callers. Keep AWS as the only production-target adapter
during alpha; other providers must implement the same execution conformance
contract later.

#### Owner modules

- `anvil-cloud/packages/runtime/src/agent-execution.ts` — JSON-friendly source,
  policy, event, result, and provider I/O contracts.
- `anvil-cloud/packages/control-plane/src/execution*.ts` and
  `fake-execution-provider.ts` — leases, stores, authenticated HTTP boundary,
  immutable snapshot/grant storage, worker protocol, Node service adapter,
  conformance, budgets, and cleanup receipts.
- `anvil-cloud/packages/aws/src/sandbox.ts` — Lambda MicroVM lifecycle and
  read-only execution transport.
- `anvil-cloud/packages/cli/src/index.ts` — execution conformance, durable
  service, snapshot, and lifecycle client commands.
- `anvil-app/src/main/services/anvil-cloud-execution.service.ts` and the typed
  IPC/UI path — opt-in Desktop execution connection and read-only launch flow.
- Docs: `anvil-cloud/docs/architecture/agent-execution-control-plane.md`,
  `anvil-cloud/docs/architecture/agents.md`, and the Anvil Website Cloud mirror.

#### Required behavior

1. `clientToken` makes execution creation idempotent.
2. Provider events are de-duplicated and receive durable, monotonically
   increasing control-plane cursors.
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
    SHA-256 digests before preparing the workspace.
13. Desktop keeps the Anvil Cloud bearer encrypted in the Electron main
    process. The renderer sees only endpoint and configured state. Desktop
    uploads a committed Git archive with `.git`, ignored/untracked files,
    working-tree changes, and known secret-file paths excluded; remote launch
    remains read-only and behind the existing Cloud feature flag.

#### Verification

Run from `anvil-cloud/`:

```sh
pnpm --filter @anvil-cloud/runtime --filter @anvil-cloud/control-plane --filter @anvil-cloud/aws --filter @anvilstack/cloud-cli typecheck
pnpm --filter @anvil-cloud/control-plane test
pnpm --filter @anvil-cloud/aws test -- agent.test.ts
pnpm --filter @anvilstack/cloud-cli test -- cli.test.ts
anvil-cloud executions conformance --json
cd ../anvil-app && pnpm exec tsc --noEmit && pnpm lint && pnpm test
```

#### Upstream break risks

- A provider-specific field in the Runtime execution request is `reject`.
- Persisting pre-signed source URLs, auth tokens, credential values, or local
  agent OAuth state is `reject`.
- Treating a worker image as subscription-capable without an explicit
  capability advertisement is `reject`.
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
