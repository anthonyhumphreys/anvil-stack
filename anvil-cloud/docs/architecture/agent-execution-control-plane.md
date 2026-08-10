# Agent execution control plane

## Purpose

The agent execution control plane turns an Agent Sandbox lifecycle into a
resumable, inspectable unit of work. It is provider-neutral: Desktop, CLI, and
hosted callers create one execution request, while an execution provider owns
the sandbox and its private transport.

This is platform infrastructure, not a Cell authoring primitive. Cell authors
continue to declare agents, capabilities, approvals, and sandbox requirements
through `defineAgent`.

## Implemented boundary

`@anvil-cloud/runtime` owns the JSON-friendly execution contract:

- immutable git or opaque snapshot source references;
- read-only and read-write modes;
- provider preferences and capability-derived network policy;
- TTL, event, and estimated-cost ceilings;
- control-plane model credential names, never credential values;
- cursor-based lifecycle, message, tool, command, file, approval, input,
  artifact, patch, usage, heartbeat, expiry, and cleanup events;
- evidence, test, patch, artifact, usage, and error results;
- the `AgentExecutionProvider` lifecycle and I/O interface.

`@anvil-cloud/control-plane` implements:

- idempotent leases keyed by `clientToken`;
- exact event sequencing and provider-event de-duplication;
- resumable reads from a durable cursor;
- approval decisions, structured input, steering, suspend, resume, collect,
  terminate, and TTL reaping;
- event and estimated-cost budget enforcement;
- in-memory and atomic JSON-file stores;
- cleanup receipts that distinguish requested from verified teardown;
- a framework-neutral `/v1/executions` HTTP router and matching client;
- a deterministic fake provider and conformance suite.

Run the conformance loop with:

```sh
anvil-cloud executions conformance --json
```

The check starts a deterministic writable execution, pauses for approval,
resumes from an event cursor, returns a patch, and verifies sandbox teardown.

## Request shape

```ts
const request: AgentExecutionRequest = {
  schemaVersion: "0.1",
  clientToken: "desktop-thread-42-turn-8",
  cell: "repository-review",
  environment: "preview",
  task: "Inspect the repository and report failing tests.",
  agent: reviewerManifest,
  source: {
    kind: "git",
    repository: "https://github.com/example/repository.git",
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    selection: {
      includesWorkingTreePatch: false,
      excluded: [
        "git-metadata",
        "ignored-files",
        "secret-files",
        "unrelated-untracked-files",
      ],
    },
  },
  providerPreference: { kind: "provider", provider: "aws-lambda-microvm" },
  policy: {
    mode: "read-only",
    ttlSeconds: 3600,
    network: reviewerManifest.capabilities.network,
    maxEvents: 10000,
    maxCostUsd: 2,
    requireApprovalForExternalActions: true,
  },
  modelAuth: {
    kind: "control-plane",
    credential: "MODEL_API_KEY",
  },
};
```

Git source URLs must be credential-free HTTPS URLs pinned to a hexadecimal
commit. Snapshot sources use opaque ids and SHA-256 digests; the public lease
does not persist pre-signed download URLs. Every source records the excluded
content classes so ignored files, secret files, `.git` internals, and unrelated
untracked files cannot disappear behind an ambiguous "upload workspace" flag.

## HTTP contract

The framework-neutral handler and client use these routes:

```txt
POST /v1/executions
GET  /v1/executions
GET  /v1/executions/:id
GET  /v1/executions/:id/events?cursor=<cursor>&limit=<n>
POST /v1/executions/:id/approval
POST /v1/executions/:id/input
POST /v1/executions/:id/steer
POST /v1/executions/:id/suspend
POST /v1/executions/:id/resume
POST /v1/executions/:id/collect
POST /v1/executions/:id/terminate
POST /v1/executions/reap
```

The router is deliberately authentication-agnostic. A hosted service must
authenticate the user and authorise the workspace before invoking it. It must
not expose this router directly as an unauthenticated public endpoint.

## AWS read-only transport

`AwsLambdaMicroVmSandboxProvider` now implements the execution-provider
contract for read-only requests. After the existing Lambda MicroVM lifecycle
starts a session, it uses a short-lived MicroVM auth token for every request to
the sandbox worker:

```txt
POST /_anvil/execution/workspace
POST /_anvil/execution/runs
GET  /_anvil/execution/runs/:runId/events
POST /_anvil/execution/runs/:runId/approvals/:requestId
POST /_anvil/execution/runs/:runId/input/:requestId
POST /_anvil/execution/runs/:runId/steer
GET  /_anvil/execution/runs/:runId/result
```

The startup payload advertises protocol `0.1`, resumable events, and
control-plane-brokered model authentication. Auth tokens are used only for the
request and are not written into execution leases or events.

This is an executable adapter boundary with mocked transport coverage, not a
claim that the hosted service and worker image are deployed. A compatible
MicroVM image must implement the endpoints above. The hosted control plane must
also provide source snapshot retrieval and model/credential brokering before a
real repository inspection can be called production-ready.

## Security invariants

- Local execution remains the default outside this package.
- `modelAuth.kind` can only be `control-plane`; local Codex OAuth state has no
  representation in the protocol.
- The execution network policy must match the compiled agent manifest.
- Read-write mode requires the agent's `filesystem: "read-write"` capability.
- AWS rejects read-write requests and working-tree patches in the current
  slice.
- Provider fallback happens only while selecting a provider, before a sandbox
  starts.
- TTL, event count, and estimated-cost ceilings fail the lease and request
  sandbox cleanup.
- Results reference artifacts by id and digest rather than embedding arbitrary
  files in control-plane JSON.
- Collection and cancellation produce a cleanup receipt; only an inspected
  terminal sandbox is marked `verified`.

## Remaining production work

- authenticated hosted route wiring and workspace authorisation;
- snapshot upload/download storage with one-time sandbox access;
- a compatible AWS worker image and real-account smoke test;
- model and provider credential brokering at the network boundary;
- durable hosted storage with concurrency control rather than the alpha JSON
  file store;
- artifact upload, signed patch bundles, and local disposable-worktree review;
- Desktop execution target UI and Work topology event projection;
- writable AWS execution after patch signing, external-action approvals, and
  orphan cleanup evidence are proven;
- dynamic remote subagent tools;
- later provider adapters through the same conformance contract.
