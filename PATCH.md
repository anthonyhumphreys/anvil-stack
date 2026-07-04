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
5. Fan-out work uses `Effect.all` with bounded concurrency (client asset
   uploads currently use `concurrency: 8`), never `"unbounded"` for inputs the
   platform does not bound.
6. Effect stays out of the Cell authoring surface. Cell code, the app DSL,
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
