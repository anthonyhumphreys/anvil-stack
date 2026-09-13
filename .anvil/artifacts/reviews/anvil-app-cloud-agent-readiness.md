# Anvil App cloud-agent readiness

Date: 30 August 2026

## Verdict

`anvil-app` is ready for local demonstrations and control-plane integration testing. It is close to an internal pilot if you supply a compatible worker. It is not ready for production cloud-agent use.

The desktop client is further along than the overall system. The main blockers now sit in the hosted execution infrastructure and in connecting remote executions to Anvil's shared agent-run workflow.

## What works

- Complete typed path across renderer, preload, IPC, service, and Cloud HTTP API.
- Encrypted bearer-token storage. The renderer never receives the token.
- HTTPS enforcement, with plain HTTP restricted to loopback development.
- Immutable snapshots built from committed Git contents.
- Read-only filesystem, Git, and network policy in the generated agent manifest.
- Execution listing, launch, cursor-based event polling, approval decisions, steering, result collection, and termination.
- Codex subscription, Cursor subscription, and control-plane credential intents.
- AWS Lambda MicroVM provider selection.
- Feature gating keeps the unfinished Cloud workbench opt-in.

The core launch behavior is in [anvil-cloud-execution.service.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/anvil-cloud-execution.service.ts:113). The operator controls and evidence stream are in [RemoteExecutionsPanel.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/cloud/RemoteExecutionsPanel.tsx:23).

## What blocks production

1. No deployable hosted worker path is complete.

   The Cloud specification explicitly says the worker image, Codex and Cursor login runners, production persistence, credential brokering, Lens topology, and live remote verification remain unfinished. See [alpha-implementation-spec.md](/Users/anthonyhumphreys/Code/anvil/anvil-cloud/docs/specs/alpha-implementation-spec.md:28).

2. Remote executions are isolated from Anvil's agent-run system.

   Cloud runs live in the Cloud panel and remote control plane. They are not durable local `agent_runs`, cannot become evidence packs, and are not connected to work items, automations, branches, or PR handoff. The existing plan still describes the shared run model and Cloud handoff as missing work in [agent-run-system.md](/Users/anthonyhumphreys/Code/anvil/anvil-app/docs/plans/agent-run-system.md:39) and [agent-run-system.md](/Users/anthonyhumphreys/Code/anvil/anvil-app/docs/plans/agent-run-system.md:271).

3. "Secret-filtered snapshot" is too strong a claim.

   `git archive` excludes common secret filenames, but any committed secret under another filename is uploaded. There is no content scan or user-visible archive manifest before upload. See [anvil-cloud-execution.service.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/main/services/anvil-cloud-execution.service.ts:340).

4. The UI exposes only part of the control-plane contract.

   Approval, steering, collection, and termination exist. Suspend, resume, waiting-for-input responses, artifact browsing, detailed evidence, and patches are absent. Completed results display only the summary even though the type contains changed files, evidence, and errors. See [types.ts](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/shared/types.ts:2189) and [RemoteExecutionsPanel.tsx](/Users/anthonyhumphreys/Code/anvil/anvil-app/src/renderer/components/cloud/RemoteExecutionsPanel.tsx:545).

5. HTTP responses are trusted through type assertions.

   Execution leases and event batches receive only shallow checks. Contract drift could reach the renderer as malformed state.

6. Uploads need hardening.

   A repository archive can reach 192 MiB before base64 expansion and is sent as one JSON request. There is no chunking, resumable upload, progress reporting, or cancellation.

7. Authentication is suitable for an internal service, not a hosted product.

   The app uses one static bearer token and a hard-coded approval actor. There is no user identity, token refresh, workspace-scoped authorization UX, or role display.

## Verification

Current automated checks are healthy:

- `anvil-app`: 99 test files and 536 tests passed.
- Cloud control plane: 2 files and 28 tests passed.
- AWS adapter: 12 files and 95 tests passed.

These are unit and contract tests. They do not prove a live desktop to hosted control plane to AWS worker to subscription-authenticated agent run.

## Recommended delivery order

1. Ship and smoke-test one compatible read-only worker image with one authentication mode.
2. Add durable hosted persistence and a real credential-broker path.
3. Run a live end-to-end test from Desktop through result collection and verified cleanup.
4. Persist Cloud executions as shared Anvil agent runs, including evidence and review handoff.
5. Add snapshot inspection or scanning, chunked uploads, and cancellation.
6. Finish input, suspend/resume, artifact, evidence, and failure UX.
7. Add runtime response validation and focused renderer tests.

In short, the cockpit exists and the controls are wired. The aircraft still needs its production engine.